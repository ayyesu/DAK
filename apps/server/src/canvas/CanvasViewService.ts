import {
  CANVAS_RENDER_FRAME_LIMIT,
  CANVAS_RENDER_MAX_EDGE,
  CANVAS_RENDER_MIN_EDGE,
  CANVAS_RENDER_PAYLOAD_BUDGET_CHARS,
  CanvasViewError,
  type CanvasFrame,
  type CanvasModule,
  type CanvasRole,
} from "@dak/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { fitFramesToBudget, reducedRenderEdge, renderPayloadChars } from "./canvasInvariants.ts";
import type { CanvasDocument, CanvasEngine, CanvasStore } from "./CanvasPorts.ts";

/**
 * The client-side reading of a design: rendered frames plus the sequence they were rendered at.
 *
 * This is deliberately separate from `CanvasService`. That service is the agent's surface and holds
 * every rule about whether an edit may land; a viewer has none of those concerns and must not be
 * able to reach them. A view renders whatever the document currently holds — including one that is
 * mid-authoring — and reports the sequence so a live view can tell whether what it shows is stale.
 */

/** A frame that declares no size is laid out at this, rather than at nothing. */
const CANVAS_FALLBACK_DESIGN_SIZE = 1;

/** The top-level frames of a design, in document order, with the role each one carries. */
interface ViewFrame {
  readonly nodeId: string;
  readonly role: CanvasRole | undefined;
  /**
   * The frame's own name, which is what identifies it to a person.
   *
   * Optional because a frame can be authored without one; the viewer falls back to "Frame N". It is
   * read off the document rather than left to the client, because this is the only thing that says
   * what a frame *is* — `role` says only what shape it is, and every route in a design has the same.
   */
  readonly name: string | undefined;
  /**
   * The frame's own size, read off the document rather than off the raster.
   *
   * A frame taller than the render edge is delivered scaled down, so the bitmap's dimensions say
   * nothing about how big the frame is. A viewer that lays out from them resizes the design every
   * time the edge moves.
   */
  readonly designWidth: number;
  readonly designHeight: number;
}

const roleOf = (value: unknown): CanvasRole | undefined =>
  value === "route" || value === "slide" || value === "ios" || value === "android"
    ? value
    : undefined;

/** A dimension that is a real, positive number, or null when the node does not declare one. */
const sizeOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * Which frames to rasterize, and what that leaves out. The cap is on rendered frames rather than
 * frames listed, so the client learns `omittedFrames` and can say the view is partial instead of
 * implying it showed everything.
 */
export const selectViewFrames = (
  document: CanvasDocument,
  limit: number,
): { readonly frames: ReadonlyArray<ViewFrame>; readonly omitted: number } => {
  const children =
    (document as { readonly children?: ReadonlyArray<Record<string, unknown>> } | null)?.children ??
    [];
  const frames = children
    .filter((node) => typeof node.id === "string" && node.id.length > 0)
    .map((node) => {
      const designWidth = sizeOf(node.width);
      const designHeight = sizeOf(node.height);
      const name = typeof node.name === "string" ? node.name.trim() : "";
      return {
        nodeId: String(node.id),
        role: roleOf(node.role),
        // An unnamed frame carries `undefined` rather than an empty string, so the viewer falls back
        // to "Frame N". Rendering a blank caption would be worse than showing the ordinal.
        name: name.length === 0 ? undefined : name,
        // A frame without a declared size falls back to the raster, which is what the client would
        // have used anyway. Better a slightly wrong scale than a frame laid out at zero.
        designWidth: designWidth ?? CANVAS_FALLBACK_DESIGN_SIZE,
        designHeight: designHeight ?? CANVAS_FALLBACK_DESIGN_SIZE,
      };
    });
  return {
    frames: frames.slice(0, limit),
    omitted: Math.max(0, frames.length - limit),
  };
};

export interface CanvasViewServiceDeps {
  readonly store: CanvasStore;
  readonly engine: CanvasEngine;
}

/**
 * A render can fail for reasons the user can act on (the design is in the trash, the engine has no
 * runtime) and reasons they cannot. Only the former is named; anything else becomes a generic
 * message, because the engine's causes carry paths and engine internals.
 */
const viewFailure = (documentId: string, code: CanvasViewError["code"], detail: string) =>
  new CanvasViewError({ documentId: documentId as CanvasViewError["documentId"], code, detail });

export class CanvasViewService extends Context.Service<
  CanvasViewService,
  {
    /** Renders the design's frames at its authoritative sequence. */
    readonly render: (input: {
      readonly documentId: string;
      readonly maxEdge?: number | undefined;
    }) => Effect.Effect<
      {
        readonly documentId: string;
        readonly title: string;
        readonly module: CanvasModule;
        readonly sequence: number;
        readonly projectionCurrent: boolean;
        /** The edge the returned frames were actually rasterized at. */
        readonly maxEdge: number;
        readonly frames: ReadonlyArray<CanvasFrame>;
        readonly omittedFrames: number;
      },
      CanvasViewError
    >;
    /**
     * The sequence a live view should currently be showing. Cheap: it reads metadata and never
     * rasterizes, so a view can ask on open without paying for a render.
     */
    readonly currentSequence: (input: {
      readonly documentId: string;
    }) => Effect.Effect<{ readonly sequence: number; readonly trashed: boolean }, CanvasViewError>;
  }
>()("dak/canvas/CanvasViewService") {}

export const make = (deps: CanvasViewServiceDeps): CanvasViewService["Service"] => {
  const { store, engine } = deps;

  /**
   * The payload and the summary are read once and reused, so the sequence reported is the one the
   * frames were actually rendered from. Reading them separately could report a sequence the render
   * never saw, which would make a live view look current when it is not.
   */
  const readForRender = Effect.fn("canvasView.readForRender")(function* (documentId: string) {
    const { summary, payload } = yield* Effect.tryPromise({
      try: () => store.getDocumentForExecution(documentId),
      catch: () =>
        viewFailure(
          documentId,
          "document_not_found",
          "That design does not exist in this project.",
        ),
    });
    if (summary.trashed) {
      return yield* viewFailure(
        documentId,
        "document_deleted",
        "That design is in the trash. Restore it to see it again.",
      );
    }
    return { summary, payload };
  });

  const render: CanvasViewService["Service"]["render"] = (input) =>
    Effect.gen(function* () {
      const { summary, payload } = yield* readForRender(input.documentId);
      const document = yield* Effect.tryPromise({
        try: () => engine.materialize(payload),
        catch: () =>
          viewFailure(
            input.documentId,
            "storage_failed",
            "This design could not be read right now.",
          ),
      });

      const selection = selectViewFrames(document, CANVAS_RENDER_FRAME_LIMIT);
      if (selection.frames.length === 0) {
        return {
          documentId: summary.id,
          title: summary.title,
          module: summary.module,
          sequence: summary.sequence,
          projectionCurrent: summary.projectionCurrent,
          maxEdge: input.maxEdge ?? CANVAS_RENDER_MAX_EDGE,
          frames: [],
          omittedFrames: 0,
        };
      }

      const rasterize = (maxEdge: number) =>
        Effect.tryPromise({
          try: () =>
            engine.renderFrames({
              payload,
              nodeIds: selection.frames.map((frame) => frame.nodeId),
              maxEdge,
            }),
          // A raster runtime that is missing or out of memory is the user's machine, not the design,
          // so the message says what to do rather than naming an engine error.
          catch: (error) =>
            viewFailure(
              input.documentId,
              /memory/iu.test(String(error)) ? "storage_failed" : "script_memory_exceeded",
              "This design could not be rendered right now. Try again, or export it to a file.",
            ),
        });

      const requestedEdge = input.maxEdge ?? CANVAS_RENDER_MAX_EDGE;
      const maxEdge = Math.min(requestedEdge, CANVAS_RENDER_MAX_EDGE);
      let images = yield* rasterize(maxEdge);
      let renderedEdge = maxEdge;

      /*
       * The payload budget. A view is not allowed to cost the user an unbounded amount of bandwidth
       * or server CPU because a design happens to be large, and the frames it is showing are the
       * only knob that matters. One retry at a smaller edge covers the common case — a design with a
       * photographic frame — because PNG weight follows the rendered area. If that still does not
       * fit, the trailing frames go instead of shrinking the design below the point of being
       * readable, and `omittedFrames` says how many.
       */
      const firstOverflow = renderPayloadChars(images);
      const retryEdge = reducedRenderEdge({
        edge: renderedEdge,
        payloadChars: firstOverflow,
        budgetChars: CANVAS_RENDER_PAYLOAD_BUDGET_CHARS,
        minEdge: CANVAS_RENDER_MIN_EDGE,
      });
      if (retryEdge !== null) {
        images = yield* rasterize(retryEdge);
        renderedEdge = retryEdge;
      }

      const fitted = fitFramesToBudget(images, CANVAS_RENDER_PAYLOAD_BUDGET_CHARS);

      // The engine answers in request order, so a frame's own node id comes from the selection
      // rather than from the renderer, which does not echo it back.
      return {
        documentId: summary.id,
        title: summary.title,
        module: summary.module,
        sequence: summary.sequence,
        projectionCurrent: summary.projectionCurrent,
        maxEdge: renderedEdge,
        frames: fitted.frames.map((image, index): CanvasFrame => ({
          nodeId: selection.frames[index]?.nodeId ?? image.nodeIds[0] ?? "",
          ...(selection.frames[index]?.role === undefined
            ? {}
            : { role: selection.frames[index]?.role as CanvasRole }),
          ...(selection.frames[index]?.name === undefined
            ? {}
            : { name: selection.frames[index]?.name }),
          width: image.width,
          height: image.height,
          designWidth: selection.frames[index]?.designWidth ?? image.width,
          designHeight: selection.frames[index]?.designHeight ?? image.height,
          data: image.data,
          sequence: summary.sequence,
        })),
        omittedFrames: selection.omitted + fitted.omitted,
      };
    });

  const currentSequence: CanvasViewService["Service"]["currentSequence"] = (input) =>
    Effect.tryPromise({
      try: () => store.getDocument(input.documentId),
      catch: () =>
        viewFailure(input.documentId, "document_not_found", "That design no longer exists."),
    }).pipe(Effect.map((summary) => ({ sequence: summary.sequence, trashed: summary.trashed })));

  return { render, currentSequence };
};

export const layer = (deps: CanvasViewServiceDeps) => Layer.succeed(CanvasViewService, make(deps));
