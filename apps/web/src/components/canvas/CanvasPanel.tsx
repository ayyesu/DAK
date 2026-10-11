"use client";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AuthSourceControlWriteScope, type ScopedThreadRef } from "@dak/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useRightPanelStore, type CanvasSurface } from "~/rightPanelStore";
import { canvasEnvironment } from "~/state/canvas";
import { formatEnvironmentQueryError } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  applyShortcut,
  applyWheel,
  fitCamera,
  initialCanvasCamera,
  panCamera,
  shortcutForKey,
  zoomCameraCentered,
  ZOOM_PRESETS,
  type CanvasCamera,
} from "./canvasCamera";
import { readStoredZoom, writeStoredZoom } from "./canvasZoomStorage";
import {
  applyCanvasSequence,
  canvasCatchUpDue,
  CANVAS_RENDER_COALESCE_MS,
  canvasRenderSettled,
  canvasRenderStarted,
  initialCanvasViewState,
  isCanvasDeleted,
  shouldRenderCanvas,
  type CanvasRenderedFrame,
  type CanvasViewState,
} from "./canvasViewState";

/**
 * A Canvas design, as the server rendered it.
 *
 * This is a viewer. The engine runs in Node and never reaches a browser, so this shows rasterized
 * PNG frames rather than an editable document — the user reads a design here and corrects it by
 * telling the agent, which is the loop the MCP tools are built for. Anything needing a live editor
 * (direct manipulation, two clients converging, a user edit racing an agent edit) is not exercised
 * by this surface.
 *
 * It renders docked and full-width from one component, the way Preview does, because the two differ
 * only in who owns the size.
 */

/** Enough to fill a large panel on a retina display without rasterizing a poster at full size. */
const MAX_EDGE_CEILING = 2048;

/**
 * The edges a design is rasterized at, coarse on purpose.
 *
 * Measured against the real engine: a text-bearing deck costs about six times the bytes and seven
 * times the CPU at the ceiling than at a panel's own 512px, so asking for what is actually on screen
 * is most of the saving. A coarse ladder keeps that from becoming a request per pixel of zoom.
 */
const RENDER_EDGE_LADDER = [512, 768, 1024, 1536, MAX_EDGE_CEILING] as const;

/**
 * The edge a design needs at `zoom`, from how large it actually is.
 *
 * Driven by the zoom and the design's own size rather than by the panel's width. That is the whole
 * change behind "frames keep their size when the panel is resized": the panel's width is no longer an
 * input to anything, so dragging it wider reveals more of the world instead of re-scaling what is in
 * it. Asking for the panel's width is what made every frame a different size on every resize.
 */
const edgeForZoom = (designEdge: number, zoom: number, devicePixelRatio: number): number => {
  const needed = Math.ceil(designEdge * zoom * Math.max(1, devicePixelRatio));
  return RENDER_EDGE_LADDER.find((edge) => edge >= needed) ?? MAX_EDGE_CEILING;
};

interface Props {
  readonly mode: "inline" | "sheet" | "sidebar" | "embedded";
  readonly threadRef: ScopedThreadRef;
  readonly surface: CanvasSurface;
  /** False when the panel is collapsed, so a hidden view stops rendering. */
  readonly visible: boolean;
}

/**
 * The server's own words for a failed render, read off the Effect `Cause`.
 *
 * An RPC failure arrives as a `Cause`, not as the thrown value, so probing for `message` on it
 * silently finds nothing and the panel falls back to a generic string. That is worse than useless:
 * it hid a missing-font failure behind a sentence identical to the heading, so the actual cause was
 * invisible in the product. `Cause.squash` is what the rest of the app already uses for this.
 */
const canvasFailureMessage = (cause: Cause.Cause<unknown>): string =>
  formatEnvironmentQueryError(cause);

/**
 * The failure's stable code, when the server sent a structured one.
 *
 * Read through `Cause.findErrorOption` rather than by inspecting the Cause, for the same reason as
 * above. Anything unrecognised yields undefined, which the state machine treats as "not a deletion" —
 * the safe direction, since it shows an honest error instead of accusing the user of deleting a
 * design that is still on disk.
 */
const canvasFailureCode = (cause: Cause.Cause<unknown>): string | undefined => {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

export const CanvasPanel = memo(function CanvasPanel({ mode, threadRef, surface, visible }: Props) {
  const { environmentId } = threadRef;
  const { documentId, projectId } = surface;

  const [state, setState] = useState(initialCanvasViewState);
  /**
   * The same state, readable from effects and callbacks.
   *
   * The render loop has to ask "is a render due?" at the moment an edit settles, which is inside an
   * effect rather than during the update that recorded it. `setState` cannot be read back
   * synchronously, so scheduling reads this instead of threading the state through by hand. Every
   * `setState` below goes through `commit`, which keeps the two in step.
   */
  const stateRef = useRef(state);
  const commit = useCallback((next: CanvasViewState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /**
   * The camera, and the only state that decides where a design appears.
   *
   * Separate from `CanvasViewState` because that one is about whether the frames on screen are
   * current, and this one is about where they are. Keeping them apart is what stops a re-render from
   * being able to move the user's view.
   */
  /**
   * The largest edge the design has, in design units.
   *
   * The raster edge follows this times the zoom, never the panel's width — that separation is what
   * stops a resized panel from rescaling the design.
   */
  const designEdge = useMemo(
    () =>
      state.frames.reduce(
        (tallest, frame) => Math.max(tallest, frame.designHeight, frame.designWidth),
        0,
      ),
    [state.frames],
  );
  const [camera, setCamera] = useState<CanvasCamera>(initialCanvasCamera);
  const cameraRef = useRef(camera);
  /**
   * The floor the render edge only ever rises to.
   *
   * A rasterized frame stays readable when the zoom comes back down, so zooming out must not throw
   * away resolution that was already paid for. It is raised here, where a zoom actually happens,
   * rather than inside the derived edge, so the derivation stays a pure function of the camera.
   */
  const renderEdgeFloorRef = useRef<number>(RENDER_EDGE_LADDER[0]);
  const [renderEdgeFloor, setRenderEdgeFloor] = useState<number>(RENDER_EDGE_LADDER[0]);
  const moveCamera = useCallback(
    (next: CanvasCamera | ((c: CanvasCamera) => CanvasCamera)) => {
      setCamera((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        cameraRef.current = resolved;
        // Raising the floor here is what keeps the edge monotonic without a second state update.
        const needed =
          designEdge === 0
            ? RENDER_EDGE_LADDER[0]
            : edgeForZoom(designEdge, resolved.zoom, window.devicePixelRatio);
        if (needed > renderEdgeFloorRef.current) {
          renderEdgeFloorRef.current = needed;
          setRenderEdgeFloor(needed);
        }
        return resolved;
      });
    },
    [designEdge],
  );

  const viewportRef = useRef<HTMLDivElement | null>(null);
  /**
   * The newest render asked for. A response carrying anything but this id is dropped whole, so a slow
   * render that resolves after a newer sequence arrived cannot put old frames back on screen under a
   * new sequence number.
   */
  const requestIdRef = useRef(0);
  /** The render whose answer is still awaited, which is what makes a late answer droppable. */
  const pendingRequestIdRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  /**
   * The raster edge, derived from the camera rather than stored.
   *
   * A frame is drawn at its design size times the zoom, so that product is what has to be resolved.
   * The panel's width appears nowhere, which is the whole point: it cannot rescale the design.
   *
   * Purely derived. The floor that keeps it monotonic is raised in `moveCamera`, which is where a
   * zoom actually happens — deriving it here would mean calling setState from a memo, which is the
   * shape React warns about and can loop on.
   */
  const renderEdge = useMemo(() => {
    if (designEdge === 0) return renderEdgeFloor;
    return Math.max(edgeForZoom(designEdge, camera.zoom, window.devicePixelRatio), renderEdgeFloor);
  }, [designEdge, camera.zoom, renderEdgeFloor]);

  const renderAtom = useMemo(
    () =>
      canvasEnvironment.render({
        environmentId,
        input: { projectId, documentId, maxEdge: renderEdge },
      }),
    [environmentId, projectId, documentId, renderEdge],
  );
  const sequenceAtom = useMemo(
    () => canvasEnvironment.sequence({ environmentId, input: { projectId, documentId } }),
    [environmentId, projectId, documentId],
  );
  /**
   * Re-asks for the frames. A render is server CPU and its response is large, so the atom is only
   * refreshed when a sequence actually moved rather than left to a timer or a cache lifetime.
   */
  const refreshRender = useAtomRefresh(renderAtom);

  /**
   * Starts a render when one is due.
   *
   * The subscription only ever carries a sequence, so the decision to spend server CPU is the
   * client's. Bumps coalesce behind a short trailing timer, so an agent running fifty edits costs
   * one render rather than fifty.
   */
  const requestRender = useCallback(
    (force: boolean) => {
      if (!shouldRenderCanvas(stateRef.current, force ? { force: true } : {})) return;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const run = () => {
        timerRef.current = null;
        requestIdRef.current += 1;
        pendingRequestIdRef.current = requestIdRef.current;
        commit(canvasRenderStarted(stateRef.current));
        refreshRender();
      };
      if (force) run();
      else timerRef.current = window.setTimeout(run, CANVAS_RENDER_COALESCE_MS);
    },
    [commit, refreshRender],
  );

  useEffect(() => {
    requestRender(true);
  }, [requestRender]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  /**
   * The live sequence. A resubscribe reports the current sequence rather than replaying what was
   * missed, so every first subscription forces a render: across a relay or tunnel the stream may
   * have been down for several edits, and that first sequence is the only evidence of it.
   */
  const sequence = useAtomValue(sequenceAtom);
  const seenSequenceRef = useRef(false);
  useEffect(() => {
    if (!AsyncResult.isSuccess(sequence)) return;
    commit(applyCanvasSequence(stateRef.current, sequence.value));
    const resubscribed = !seenSequenceRef.current;
    seenSequenceRef.current = true;
    requestRender(resubscribed);
  }, [sequence, requestRender, commit]);

  const renderResult = useAtomValue(renderAtom);
  useEffect(() => {
    const current = stateRef.current;
    if (!current.rendering) return;
    const settled =
      renderResult._tag === "Success"
        ? canvasRenderSettled(
            current,
            {
              // The request that is awaiting an answer, not the newest one: reading the newest here
              // would label every response with it and no answer could ever be dropped.
              requestId: pendingRequestIdRef.current,
              ok: true,
              rendered: {
                frames: renderResult.value.frames.map((frame) => ({
                  nodeId: frame.nodeId,
                  ...(frame.name === undefined ? {} : { name: frame.name }),
                  designWidth: frame.designWidth,
                  designHeight: frame.designHeight,
                  width: frame.width,
                  height: frame.height,
                  data: frame.data,
                  sequence: frame.sequence,
                })),
                sequence: renderResult.value.sequence,
                title: renderResult.value.title,
                maxEdge: renderResult.value.maxEdge,
                omittedFrames: renderResult.value.omittedFrames,
                projectionCurrent: renderResult.value.projectionCurrent,
              },
            },
            requestIdRef.current,
          )
        : renderResult._tag === "Failure"
          ? canvasRenderSettled(
              current,
              {
                requestId: pendingRequestIdRef.current,
                // The last good frames stay put; the marker says why they are old rather than
                // blanking them.
                ok: false,
                // The server's own message, because it knows the difference between a design that
                // is gone and a design it could not read. Replacing it with one generic string is
                // what made a broken runtime report itself as a deleted design.
                message: canvasFailureMessage(renderResult.cause),
                code: canvasFailureCode(renderResult.cause),
              },
              requestIdRef.current,
            )
          : current;
    if (settled === current) return;
    commit(settled);
    // An edit that landed while this render was in flight was declined at the time, so this is the
    // only place a catch-up can be asked for. Without it the view holds the older frames until some
    // later sequence arrives, while the staleness marker claims an update that never happens.
    if (canvasCatchUpDue(settled)) requestRender(false);
  }, [renderResult, commit, requestRender]);

  // The tab takes its real name from the render, so a design opened by id is labelled properly.
  useEffect(() => {
    if (state.title === null) return;
    useRightPanelStore.getState().nameCanvas(threadRef, surface.id, state.title);
  }, [state.title, threadRef, surface.id]);

  const canRestore = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const runRestore = useAtomCommand(canvasEnvironment.restore);
  const restore = useCallback(() => {
    void runRestore({ environmentId, input: { projectId, documentId } });
  }, [runRestore, environmentId, projectId, documentId]);

  /**
   * Fit once, when the first frames land.
   *
   * Deliberately not re-run when the panel resizes: that is the behaviour being fixed. A resize
   * reveals more of the design; it does not decide how large the design is. Re-fitting on resize is
   * exactly what made a dragged panel edge stretch every frame.
   *
   * A zoom the user set on a previous visit wins over the fit, because returning to a design should
   * return to where they were rather than to wherever it happened to fit last time.
   */
  const fittedRef = useRef(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setViewportSize({ width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  const frames = state.frames;
  const frameBoxes = useMemo(
    () => frames.map((frame) => ({ width: frame.designWidth, height: frame.designHeight })),
    [frames],
  );

  useLayoutEffect(() => {
    if (fittedRef.current) return;
    if (frames.length === 0 || viewportSize.width === 0 || viewportSize.height === 0) return;
    fittedRef.current = true;
    const fitted = fitCamera(frameBoxes, viewportSize);
    const stored = readStoredZoom(documentId);
    moveCamera(
      stored === null ? fitted : zoomCameraCentered(fitted, stored / fitted.zoom, viewportSize),
    );
  }, [frames.length, frameBoxes, viewportSize, documentId, moveCamera]);

  /** The design area's own size, so gestures can be measured against it rather than the window. */
  const readViewportRect = useCallback(() => viewportRef.current?.getBoundingClientRect(), []);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const rect = readViewportRect();
      if (rect === undefined) return;
      // The panel owns its wheel only where it is looking at a design; elsewhere it scrolls the app.
      event.preventDefault();
      moveCamera((current) =>
        applyWheel(current, {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          cursorX: event.clientX - rect.left,
          cursorY: event.clientY - rect.top,
        }),
      );
    },
    [moveCamera, readViewportRect],
  );

  /** Space+drag pans, because a design surface has no scrollbar to grab. */
  const dragRef = useRef<{ pointerX: number; pointerY: number } | null>(null);
  // State rather than a ref: the cursor has to change while the key is held, which is a render, and a
  // ref read during render is exactly what React warns about.
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !spaceHeld) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { pointerX: event.clientX, pointerY: event.clientY };
      setDragging(true);
    },
    [spaceHeld],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const delta = { x: event.clientX - drag.pointerX, y: event.clientY - drag.pointerY };
      dragRef.current = { pointerX: event.clientX, pointerY: event.clientY };
      moveCamera((current) => panCamera(current, delta));
    },
    [moveCamera],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /**
   * Keys, scoped to the canvas being focused.
   *
   * A design view sits beside a chat composer, and `+`/`-` are ordinary characters there. These bind
   * only while the canvas has focus, so zooming can never eat a keystroke meant for the conversation.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === " ") {
        setSpaceHeld(true);
        return;
      }
      const shortcut = shortcutForKey({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      });
      if (shortcut === null) return;
      event.preventDefault();
      const viewport = { width: viewportSize.width, height: viewportSize.height };
      if (shortcut === "fit") {
        moveCamera(fitCamera(frameBoxes, viewport));
        return;
      }
      moveCamera((current) => applyShortcut(current, shortcut, viewport));
    },
    [moveCamera, viewportSize, frameBoxes],
  );

  const onKeyUp = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") setSpaceHeld(false);
  }, []);

  /** Zoom is per design, so reopening a design returns to where the user left it. */
  useEffect(() => {
    writeStoredZoom(documentId, camera.zoom);
  }, [documentId, camera.zoom]);

  const body = useCanvasBody(state, canRestore, restore, camera);

  // A collapsed panel keeps its subscription and its last frames but paints nothing, so a design the
  // user closed the panel over stops costing layout work without losing its place.
  if (!visible) return <div className="h-full min-h-0 w-full" data-canvas-panel-mode={mode} />;

  const reducedDetail = state.renderedEdge !== null && state.renderedEdge < renderEdge;

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-canvas-panel-mode={mode}>
      {state.title !== null ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <span className="truncate text-sm font-medium">{state.title}</span>
          {state.stale || state.rendering ? (
            <span className="shrink-0 text-xs text-muted-foreground">Updating…</span>
          ) : null}
          {state.error !== null ? (
            <span className="shrink-0 text-xs text-destructive">{state.error}</span>
          ) : null}
          {state.observedTrashed && !state.rendering ? (
            <span className="shrink-0 text-xs text-muted-foreground">In the trash</span>
          ) : null}
          {/* Said rather than hidden: a design shown smaller than asked is still readable, and a
              view that quietly showed less detail than it had would be lying about the design. */}
          {reducedDetail && !state.rendering ? (
            <span
              className="shrink-0 text-xs text-muted-foreground"
              title="Shown at reduced detail to keep this view light."
            >
              Reduced detail
            </span>
          ) : null}
          <CanvasZoomControl
            zoom={camera.zoom}
            onSelect={(factor) =>
              moveCamera((current) =>
                zoomCameraCentered(current, factor / current.zoom, viewportSize),
              )
            }
            onFit={() => moveCamera(fitCamera(frameBoxes, viewportSize))}
          />
        </div>
      ) : null}
      <div
        ref={viewportRef}
        // Focusable so the keyboard shortcuts have somewhere to bind. `outline-none` because the
        // ring around a whole design surface is noise; the focus is real, it is just not drawn.
        tabIndex={0}
        role="region"
        aria-label={`${state.title ?? "Design"} canvas`}
        data-canvas-viewport=""
        data-canvas-zoom={camera.zoom.toFixed(4)}
        className={`min-h-0 flex-1 overflow-hidden outline-none ${
          dragging ? "cursor-grabbing" : spaceHeld ? "cursor-grab" : ""
        }`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        {body}
      </div>
    </div>
  );
});

/**
 * The zoom control: a percentage that is also a menu.
 *
 * A readout is enough on its own — the user can see what they are at — but a dropdown is the only way
 * to get back to an exact number, which is what someone comparing against a spec needs.
 */
function CanvasZoomControl({
  zoom,
  onSelect,
  onFit,
}: {
  readonly zoom: number;
  readonly onSelect: (zoom: number) => void;
  readonly onFit: () => void;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <select
        aria-label="Zoom"
        data-canvas-zoom-select=""
        className="rounded border border-border bg-background px-1 py-0.5 text-xs"
        value={
          ZOOM_PRESETS.includes((Math.round(zoom * 100) / 100) as never) ? String(zoom) : "custom"
        }
        onChange={(event) => {
          if (event.target.value === "custom") return;
          onSelect(Number(event.target.value));
        }}
      >
        {!ZOOM_PRESETS.includes((Math.round(zoom * 100) / 100) as never) ? (
          <option value="custom">{Math.round(zoom * 100)}%</option>
        ) : null}
        {ZOOM_PRESETS.map((preset) => (
          <option key={preset} value={String(preset)}>
            {Math.round(preset * 100)}%
          </option>
        ))}
      </select>
      <button
        type="button"
        data-canvas-fit=""
        className="rounded border border-border px-1.5 py-0.5 text-xs"
        onClick={onFit}
      >
        Fit
      </button>
    </div>
  );
}

function useCanvasBody(
  state: CanvasViewState,
  canRestore: boolean,
  restore: () => void,
  camera: CanvasCamera,
) {
  if (isCanvasDeleted(state) && state.observedTrashed) {
    return (
      <CanvasNotice
        title="This design is in the trash"
        body="Trash is recoverable, so the design is still here."
        action={
          canRestore ? (
            <button
              type="button"
              className="text-sm underline underline-offset-4"
              onClick={restore}
            >
              Restore it
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">
              Ask the agent to restore it, or pair with write access.
            </span>
          )
        }
      />
    );
  }

  if (isCanvasDeleted(state)) {
    return (
      <CanvasNotice
        title="This design is no longer available"
        body="It was deleted, or its project is no longer on this environment."
      />
    );
  }

  // Anything else that failed with nothing on screen. Saying what the server said is the whole
  // point: a design that exists but could not be rasterized is a broken view, not a deleted one,
  // and calling it deleted sends the user off to delete something that is already there.
  if (state.error !== null && state.renderedSequence === null && state.frames.length === 0) {
    return (
      <CanvasNotice
        title="This design could not be shown"
        body={state.error}
        action={
          <span className="text-xs text-muted-foreground">
            The design is still saved. Retrying is safe.
          </span>
        }
      />
    );
  }

  return (
    <CanvasWorld
      frames={state.frames}
      camera={camera}
      omittedFrames={state.omittedFrames}
      projectionCurrent={state.projectionCurrent}
    />
  );
}

/**
 * The gap between frames in the world, in design units.
 */
const WORLD_GAP = 48;

/** One frame's place in the design's own coordinates. */
export interface PlacedFrame {
  readonly frame: CanvasRenderedFrame;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where each frame sits in the design's own coordinates.
 *
 * A row, each frame at its declared size, top-aligned. Every dimension here is a property of the
 * design, so the world this produces is identical no matter how wide the panel is — which is the
 * property the previous `width: 100%` layout destroyed. A row rather than a column because the
 * designs are tall and narrow: side by side, one pan moves between frames instead of one screenful.
 */
export const layoutFrames = (
  frames: ReadonlyArray<CanvasRenderedFrame>,
): {
  readonly items: ReadonlyArray<PlacedFrame>;
  readonly width: number;
  readonly height: number;
} => {
  const items: Array<PlacedFrame> = [];
  let left = 0;
  let width = 0;
  let height = 0;
  for (const frame of frames) {
    items.push({
      frame,
      // Top-aligned rather than centred: frames in a row read as one set when they share an edge,
      // and a design's frames usually start at the same y in the author's own document.
      top: 0,
      left,
      width: frame.designWidth,
      height: frame.designHeight,
    });
    left += frame.designWidth + WORLD_GAP;
    width = Math.max(width, left - WORLD_GAP);
    height = Math.max(height, frame.designHeight);
  }
  return { items, width, height };
};

/**
 * The design, drawn at its own size and moved by the camera.
 *
 * This is the fix. The frame is absolutely positioned at `designWidth x designHeight` and the world
 * carries a single transform, so the browser's own size resolution — the thing that made a frame
 * stretch to `width: 100%` and then squash again on the next resize — has nothing left to do. A
 * frame's box is now a function of the design and the zoom, and the panel's width is not one of them.
 */
export function CanvasWorld({
  frames,
  camera,
  omittedFrames,
  projectionCurrent,
}: {
  readonly frames: ReadonlyArray<CanvasRenderedFrame>;
  readonly camera: CanvasCamera;
  readonly omittedFrames: number;
  readonly projectionCurrent: boolean;
}) {
  if (frames.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">This design has no frames to show yet.</p>
    );
  }
  const layout = layoutFrames(frames);

  return (
    <div className="relative h-full w-full">
      <div
        data-canvas-world=""
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: layout.width,
          height: layout.height,
          transform: `translate3d(${camera.panX}px, ${camera.panY}px, 0) scale(${camera.zoom})`,
          transformOrigin: "0 0",
          willChange: "transform",
        }}
      >
        {layout.items.map(({ frame, top, left, width, height }, index) => {
          // "Frame N", counting from one in document order. A frame the agent never named shows this,
          // which is the honest answer: it is the Nth frame and nothing more.
          const label = frame.name ?? `Frame ${index + 1}`;
          return (
            <figure
              key={frame.nodeId}
              data-canvas-frame={frame.nodeId}
              data-canvas-frame-label={label}
              className="absolute"
              style={{ top, left, width, height }}
            >
              <img
                src={`data:image/png;base64,${frame.data}`}
                // Intrinsic size for the browser's own layout; the box above is what the user sees.
                width={frame.width}
                height={frame.height}
                alt={label}
                draggable={false}
                className="block h-full w-full rounded-md border border-border bg-white"
                style={{ height: "100%", width: "100%" }}
              />
              {/* Constant-size and inside the transform's inverse, so a label does not grow with the
                  zoom — a caption that scaled with the design would be unreadable at 800% and a smear
                  at 2%. */}
              <figcaption
                className="pointer-events-none absolute left-0 top-0 max-w-full truncate rounded-tl-md bg-black/55 px-1.5 py-0.5 text-[11px] leading-tight text-white"
                style={{
                  fontSize: `${11 / camera.zoom}px`,
                  transform: `scale(${1 / camera.zoom})`,
                  transformOrigin: "0 0",
                  maxWidth: `${width}px`,
                }}
              >
                {label}
              </figcaption>
            </figure>
          );
        })}
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-col gap-1">
        {omittedFrames > 0 ? (
          <p className="text-xs text-muted-foreground">
            {omittedFrames} more frames were left out of this view.
          </p>
        ) : null}
        {!projectionCurrent ? (
          <p className="text-xs text-muted-foreground">
            This view may be a moment behind the design.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CanvasNotice({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}
