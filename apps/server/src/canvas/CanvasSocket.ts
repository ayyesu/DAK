import {
  CANVAS_RENDER_CONCURRENCY,
  type CanvasActivityInput,
  type CanvasActivityItem,
  type CanvasListClientInput,
  type CanvasListResult,
  type CanvasRenderInput,
  type CanvasRenderResult,
  type CanvasRestoreSummary,
  type CanvasStreamItem,
  type CanvasSubscribeInput,
  CanvasViewError,
  type CanvasFailure,
  type ProjectId,
} from "@dak/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as CanvasChangeBus from "../canvas/CanvasChangeBus.ts";
import * as CanvasProjects from "../canvas/CanvasProjects.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { rpcInitialItems } from "../rpcInitialItems.ts";

/**
 * The WebSocket transport for the client design view: list a project's designs, render one's frames,
 * follow its sequence, and follow the project's activity so a design the agent starts can be opened
 * without the client naming it first.
 *
 * The engine is server-only, so nothing here draws anything — it rasterizes through the same engine
 * the agent edits with, which is what keeps a viewed design identical to an edited one.
 *
 * A `projectId` is required rather than resolved from a calling thread: the view is opened from a
 * project in the UI, and inferring one from a socket request would attribute a design to whichever
 * thread happened to be most recent.
 */

/**
 * Rasterization slots for one environment.
 *
 * A render is the most expensive thing Canvas does and CanvasKit does not parallelize it, so the
 * ceiling is here rather than left to each client to respect. Callers wait for a slot instead of
 * failing: a view that is briefly late still shows a design, while a refusal would show an error the
 * user cannot act on.
 */
export class CanvasRenderLimiter extends Context.Service<
  CanvasRenderLimiter,
  {
    readonly withPermits: (
      permits: number,
    ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("dak/canvas/CanvasSocket/CanvasRenderLimiter") {}

/**
 * `makeUnsafe` because the semaphore holds no resources: it is a count, and making it cannot fail.
 *
 * The semaphore itself is what the service closes over, rather than its `withPermits` method.
 * `withPermits` tracks the permits it takes through `this`, so the detached method reads `undefined`
 * for them and throws `this.releaseUnsafe is not a function` the moment a render asks for its slot —
 * which made `canvas.render` fail for every design while a stubbed limiter in tests kept passing.
 * Calling the method on the object is what keeps the permit real and released.
 */
const makeCanvasRenderLimiter = Effect.sync(() => {
  const semaphore = Semaphore.makeUnsafe(CANVAS_RENDER_CONCURRENCY);
  return CanvasRenderLimiter.of({
    withPermits: (permits: number) => semaphore.withPermits(permits),
  });
});

export const layerCanvasRenderLimiter = Layer.effect(CanvasRenderLimiter, makeCanvasRenderLimiter);

const projectGone = (documentId: string) =>
  new CanvasViewError({
    documentId: documentId as CanvasViewError["documentId"],
    code: "document_not_found",
    detail: "That design does not exist in this project.",
  });

const projectMissing = (projectId: string) =>
  new CanvasViewError({
    documentId: "project" as CanvasViewError["documentId"],
    code: "document_not_found",
    detail: `Project ${projectId} is not available on this environment.`,
  });

/**
 * Resolves the project a call names, refusing one this environment does not have.
 *
 * Every entry point goes through here, so `render`, `subscribe`, and `list` cannot drift on which
 * project a request may reach. `CanvasProjects` already refuses an unknown id; this narrows that to
 * the socket's own error vocabulary and documents that the check is deliberate rather than implied
 * by the optional field on the render input.
 */
const projectServices = (
  projectId: string | undefined,
  documentId: string,
): Effect.Effect<
  CanvasProjects.CanvasProjectServices,
  CanvasViewError,
  ProjectService.ProjectService | CanvasChangeBus.CanvasChangeBus
> =>
  Effect.suspend(() => {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      return Effect.fail(projectGone(documentId));
    }
    return CanvasProjects.viewServicesForProject(projectId as ProjectId).pipe(
      Effect.mapError((): CanvasViewError => projectGone(documentId)),
    );
  });

/**
 * The designs in a project, as summaries. Opening a design from the palette costs no render until
 * one is actually shown, and a list never carries a document: Canvas designs are opaque to DAK, so
 * this is ids and titles rather than content.
 */
/**
 * A service failure as the socket's own error. The codes are the same vocabulary, so the message the
 * user reads is the one the agent would have been told, rather than a second phrasing of it.
 */
const asViewError =
  (documentId: string) =>
  (error: CanvasFailure): CanvasViewError =>
    new CanvasViewError({
      documentId: documentId as CanvasViewError["documentId"],
      code: error.code,
      detail: error.detail,
    });

export const listCanvas = Effect.fn("ws.canvas.list")(function* (input: CanvasListClientInput) {
  const { service } = yield* projectServices(input.projectId, input.projectId);
  return (yield* service
    .list({
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.includeTrash === undefined ? {} : { includeTrash: input.includeTrash }),
    })
    .pipe(Effect.mapError(asViewError(input.projectId)))) satisfies CanvasListResult;
});

/**
 * Frames plus the sequence they were rendered at, for the client to show.
 *
 * `maxEdge` is the caller's displayed size times its pixel ratio rather than the design's own
 * dimensions. The frames are base64 PNG over a socket that may be a relay or a tunnel, so rendering
 * a design larger than anyone is looking at spends the user's bandwidth on pixels nobody sees.
 */
export const renderCanvas = Effect.fn("ws.canvas.render")(function* (input: CanvasRenderInput) {
  const { view } = yield* projectServices(input.projectId, input.documentId);
  const limiter = yield* CanvasRenderLimiter;
  const rasterize = view.render({
    documentId: input.documentId,
    ...(input.maxEdge === undefined ? {} : { maxEdge: input.maxEdge }),
  });
  const rendered = yield* limiter.withPermits(1)(rasterize);
  return {
    documentId: rendered.documentId as CanvasRenderResult["documentId"],
    title: rendered.title,
    module: rendered.module,
    sequence: rendered.sequence,
    projectionCurrent: rendered.projectionCurrent,
    // Reported rather than assumed: the service lowers this when the frames it produced did not fit
    // their payload budget, and a view that is not told would show them as though they were full size.
    maxEdge: rendered.maxEdge,
    frames: rendered.frames,
    omittedFrames: rendered.omittedFrames,
  } satisfies CanvasRenderResult;
});

/**
 * Brings a trashed design back.
 *
 * A client can mark a design trashed but has no other way to undo that, and trash is recoverable by
 * design — so without this the view is a dead end the user cannot leave. The title confirmation that
 * guards an agent's trash call does not apply here: the user is restoring, not destroying.
 */
export const restoreCanvas = Effect.fn("ws.canvas.restore")(function* (
  input: CanvasSubscribeInput,
) {
  const { service } = yield* projectServices(input.projectId, input.documentId);
  const error = asViewError(input.documentId);
  // The title is read first: the restore itself reports only that it happened, and the view names
  // the design it just brought back.
  const before = yield* service.read({ documentId: input.documentId }).pipe(Effect.mapError(error));
  const restored = yield* service
    .restore({ documentId: input.documentId })
    .pipe(Effect.mapError(error));
  return {
    documentId: restored.documentId as CanvasRestoreSummary["documentId"],
    title: before.summary.title,
    restored: true as const,
  } satisfies CanvasRestoreSummary;
});

/**
 * The sequence of a document as it moves, for a live view.
 *
 * A render is expensive and the engine is not built for concurrent rasterization, so this emits the
 * sequence alone and the client decides when to re-render. That is also what makes a fast agent
 * harmless here: fifty edits produce fifty one-line frames, and the view coalesces them into a
 * single render rather than queueing fifty.
 *
 * Updates come from the store's own change bus rather than a poll, so a design that is not being
 * edited costs nothing while a view stays open. The first frame is read synchronously, so a view
 * never shows a stale sequence while waiting for an edit to happen.
 */
export const subscribeCanvas = Effect.fn("ws.canvas.subscribe")(function* (
  input: CanvasSubscribeInput,
) {
  const { view } = yield* projectServices(input.projectId, input.documentId);
  const bus = yield* CanvasChangeBus.CanvasChangeBus;

  /** The sequence now, or a refusal naming a design that is gone. */
  const currentSequence = view
    .currentSequence({ documentId: input.documentId })
    .pipe(Effect.mapError((): CanvasViewError => projectGone(input.documentId)));

  const opening = yield* currentSequence;
  const initial: CanvasStreamItem = {
    kind: "sequence",
    documentId: input.documentId,
    sequence: opening.sequence,
    trashed: opening.trashed,
  };

  /**
   * Only this document's changes, and only ones that actually moved it. A repeated sequence means
   * nothing the view is showing is stale, so it is dropped here rather than shipped for the client
   * to filter.
   */
  const live = bus.changes.pipe(
    Stream.filter((change) => change.documentId === input.documentId),
    Stream.map((change): CanvasStreamItem => ({
      kind: "sequence",
      documentId: input.documentId,
      sequence: change.sequence,
      trashed: change.trashed,
    })),
    // A change that repeats the sequence the view already holds moved nothing, so it is dropped
    // here rather than shipped for the client to filter. A run of edits collapses to its last
    // value, which is what matters: what is current, not how many writes got there.
    Stream.changesWith(
      (left, right) => left.sequence === right.sequence && left.trashed === right.trashed,
    ),
  );

  return Stream.concat(rpcInitialItems([initial]), live);
});

/**
 * Every design a project touches, so a client can open whichever one the agent is working on.
 *
 * `subscribeCanvas` follows a design the view already knows; this is how it learns the id in the
 * first place. It reads the same change bus, filtered to one project, so a design edited in another
 * project cannot open a tab in this thread.
 *
 * It deliberately emits nothing on subscribe. A view with nothing open has nothing to draw, and an
 * opening frame would have to invent one: there is no "current design" for a project, only the
 * designs that were just edited. Unlike `subscribeCanvas`, no opening read is needed either, because
 * the sequence of a design nobody is showing decides nothing.
 */
export const canvasActivity = Effect.fn("ws.canvas.activity")(function* (
  input: CanvasActivityInput,
) {
  const projects = yield* ProjectService.ProjectService;
  const bus = yield* CanvasChangeBus.CanvasChangeBus;
  // Resolved before subscribing rather than filtered silently afterwards: a stream that never
  // emits is indistinguishable from an idle project, so an unknown project has to fail here.
  const project = yield* projects
    .getById(input.projectId)
    .pipe(Effect.mapError((): CanvasViewError => projectMissing(input.projectId)));
  if (Option.isNone(project)) {
    return yield* Effect.fail(projectMissing(input.projectId));
  }

  return bus.changes.pipe(
    Stream.filter((change) => change.projectId === input.projectId),
    Stream.map((change): CanvasActivityItem => ({
      kind: "activity",
      documentId: change.documentId as CanvasActivityItem["documentId"],
      title: change.title,
      module: change.module,
      sequence: change.sequence,
      trashed: change.trashed,
    })),
    // The bus already drops an append that moved nothing; this drops a publish that reached the same
    // sequence by another route, so a client sees one item per real change rather than per write.
    Stream.changesWith(
      (left, right) =>
        left.documentId === right.documentId &&
        left.sequence === right.sequence &&
        left.trashed === right.trashed,
    ),
  );
});
