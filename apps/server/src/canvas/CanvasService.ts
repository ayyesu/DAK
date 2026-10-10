import {
  CANVAS_EXECUTION_NODE_LIMIT,
  CANVAS_ISSUE_LIMIT,
  CANVAS_ISSUE_SAMPLE_SIZE,
  CanvasFailure,
  CanvasTouchedNode,
  type CanvasArtifactResult,
  type CanvasCreateResult,
  type CanvasDocumentSummary,
  type CanvasExecuteResult,
  type CanvasExtractFormat,
  type CanvasListResult,
  type CanvasModule,
  type CanvasOperationId,
  type CanvasUndoResult,
} from "@dak/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  checkExecutionResultLimits,
  checkExportDestination,
  decideConflictRetry,
  detectModuleViewportMismatch,
  resolveTrashConfirmation,
  summarizeReviewIssues,
} from "./canvasInvariants.ts";
import { CANVAS_RASTER_CAP } from "./CanvasPorts.ts";
import type { CanvasMeasureResult } from "../mcp/toolkits/canvas/measure.ts";
import { normalizeForRender } from "./canvasNormalize.ts";
import {
  absoluteBoxes,
  findEmptyButtonShapes,
  measureTextNodes,
  textNodeIds,
} from "./canvasText.ts";
import {
  findBoundsOverflow,
  findEmptyFrames,
  findFramesOverlap,
  findLowContrast,
  findOffFrame,
  findSiblingOverlap,
  findTextOverflow,
  findUnnamedFrames,
  narrowToSelector,
  summarizeInspect,
} from "./canvasInspect.ts";
import type { CanvasInspectIssue, CanvasInspectResult } from "@dak/contracts";

const findNodeIn = (document: unknown, id: string): Record<string, unknown> | undefined => {
  const visit = (node: unknown): Record<string, unknown> | undefined => {
    const candidate = node as { id?: unknown; children?: unknown };
    if (candidate.id === id) return candidate as Record<string, unknown>;
    for (const child of (candidate.children ?? []) as ReadonlyArray<unknown>) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const child of Array.isArray((document as { children?: unknown }).children)
    ? (document as { children: ReadonlyArray<unknown> }).children
    : []) {
    const found = visit(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** A filled control with no label, expressed as an inspect issue. */
const findEmptyControls = (
  document: unknown,
  boxes: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
): ReadonlyArray<CanvasInspectIssue> =>
  findEmptyButtonShapes(document, boxes).map((shape) => ({
    code: "empty_control" as const,
    severity: "major" as const,
    nodeIds: [shape.id],
    numbers: { width: shape.width, height: Math.round(shape.height) },
    fix:
      `This is a filled ${shape.width}x${Math.round(shape.height)} shape with no text on it, so it ` +
      `reads as a button the user cannot read. A shape cannot hold children: replace it with a ` +
      `frame of the same geometry and put the label inside, or drop it if it was decoration.`,
  }));
import type {
  CanvasDocument,
  CanvasEngine,
  CanvasEngineScreenshot,
  CanvasScriptResult,
  CanvasStore,
  CanvasStoredDocument,
} from "./CanvasPorts.ts";

/**
 * Canvas as a service: the one place an agent, a client, or a scheduled task goes to create, edit,
 * review, reverse, and export a design.
 *
 * The engine understands designs and the store keeps them. Everything else — whether an edit may
 * land, how large it may be, when it is retried, whether it can be taken back, where an export is
 * allowed to write — is decided here, so those rules hold regardless of which transport asked.
 */

/** How many times one execute re-reads and reapplies after the user edits underneath it. */
export const CANVAS_CONFLICT_MAX_ATTEMPTS = 3;

const failure = (code: CanvasFailure["code"], detail: string): CanvasFailure =>
  new CanvasFailure({ code, detail });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorCode = (error: unknown): string | undefined =>
  (error as { code?: unknown } | null)?.code as string | undefined;

/**
 * A failed execution is classified by what the agent should do about it, not by where it threw.
 * A refused script and a refused design are different answers: the first needs a smaller script,
 * the second a corrected one.
 */
const classifyExecutionFailure = (error: unknown): CanvasFailure["code"] => {
  const code = errorCode(error);
  if (code === "CANVAS_SCHEMA_INVALID") return "schema_invalid";
  if (code === "CANVAS_SCRIPT_TIMEOUT") return "script_timeout";
  if (code === "CANVAS_SCRIPT_MEMORY") return "script_memory_exceeded";
  const message = describe(error);
  if (/timed? ?out|interrupted/iu.test(message)) return "script_timeout";
  if (/memory/iu.test(message)) return "script_memory_exceeded";
  return "script_rejected";
};

export class CanvasService extends Context.Service<
  CanvasService,
  {
    readonly create: (input: {
      readonly title: string;
      readonly module: CanvasModule;
      readonly preset?: "a4" | "letter";
    }) => Effect.Effect<CanvasCreateResult, CanvasFailure>;
    readonly list: (input: {
      readonly query?: string;
      readonly limit?: number;
      readonly includeTrash?: boolean;
    }) => Effect.Effect<CanvasListResult, CanvasFailure>;
    /** The readable document at its authoritative sequence, for a viewer. */
    readonly read: (input: {
      readonly documentId: string;
    }) => Effect.Effect<
      { readonly summary: CanvasDocumentSummary; readonly document: CanvasDocument },
      CanvasFailure
    >;
    readonly execute: (input: {
      readonly documentId: string;
      readonly code: string;
      readonly issueDetail?: "summary" | "all";
    }) => Effect.Effect<CanvasExecuteResultWithImages, CanvasFailure>;
    readonly undo: (input: {
      readonly documentId: string;
      readonly operationId?: string;
    }) => Effect.Effect<CanvasUndoResult, CanvasFailure>;
    readonly trash: (input: {
      readonly documentId: string;
      readonly confirmTitle: string;
    }) => Effect.Effect<{ readonly documentId: string; readonly title: string }, CanvasFailure>;
    readonly restore: (input: {
      readonly documentId: string;
    }) => Effect.Effect<{ readonly documentId: string; readonly restored: true }, CanvasFailure>;
    /** Writes one PNG, SVG, or PDF artifact inside the project workspace. */
    readonly extract: (input: {
      readonly documentId: string;
      readonly nodeIds: ReadonlyArray<string>;
      readonly format: CanvasExtractFormat;
      readonly destination: string;
      readonly scale?: number;
    }) => Effect.Effect<CanvasArtifactResult, CanvasFailure>;
    /**
     * One region of one node, rasterized at a chosen scale.
     *
     * The single path every raster takes, so a whole-frame render, a section screenshot and a future
     * tile are all cut from the same normalized geometry and cannot disagree about what the design
     * looks like.
     */
    readonly renderRegion: (input: {
      readonly documentId: string;
      readonly nodeId: string;
      /** Design units. */
      readonly bounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
      readonly scale?: number;
      readonly maxEdge?: number;
    }) => Effect.Effect<
      {
        readonly width: number;
        readonly height: number;
        readonly data: string;
        readonly mimeType: "image/png";
      },
      CanvasFailure
    >;
    /**
     * Everything wrong with a design that can be established without looking at it.
     *
     * Measured from the same shaper and the same normalized boxes the renderer draws from, so an
     * issue reported here is a fact about the design rather than a guess about it. This is the
     * programmatic half of a review: the screenshot is the other half, and neither replaces the
     * other.
     */
    readonly inspect: (input: {
      readonly documentId: string;
      /** A node id or Canvas selector; narrows the answer to that node's subtree. */
      readonly selector?: string;
    }) => Effect.Effect<CanvasInspectResult, CanvasFailure>;
    /**
     * Real boxes for the nodes an author needs to place against.
     *
     * A text node's height is the height of its wrapped lines, which is rarely what was written, so
     * an agent placing one element under another has no way to know where the first one ended without
     * being told.
     */
    readonly measure: (input: {
      readonly documentId: string;
      readonly selectors?: ReadonlyArray<string>;
    }) => Effect.Effect<CanvasMeasureResult, CanvasFailure>;
  }
>()("dak/canvas/CanvasService") {}

/**
 * The contract shape plus the screenshot bytes, which the transport turns into MCP image content
 * and strips from anything structured. Bytes never belong in a payload the model reads as text.
 */
export interface CanvasExecuteResultWithImages extends CanvasExecuteResult {
  readonly screenshotImages: ReadonlyArray<CanvasEngineScreenshot>;
}

export interface CanvasServiceDeps {
  readonly store: CanvasStore;
  readonly engine: CanvasEngine;
  /** Exports write here and nowhere else. */
  readonly workspaceRoot: string;
  readonly newOperationId: () => string;
  readonly newClientUpdateId: () => string;
}

export const make = (deps: CanvasServiceDeps): CanvasService["Service"] => {
  const { store, engine } = deps;

  const toSummary = (document: CanvasStoredDocument): CanvasDocumentSummary => ({
    id: document.id as CanvasDocumentSummary["id"],
    title: document.title,
    module: document.module,
    sequence: document.sequence,
    projectionCurrent: document.projectionCurrent,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  });

  const create = (input: { title: string; module: CanvasModule; preset?: "a4" | "letter" }) =>
    Effect.gen(function* () {
      const blank = yield* Effect.tryPromise({
        try: () => engine.createBlankDocument({ module: input.module, preset: input.preset }),
        catch: (error) =>
          failure("storage_failed", `Could not build a blank design document: ${describe(error)}`),
      });
      const created = yield* Effect.tryPromise({
        try: () =>
          store.createDocument({
            title: input.title,
            module: input.module,
            // The snapshot starts at the blank state; every later edit appends on top of it.
            snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
            starterFrameId: blank.starterFrameId,
          }),
        catch: () => failure("storage_failed", "Could not write the new design to the project."),
      });
      return {
        documentId: created.documentId as CanvasCreateResult["documentId"],
        title: input.title,
        module: input.module,
        starterFrameId: blank.starterFrameId,
      };
    });

  const list = (input: { query?: string; limit?: number; includeTrash?: boolean }) =>
    Effect.tryPromise({
      try: () => store.listDocuments(input),
      catch: () => failure("storage_failed", "Could not read the designs in this project."),
    }).pipe(Effect.map((documents) => ({ items: documents.map(toSummary) })));

  const read = (input: { documentId: string }) =>
    Effect.gen(function* () {
      const { summary, payload } = yield* Effect.tryPromise({
        try: () => store.getDocumentForExecution(input.documentId),
        catch: () => failure("document_not_found", "That design does not exist in this project."),
      });
      const document = yield* Effect.tryPromise({
        try: () => engine.materialize(payload),
        catch: (error) =>
          failure("storage_failed", `Could not read the design: ${describe(error)}`),
      });
      return { summary: toSummary(summary), document };
    });

  /**
   * One design intent, applied whole or not at all.
   *
   * The script runs against a private clone, so nothing it does is visible until the result has
   * been validated and measured. Only then is a single update appended — carrying both the change
   * and the inverse that makes it undoable — and only then does compaction run.
   */
  const executeOnce = (
    documentId: string,
    code: string,
    issueDetail: "summary" | "all",
  ): Effect.Effect<CanvasExecuteResultWithImages, CanvasFailure> =>
    Effect.gen(function* () {
      const { summary, payload } = yield* Effect.tryPromise({
        try: () => store.getDocumentForExecution(documentId),
        catch: () =>
          failure("document_not_found", "No design with that id exists in this project."),
      });
      if (summary.trashed) {
        return yield* failure(
          "document_deleted",
          "That design is in the trash. Restore it before editing.",
        );
      }

      const current: CanvasScriptResult = yield* Effect.tryPromise({
        try: () => engine.execute({ payload, code, module: summary.module }),
        catch: (error) => failure(classifyExecutionFailure(error), describe(error)),
      });

      // Measured before anything is written, so a refused edit costs nothing and leaves the stored
      // document exactly as it was.
      const limits = checkExecutionResultLimits({
        touchedNodeIds: current.touchedNodeIds,
        issueCount: current.issues.length,
        nodeLimit: CANVAS_EXECUTION_NODE_LIMIT,
        issueLimit: CANVAS_ISSUE_LIMIT,
      });
      if (limits._tag === "Exceeded")
        return yield* failure("execution_result_limit", limits.message);

      // A bounded sample is returned by default, but the counts stay complete so the agent can tell
      // a bounded answer from a whole one instead of assuming it saw everything.
      const summarized = summarizeReviewIssues(
        current.issues,
        current.touchedNodeIds,
        issueDetail === "all" ? current.issues.length : CANVAS_ISSUE_SAMPLE_SIZE,
      );
      const issues =
        issueDetail === "all"
          ? current.issues.map((issue) => ({
              ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
              kind: issue.kind ?? "other",
              severity: (issue.severity ?? "info") as "critical" | "major" | "minor" | "info",
              message: issue.message ?? "",
            }))
          : summarized.sample.map((issue) => ({
              ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
              kind: issue.kind ?? "other",
              severity: (issue.severity ?? "info") as "critical" | "major" | "minor" | "info",
              message: issue.message ?? "",
            }));
      const issueSummary = {
        total: summarized.total,
        inspected: current.changed || current.touchedNodeIds.length > 0,
        omitted: summarized.total - issues.length,
        byKind: summarized.byKind,
        bySeverity: summarized.bySeverity,
      };

      if (!current.changed) {
        return {
          documentId: documentId as CanvasExecuteResult["documentId"],
          changed: false,
          sequence: summary.sequence,
          prints: current.prints,
          result: current.result,
          touchedNodeIds: current.touchedNodeIds,
          inspection: [],
          issues,
          issueSummary,
          screenshots: [],
          screenshotImages: [],
        } satisfies CanvasExecuteResultWithImages;
      }

      const operationId = deps.newOperationId() as CanvasOperationId;
      const appended = yield* Effect.tryPromise({
        try: () =>
          store.appendUpdate({
            documentId,
            clientUpdateId: deps.newClientUpdateId(),
            update: current.forward,
            operationId,
            inverseUpdate: current.inverse,
            expectedSequence: summary.sequence,
          }),
        // A store that refuses the expected sequence means someone edited in between. That is a
        // conflict the caller retries, never a failure to report as a broken write.
        catch: (error) => failure("document_conflict", describe(error)),
      });

      // Compaction runs after the update is already committed, so failing to snapshot must not turn
      // a successful edit into an error the agent answers by retrying.
      yield* Effect.tryPromise({
        try: () =>
          store.createSnapshot({
            documentId,
            throughSequence: appended.sequence,
            state: current.state,
            projection: current.document,
          }),
        catch: () => undefined,
      }).pipe(Effect.ignore);

      return {
        documentId: documentId as CanvasExecuteResult["documentId"],
        changed: true,
        operationId,
        sequence: appended.sequence,
        prints: current.prints,
        result: current.result,
        touchedNodeIds: current.touchedNodeIds,
        inspection: [],
        issues,
        issueSummary,
        screenshots: current.screenshots.map((screenshot) => ({
          nodeIds: [...screenshot.nodeIds],
          width: screenshot.width,
          height: screenshot.height,
          mimeType: "image/png" as const,
        })),
        screenshotImages: current.screenshots,
      } satisfies CanvasExecuteResultWithImages;
    });

  const execute = (input: { documentId: string; code: string; issueDetail?: "summary" | "all" }) =>
    Effect.gen(function* () {
      const issueDetail = input.issueDetail ?? "summary";
      for (let attempt = 0; ; attempt += 1) {
        const attemptResult = yield* Effect.result(
          executeOnce(input.documentId, input.code, issueDetail),
        );
        if (attemptResult._tag === "Success") return attemptResult.success;
        const error = attemptResult.failure;
        if (error.code !== "document_conflict") return yield* error;
        // Someone is editing while the agent works. Re-read and reapply, up to a cap, so a user who
        // never stops cannot spin the agent.
        const decision = decideConflictRetry({
          attempt,
          maxAttempts: CANVAS_CONFLICT_MAX_ATTEMPTS,
        });
        if (decision._tag === "GiveUp")
          return yield* failure("document_conflict", decision.message);
      }
    });

  const undo = (input: { documentId: string; operationId?: string }) =>
    Effect.gen(function* () {
      const stored = yield* Effect.tryPromise({
        try: () => store.getDocument(input.documentId),
        catch: () => failure("document_not_found", "That design no longer exists."),
      });
      const undone = yield* Effect.tryPromise({
        try: () =>
          store.undoOperation({
            documentId: input.documentId,
            ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
            expectedSequence: stored.sequence,
          }),
        // Undo is only safe while the operation is still the document head; the store refuses
        // otherwise, and reconstructing an older document would discard newer work.
        catch: (error) => failure("document_conflict", describe(error)),
      });
      return {
        documentId: input.documentId as CanvasUndoResult["documentId"],
        operationId: undone.operationId as CanvasUndoResult["operationId"],
        changed: true as const,
        sequence: undone.sequence,
      };
    });

  const trash = (input: { documentId: string; confirmTitle: string }) =>
    Effect.gen(function* () {
      const stored = yield* Effect.tryPromise({
        try: () => store.getDocument(input.documentId),
        catch: () => failure("document_not_found", "That design no longer exists."),
      });
      // The current title is re-read here rather than trusted from the caller, so a stale reference
      // cannot move a design the user was looking at a moment ago.
      const confirmation = resolveTrashConfirmation({
        currentTitle: stored.title,
        confirmTitle: input.confirmTitle,
      });
      switch (confirmation._tag) {
        case "NotFound":
          return yield* failure("document_not_found", "That design no longer exists.");
        case "TitleMismatch":
          return yield* failure("trash_confirmation_mismatch", confirmation.message);
        case "Confirmed":
          break;
      }
      yield* Effect.tryPromise({
        try: () => store.trashDocument(input.documentId),
        catch: () => failure("storage_failed", "Could not move the design to the trash."),
      });
      return { documentId: input.documentId, title: confirmation.title };
    });

  const restore = (input: { documentId: string }) =>
    Effect.tryPromise({
      try: () => store.restoreDocument(input.documentId),
      catch: () => failure("storage_failed", "Could not restore that design."),
    }).pipe(Effect.as({ documentId: input.documentId, restored: true as const }));

  const extract = (input: {
    documentId: string;
    nodeIds: ReadonlyArray<string>;
    format: CanvasExtractFormat;
    destination: string;
    scale?: number;
  }) =>
    Effect.gen(function* () {
      const exists = yield* Effect.promise(() => store.pathExists(input.destination));
      // The destination is refused rather than repaired: quietly rewriting a path is how an agent
      // overwrites work it did not mean to touch.
      const destination = checkExportDestination({
        workspaceRoot: deps.workspaceRoot,
        destination: input.destination,
        exists,
      });
      switch (destination._tag) {
        case "OutsideWorkspace":
          return yield* failure("destination_unsafe", destination.message);
        case "Unsafe":
          return yield* failure("destination_exists", destination.message);
        case "Ok":
          break;
      }
      const { payload } = yield* Effect.tryPromise({
        try: () => store.getDocumentForExecution(input.documentId),
        catch: () => failure("document_not_found", "That design does not exist in this project."),
      });
      const artifact = yield* Effect.tryPromise({
        try: () =>
          engine.extract({
            payload,
            nodeIds: input.nodeIds,
            format: input.format,
            destination: destination.path,
            ...(input.scale === undefined ? {} : { scale: input.scale }),
          }),
        catch: (error) => failure("unsupported_export", describe(error)),
      });
      return {
        artifacts: [...artifact.artifacts],
        consequences: [...artifact.consequences],
        rasterized: [...artifact.rasterized],
      } satisfies CanvasArtifactResult;
    });

  /**
   * One region, rasterized.
   *
   * The engine throws above the raster cap rather than shrinking, and that is the right behaviour
   * for a file export — a smaller image than was asked for is a surprise. It is the wrong behaviour
   * for a screenshot the user is about to look at, so the refusal is turned into a CanvasFailure the
   * caller can read rather than a raw engine error, and it always names the region that overflowed.
   */
  const renderRegion: CanvasService["Service"]["renderRegion"] = (input) =>
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: () => store.getDocumentForExecution(input.documentId),
        catch: () => failure("document_not_found", "That design does not exist in this project."),
      });
      const scale = input.scale ?? 1;
      const rasterWidth = Math.ceil(input.bounds.width * scale);
      const rasterHeight = Math.ceil(input.bounds.height * scale);
      if (rasterWidth > CANVAS_RASTER_CAP || rasterHeight > CANVAS_RASTER_CAP) {
        return yield* failure(
          "region_too_large",
          `That region rasterizes to ${rasterWidth}x${rasterHeight}px at ${scale}x, past the ` +
            `${CANVAS_RASTER_CAP}px limit. Ask for a smaller region or a lower scale; nothing was ` +
            `rendered.`,
        );
      }
      return yield* Effect.tryPromise({
        try: () =>
          engine.renderRegion({
            payload: payload.payload,
            nodeId: input.nodeId,
            bounds: input.bounds,
            scale,
            ...(input.maxEdge === undefined ? {} : { maxEdge: input.maxEdge }),
          }),
        catch: (error) => {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === "CANVAS_REGION_TOO_LARGE")
            return failure("region_too_large", describe(error));
          if (code === "CANVAS_REGION_EMPTY") return failure("region_empty", describe(error));
          return failure("storage_failed", describe(error));
        },
      });
    });

  /**
   * Every issue, measured, in one answer.
   *
   * The document is normalized first, so a design whose headline wraps is measured against the
   * layout it will actually be drawn with rather than the one it was authored as.
   */
  const inspect: CanvasService["Service"]["inspect"] = (input) =>
    Effect.gen(function* () {
      const { payload } = yield* Effect.tryPromise({
        try: () => store.getDocumentForExecution(input.documentId),
        catch: () => failure("document_not_found", "That design does not exist in this project."),
      });
      const materialized = yield* Effect.tryPromise({
        try: () => engine.materialize(payload),
        catch: () => failure("storage_failed", "This design could not be read right now."),
      });
      const normalized = yield* Effect.promise(() => normalizeForRender(materialized));
      const measured = yield* Effect.promise(() =>
        measureTextNodes(normalized, textNodeIds(normalized)),
      );
      const boxes = absoluteBoxes(normalized, measured);

      const scoped =
        input.selector === undefined ? normalized : narrowToSelector(normalized, input.selector);

      const issues = [
        ...findTextOverflow(scoped, measured),
        ...findBoundsOverflow(scoped, boxes),
        ...findOffFrame(scoped, boxes),
        ...findEmptyControls(scoped, boxes),
        ...findEmptyFrames(scoped, boxes),
        ...findSiblingOverlap(scoped, boxes),
        ...findFramesOverlap(scoped, boxes),
        ...findUnnamedFrames(scoped),
        // The grouped viewport mismatch, re-expressed with a fix line: the invariant's own message
        // explains the problem, but an inspect answer owes the caller a way forward.
        ...detectModuleViewportMismatch(scoped).map((issue) => ({
          code: "viewport_mismatch" as const,
          severity: "major" as const,
          nodeIds: issue.nodeIds ?? (issue.nodeId === undefined ? [] : [issue.nodeId]),
          numbers: { frames: (issue.nodeIds ?? []).length },
          fix:
            `${issue.message ?? "These frames are drawn at a phone width for this module."} A ` +
            `design's module is fixed when it is created, so the fix is to create the design again ` +
            `with the module that matches its width rather than to change this one.`,
        })),
        ...findLowContrast(scoped),
      ];
      const summary = summarizeInspect(issues);
      return {
        issues: summary.issues,
        counts: summary.counts,
        omitted: summary.omitted,
        measuredTextNodes: measured.size,
      } satisfies CanvasInspectResult;
    });

  /**
   * Boxes an author can place against.
   *
   * Measured from the normalized document, so a wrapped headline reports the height it will actually
   * occupy rather than the height someone wrote. Selectors that match nothing are reported back,
   * because an empty answer about a node that does not exist reads as "nothing there".
   */
  const measure: CanvasService["Service"]["measure"] = (input) =>
    Effect.gen(function* () {
      const { payload } = yield* Effect.tryPromise({
        try: () => store.getDocumentForExecution(input.documentId),
        catch: () => failure("document_not_found", "That design does not exist in this project."),
      });
      const materialized = yield* Effect.tryPromise({
        try: () => engine.materialize(payload),
        catch: () => failure("storage_failed", "This design could not be read right now."),
      });
      const normalized = yield* Effect.promise(() => normalizeForRender(materialized));
      const measured = yield* Effect.promise(() =>
        measureTextNodes(normalized, textNodeIds(normalized)),
      );
      const boxes = absoluteBoxes(normalized, measured);
      const requested = input.selectors ?? [];
      const unmatched: string[] = [];
      const ids: string[] = [];

      const find = (node: unknown, selector: string): string | undefined => {
        const wanted = selector.startsWith("#")
          ? selector.slice(1)
          : (selector.split("/").pop() ?? selector);
        const search = (candidate: any): string | undefined => {
          if (candidate?.id === wanted || candidate?.name === selector) return candidate.id;
          for (const child of (candidate?.children ?? []) as ReadonlyArray<unknown>) {
            const found = search(child);
            if (found !== undefined) return found;
          }
          return undefined;
        };
        for (const child of (normalized as { children?: ReadonlyArray<unknown> }).children ?? []) {
          const found = search(child);
          if (found !== undefined) return found;
        }
        return undefined;
      };

      if (requested.length === 0) {
        for (const child of (normalized as { children?: ReadonlyArray<{ id?: unknown }> })
          .children ?? []) {
          if (typeof child.id === "string") ids.push(child.id);
        }
      } else {
        for (const selector of requested) {
          const id = find(normalized, selector);
          if (id === undefined) unmatched.push(selector);
          else ids.push(id);
        }
      }

      const nodes = ids.flatMap((id) => {
        const box = boxes.get(id);
        if (box === undefined) return [];
        const node = (findNodeIn(normalized, id) ?? {}) as Record<string, unknown>;
        return [
          {
            id,
            type: typeof node.type === "string" ? node.type : "unknown",
            ...(typeof node.name === "string" && node.name.length > 0 ? { name: node.name } : {}),
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          } satisfies CanvasTouchedNode,
        ];
      });

      return {
        nodes,
        measuredTextNodes: measured.size,
        unmatchedSelectors: unmatched,
      } satisfies CanvasMeasureResult;
    });

  return {
    create,
    list,
    read,
    execute,
    undo,
    trash,
    restore,
    extract,
    renderRegion,
    inspect,
    measure,
  };
};

export const layer = (deps: CanvasServiceDeps) => Layer.succeed(CanvasService, make(deps));
