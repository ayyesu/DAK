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
  applyCanvasSequence,
  canvasCatchUpDue,
  CANVAS_RENDER_COALESCE_MS,
  canvasRenderSettled,
  canvasRenderStarted,
  initialCanvasViewState,
  isCanvasDeleted,
  shouldRenderCanvas,
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
 * times the CPU at the ceiling than at a panel's own 512px, so asking for the panel's real size is
 * most of the saving. A coarse ladder keeps that from becoming a request per resize pixel, and the
 * panel's edge only ever grows within a mount — frames that were already large read fine when the
 * panel shrinks, so resizing never spends a render.
 */
const RENDER_EDGE_LADDER = [512, 768, 1024, 1536, MAX_EDGE_CEILING] as const;

const edgeForDisplayedWidth = (cssWidth: number, devicePixelRatio: number): number => {
  const needed = Math.ceil(cssWidth * Math.max(1, devicePixelRatio));
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
   * The edge to ask for, and it only grows. Measuring in a layout effect means the very first render
   * already knows how wide the panel is, so following the panel's size costs no extra render; later
   * growth moves the ladder at most a step or two, and each of those waits for the next sequence
   * bump rather than asking for one of its own.
   */
  const [renderEdge, setRenderEdge] = useState<number>(RENDER_EDGE_LADDER[0]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = () => {
      const next = edgeForDisplayedWidth(element.clientWidth, window.devicePixelRatio);
      setRenderEdge((current) => (next > current ? next : current));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  /**
   * The newest render asked for. A response carrying anything but this id is dropped whole, so a slow
   * render that resolves after a newer sequence arrived cannot put old frames back on screen under a
   * new sequence number.
   */
  const requestIdRef = useRef(0);
  /** The render whose answer is still awaited, which is what makes a late answer droppable. */
  const pendingRequestIdRef = useRef(0);
  const timerRef = useRef<number | null>(null);

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
                  ...(frame.role === undefined ? {} : { role: frame.role }),
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

  const body = useCanvasBody(state, canRestore, restore);

  // A collapsed panel keeps its subscription and its last frames but paints nothing, so a design the
  // user closed the panel over stops costing layout work without losing its place.
  if (!visible) return <div className="h-full min-h-0 w-full" data-canvas-panel-mode={mode} />;

  const reducedDetail = state.renderedEdge !== null && state.renderedEdge < renderEdge;

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full flex-col"
      data-canvas-panel-mode={mode}
    >
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
        </div>
      ) : null}
      {body}
    </div>
  );
});

function useCanvasBody(state: CanvasViewState, canRestore: boolean, restore: () => void) {
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
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      {state.frames.length === 0 ? (
        <p className="text-sm text-muted-foreground">This design has no frames to show yet.</p>
      ) : (
        state.frames.map((frame) => (
          <figure key={frame.nodeId} className="flex flex-col gap-1">
            <img
              src={`data:image/png;base64,${frame.data}`}
              width={frame.width}
              height={frame.height}
              alt={frame.role === undefined ? "Design frame" : `${frame.role} frame`}
              className="w-full rounded-md border border-border bg-white"
              style={{ height: "auto" }}
            />
            {frame.role === undefined ? null : (
              <figcaption className="text-xs text-muted-foreground">{frame.role}</figcaption>
            )}
          </figure>
        ))
      )}
      {state.omittedFrames > 0 ? (
        <p className="text-xs text-muted-foreground">
          {state.omittedFrames} more frames were left out of this view.
        </p>
      ) : null}
      {!state.projectionCurrent ? (
        <p className="text-xs text-muted-foreground">
          This view may be a moment behind the design.
        </p>
      ) : null}
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
