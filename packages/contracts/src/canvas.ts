import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * Contracts for the Canvas design surface: a visual design document the user
 * directs through chat, which the agent authors with bounded JavaScript and the
 * user reviews and corrects directly.
 *
 * The document itself is deliberately opaque here. Canvas owns a recursive,
 * cascade-aware schema with its own semantic cross-field validation, and
 * mirroring it into Effect Schema would duplicate that authority and cost work
 * on every frame the clients render. Only the operation surface crosses the
 * wire as contracts; the engine validates documents at its own boundary.
 */

export const CanvasDocumentId = TrimmedNonEmptyString.pipe(
  Schema.brand<"CanvasDocumentId">("CanvasDocumentId"),
);
export type CanvasDocumentId = typeof CanvasDocumentId.Type;

export const CanvasOperationId = TrimmedNonEmptyString.pipe(
  Schema.brand<"CanvasOperationId">("CanvasOperationId"),
);
export type CanvasOperationId = typeof CanvasOperationId.Type;

/**
 * The immutable module a document is created with. `generic` stays flexible and
 * extracts to PNG, SVG, and PDF; the others settle on a deliverable artifact.
 */
export const CanvasModule = Schema.Literals(["generic", "deck", "web", "mobile"]);
export type CanvasModule = typeof CanvasModule.Type;

/** Top-level role-bearing frames are the export units, and the role is module-specific. */
export const CanvasRole = Schema.Literals(["slide", "route", "ios", "android"]);
export type CanvasRole = typeof CanvasRole.Type;

export const CanvasExportRole = Schema.Literals(["slide", "route", "ios", "android"]);
export type CanvasExportRole = typeof CanvasExportRole.Type;

export const CanvasExtractFormat = Schema.Literals(["png", "svg", "pdf"]);
export type CanvasExtractFormat = typeof CanvasExtractFormat.Type;

/** Result limits. Exceeding one is refused with a message that asks for a narrower edit. */
export const CANVAS_EXECUTION_NODE_LIMIT = 10_000;
export const CANVAS_ISSUE_LIMIT = 10_000;
export const CANVAS_ISSUE_SAMPLE_SIZE = 20;
/**
 * A failure the agent can act on. `code` is stable so instructions and tests can
 * branch on it, and `message` is written for the model reading it, not for a log.
 */
export const CanvasFailureCode = Schema.Literals([
  "document_not_found",
  "document_conflict",
  "document_deleted",
  "trash_confirmation_mismatch",
  "execution_result_limit",
  "schema_invalid",
  "script_timeout",
  "script_memory_exceeded",
  "script_rejected",
  "capability_incomplete",
  "unsupported_export",
  "unsupported_module",
  "unknown_font",
  "destination_unsafe",
  "destination_exists",
  "region_too_large",
  "region_empty",
  "storage_failed",
]);
export type CanvasFailureCode = typeof CanvasFailureCode.Type;

export class CanvasFailure extends Schema.TaggedError<CanvasFailure>()("CanvasFailure", {
  code: CanvasFailureCode,
  /** Stable, bounded, and written for the model: what to change, not just what failed. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.code) {
      case "document_not_found":
        return "That design does not exist in this project.";
      case "document_conflict":
        return "The design changed while this edit was being applied. Read the current design and retry.";
      case "document_deleted":
        return "That design is in the trash. Restore it before editing.";
      case "trash_confirmation_mismatch":
        return "Trashing a design needs its exact current title. Confirm the title with the user first.";
      case "execution_result_limit":
        return "That edit was too broad to apply as one execution. Split it into smaller design intents.";
      case "schema_invalid":
        return "The resulting design is not a valid Canvas document, so nothing was changed.";
      case "script_timeout":
        return "That script ran past its time budget, so nothing was changed.";
      case "script_memory_exceeded":
        return "That script used more memory than its budget allows, so nothing was changed.";
      case "script_rejected":
        return "That script was rejected before it ran, so nothing was changed.";
      case "capability_incomplete":
        return "This design uses a capability that cannot be verified for export, so the export is blocked.";
      case "unsupported_export":
        return "That export target is not supported for this design's module.";
      case "unsupported_module":
        return "That design module is not supported.";
      case "unknown_font":
        return "That design references a font that is not shipped, so it would render with a fallback.";
      case "destination_unsafe":
        return "That export destination is not a safe path, so nothing was written.";
      case "destination_exists":
        return "That export destination already exists, so nothing was written.";
      case "region_too_large":
        return "That region rasterizes past the 8192px limit. Ask for a smaller region or a lower scale.";
      case "region_empty":
        return "That region has nothing visible in it, so nothing was rendered.";
      case "storage_failed":
        return "The design could not be written to the project workspace.";
    }
  }
}

export const CanvasDocumentSummary = Schema.Struct({
  id: CanvasDocumentId,
  title: TrimmedNonEmptyString,
  module: CanvasModule,
  /** The authoritative sequence: the highest sequence the server has accepted for this document. */
  sequence: Schema.Int,
  /** False once the projection JSON may lag the update log. */
  projectionCurrent: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CanvasDocumentSummary = typeof CanvasDocumentSummary.Type;

export const CanvasCreateInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  module: CanvasModule,
  /** Optional physical-size preset for a blank generic document. */
  preset: Schema.optional(Schema.Literals(["a4", "letter"])),
});
export type CanvasCreateInput = typeof CanvasCreateInput.Type;

export const CanvasCreateResult = Schema.Struct({
  documentId: CanvasDocumentId,
  title: TrimmedNonEmptyString,
  module: CanvasModule,
  /** Exact id of the blank document's first frame, which the agent authors into. */
  starterFrameId: TrimmedNonEmptyString,
});
export type CanvasCreateResult = typeof CanvasCreateResult.Type;

export const CanvasListInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  /** Whether to include documents in the recoverable trash. */
  includeTrash: Schema.optional(Schema.Boolean),
});
export type CanvasListInput = typeof CanvasListInput.Type;

export const CanvasListResult = Schema.Struct({
  items: Schema.Array(CanvasDocumentSummary),
});
export type CanvasListResult = typeof CanvasListResult.Type;

/**
 * One bounded JavaScript execution against one document. The script runs against
 * a private clone and commits as a single all-or-nothing mutation, so a script
 * that throws partway leaves the document untouched.
 */
export const CanvasExecuteInput = Schema.Struct({
  documentId: CanvasDocumentId,
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  /** `summary` returns a bounded ranked sample; `all` returns every review issue. */
  issueDetail: Schema.optional(Schema.Literals(["summary", "all"])),
});
export type CanvasExecuteInput = typeof CanvasExecuteInput.Type;

export const CanvasIssueSeverity = Schema.Literals(["critical", "major", "minor", "info"]);
export type CanvasIssueSeverity = typeof CanvasIssueSeverity.Type;

export const CanvasIssue = Schema.Struct({
  nodeId: Schema.optional(TrimmedNonEmptyString),
  kind: TrimmedString,
  severity: CanvasIssueSeverity,
  message: Schema.String,
});
export type CanvasIssue = typeof CanvasIssue.Type;

/**
 * Counts are always complete even when `issues` is a sample, so the agent can
 * tell a bounded answer from a complete one instead of assuming it saw
 * everything.
 */
export const CanvasIssueSummary = Schema.Struct({
  total: Schema.Int,
  inspected: Schema.Boolean,
  omitted: Schema.Int,
  byKind: Schema.Record(Schema.String, Schema.Int),
  bySeverity: Schema.Record(Schema.String, Schema.Int),
});
export type CanvasIssueSummary = typeof CanvasIssueSummary.Type;

export const CanvasIssueCode = Schema.Literals([
  "text_overflow",
  "bounds_overflow",
  "off_frame",
  "empty_control",
  "empty_frame",
  "sibling_overlap",
  "frames_overlap",
  "frame_unnamed",
  "font_unavailable",
  "viewport_mismatch",
]);
export type CanvasIssueCode = typeof CanvasIssueCode.Type;

export const CanvasInspectIssue = Schema.Struct({
  code: CanvasIssueCode,
  severity: CanvasIssueSeverity,
  nodeIds: Schema.Array(TrimmedNonEmptyString),
  numbers: Schema.Record(Schema.String, Schema.Union([Schema.Number, Schema.String])),
  fix: TrimmedNonEmptyString,
});
export type CanvasInspectIssue = typeof CanvasInspectIssue.Type;

export const CanvasInspectResult = Schema.Struct({
  /** Ranked by severity and capped; `counts` and `omitted` say what did not fit. */
  issues: Schema.Array(CanvasInspectIssue),
  /** How many of each kind were found, including anything beyond the cap. */
  counts: Schema.Record(Schema.String, Schema.Number),
  /** How many issues the cap dropped. */
  omitted: Schema.Number,
  measuredTextNodes: Schema.Number,
});
export type CanvasInspectResult = typeof CanvasInspectResult.Type;

export const CanvasInspectInput = Schema.Struct({
  documentId: CanvasDocumentId,
  /** A node id or Canvas selector; narrows the answer to that node's subtree. */
  selector: Schema.optional(TrimmedNonEmptyString),
});
export type CanvasInspectInput = typeof CanvasInspectInput.Type;

/** One node an edit touched, with the geometry it ended up at. */
export const CanvasTouchedNode = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type CanvasTouchedNode = typeof CanvasTouchedNode.Type;

/**
 * What one edit did to the design's problems.
 *
 * Kept separate because the useful question is not "is the design clean" but "did my last edit make
 * it worse". An agent that introduced an overflow sees it here, on the edit that caused it, rather
 * than finding it in a later inspect and wondering where it came from.
 */
export const CanvasIssueDelta = Schema.Struct({
  introduced: Schema.Array(CanvasInspectIssue),
  resolved: Schema.Array(CanvasInspectIssue),
  preExisting: Schema.Array(CanvasInspectIssue),
});
export type CanvasIssueDelta = typeof CanvasIssueDelta.Type;

/** The short form every edit carries, so feedback arrives without the agent asking for it. */
export const CanvasEditFeedback = Schema.Struct({
  summary: CanvasIssueSummary,
  /** The worst few problems, with node ids, because a count alone is not actionable. */
  top: Schema.Array(CanvasInspectIssue),
  /** What this edit did to the problem list. */
  delta: CanvasIssueDelta,
  /** Every node this edit touched, measured, so the next element can be placed under it. */
  touched: Schema.Array(CanvasTouchedNode),
});
export type CanvasEditFeedback = typeof CanvasEditFeedback.Type;

/** Screenshot metadata. The bytes travel as MCP image content, never in this payload. */
export const CanvasScreenshot = Schema.Struct({
  nodeIds: Schema.Array(TrimmedNonEmptyString),
  width: Schema.Int,
  height: Schema.Int,
  mimeType: Schema.Literal("image/png"),
});
export type CanvasScreenshot = typeof CanvasScreenshot.Type;

export const CanvasExecuteResult = Schema.Struct({
  documentId: CanvasDocumentId,
  changed: Schema.Boolean,
  /** Durable id of a committed mutation, and the only handle `undo` accepts. Null for a read-only execution. */
  operationId: Schema.optional(CanvasOperationId),
  sequence: Schema.Int,
  prints: Schema.Array(Schema.Unknown),
  result: Schema.Unknown,
  touchedNodeIds: Schema.Array(TrimmedNonEmptyString),
  inspection: Schema.Array(Schema.Unknown),
  issues: Schema.Array(CanvasIssue),
  issueSummary: CanvasIssueSummary,
  screenshots: Schema.Array(CanvasScreenshot),
});
export type CanvasExecuteResult = typeof CanvasExecuteResult.Type;

/**
 * Undo reverses one agent mutation, and only while it is still the document
 * head. A later user or agent edit makes the undo unsafe, so it is refused
 * rather than reconstructed.
 */
export const CanvasUndoInput = Schema.Struct({
  documentId: CanvasDocumentId,
  /** Omit only when a timed-out execute may have committed and lost its result. */
  operationId: Schema.optional(CanvasOperationId),
});
export type CanvasUndoInput = typeof CanvasUndoInput.Type;

export const CanvasUndoResult = Schema.Struct({
  documentId: CanvasDocumentId,
  operationId: CanvasOperationId,
  changed: Schema.Literal(true),
  sequence: Schema.Int,
});
export type CanvasUndoResult = typeof CanvasUndoResult.Type;

/**
 * Trash is recoverable and requires the document's exact current title, which
 * the agent must resolve and confirm with the user first. There is no permanent
 * delete on the agent surface.
 */
export const CanvasTrashInput = Schema.Struct({
  documentId: CanvasDocumentId,
  confirmTitle: TrimmedNonEmptyString,
});
export type CanvasTrashInput = typeof CanvasTrashInput.Type;

export const CanvasRestoreInput = Schema.Struct({
  documentId: CanvasDocumentId,
});
export type CanvasRestoreInput = typeof CanvasRestoreInput.Type;

/**
 * Exports and extractions write inside the project workspace. A path that would
 * leave it, or that already exists, is refused rather than overwritten.
 */
export const CanvasExportInput = Schema.Struct({
  documentId: CanvasDocumentId,
  role: CanvasExportRole,
  frames: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1000),
  ),
  /** Absolute path inside the project workspace. */
  destination: TrimmedNonEmptyString,
});
export type CanvasExportInput = typeof CanvasExportInput.Type;

export const CanvasExtractInput = Schema.Struct({
  documentId: CanvasDocumentId,
  node: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  format: CanvasExtractFormat,
  /** Absolute path inside the project workspace. A trailing separator creates a directory. */
  destination: TrimmedNonEmptyString,
  scale: Schema.optional(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8)),
  ),
});
export type CanvasExtractInput = typeof CanvasExtractInput.Type;

export const CanvasArtifactResult = Schema.Struct({
  artifacts: Schema.Array(TrimmedNonEmptyString),
  /** Every semantic or editability loss the artifact carries, so the user is not surprised by it. */
  consequences: Schema.Array(TrimmedString),
  rasterized: Schema.Array(TrimmedString),
});
export type CanvasArtifactResult = typeof CanvasArtifactResult.Type;

/*
 * Agent-facing results.
 *
 * These are deliberately narrower than the results above. `CanvasDocument` is
 * left opaque, so an agent cannot be handed a whole slide deck on every read:
 * it gets an outline it can address nodes by, and it runs a script for anything
 * deeper. The service still decides everything; these only decide what crosses
 * the wire to a model.
 */

/** One node in a design's outline. Enough to address it in a script, not to redraw it. */
export const CanvasOutlineNode = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The engine's node type, such as `frame`, `text`, or `rect`. Opaque to DAK. */
  kind: TrimmedString,
  /** A role-bearing frame's role. Only top-level role frames carry one. */
  role: Schema.optional(CanvasRole),
  name: Schema.optional(TrimmedString),
  text: Schema.optional(Schema.String),
  /** Descendants below this node, so the agent can see a subtree's weight without walking it. */
  childCount: Schema.Int,
});
export type CanvasOutlineNode = typeof CanvasOutlineNode.Type;

/**
 * A bounded view of a design's structure. `omitted` says how many nodes the
 * outline left out, so the agent can tell a shallow design from a truncated one
 * instead of assuming it saw everything.
 */
export const CanvasOutline = Schema.Struct({
  summary: CanvasDocumentSummary,
  frames: Schema.Array(CanvasOutlineNode),
  totalNodes: Schema.Int,
  omitted: Schema.Int,
});
export type CanvasOutline = typeof CanvasOutline.Type;

/** Caps the outline so one read cannot ship an unbounded design to the model. */
export const CANVAS_OUTLINE_NODE_LIMIT = 400;

/** What one edit committed, without the document and without the screenshot bytes. */
export const CanvasEditResult = Schema.Struct({
  documentId: CanvasDocumentId,
  changed: Schema.Boolean,
  /** The only handle `dak_canvas_undo` accepts. Absent for a read-only execution. */
  operationId: Schema.optional(CanvasOperationId),
  sequence: Schema.Int,
  result: Schema.Unknown,
  prints: Schema.Array(Schema.Unknown),
  touchedNodeIds: Schema.Array(TrimmedNonEmptyString),
  issues: Schema.Array(CanvasIssue),
  issueSummary: CanvasIssueSummary,
  /** Screenshot metadata only. The bytes travel as MCP image content. */
  screenshots: Schema.Array(CanvasScreenshot),
});
export type CanvasEditResult = typeof CanvasEditResult.Type;

export const CanvasUndoSummary = Schema.Struct({
  documentId: CanvasDocumentId,
  operationId: CanvasOperationId,
  title: TrimmedNonEmptyString,
  sequence: Schema.Int,
});
export type CanvasUndoSummary = typeof CanvasUndoSummary.Type;

export const CanvasTrashSummary = Schema.Struct({
  documentId: CanvasDocumentId,
  title: TrimmedNonEmptyString,
  trashed: Schema.Literal(true),
});
export type CanvasTrashSummary = typeof CanvasTrashSummary.Type;

export const CanvasRestoreSummary = Schema.Struct({
  documentId: CanvasDocumentId,
  title: TrimmedNonEmptyString,
  restored: Schema.Literal(true),
});
export type CanvasRestoreSummary = typeof CanvasRestoreSummary.Type;

/*
 * Client surface.
 *
 * The engine is server-only: it runs CanvasKit and QuickJS in Node and its modules never reach a
 * browser bundle. So a client does not draw a design, it asks for rendered frames and shows them.
 * These schemas are what travels for that, and nothing here exposes the document model itself.
 */

/**
 * One rendered frame. `data` is base64 PNG rather than a URL: the bytes are produced by the server
 * on demand and are not a durable artifact anyone else can fetch, so there is nothing to link to.
 * `sequence` is the document sequence this frame was rendered at, which is what a client compares
 * against to know whether what it is showing is still current.
 *
 * `width`/`height` are the raster's own pixels, which is *not* the frame's size: a frame taller than
 * `maxEdge` comes back scaled down, so a 390x1550 frame is delivered as 258x1024 at a 1024 edge and
 * 390x1550 at 2048. `designWidth`/`designHeight` are the frame's real size in design units, carried
 * alongside so a viewer can lay out at true scale and treat the bitmap as resolution only. Without
 * them the only size a client knows is one that moves when the render edge moves, which is what made
 * a design resize itself as the panel was dragged wider.
 */
export const CanvasFrame = Schema.Struct({
  nodeId: TrimmedNonEmptyString,
  role: Schema.optional(CanvasRole),
  /**
   * What the frame is called.
   *
   * The one thing that identifies a frame to a person. `Home` and `Projects` say what they are;
   * `route` says only what shape they are, and two designs in one project both titled
   * "Portfolio Landing Page" become indistinguishable without it. Carried here rather than left to
   * the client to derive, because the name lives on the document node and nothing else sends it.
   */
  name: Schema.optional(TrimmedNonEmptyString),
  width: Schema.Int,
  height: Schema.Int,
  /** The frame's own size in design units, independent of the edge it was rasterized at. */
  designWidth: Schema.Int,
  designHeight: Schema.Int,
  /** Base64 PNG. */
  data: Schema.String,
  /** The document sequence this frame was rendered at. */
  sequence: Schema.Int,
});
export type CanvasFrame = typeof CanvasFrame.Type;

/** Bounds one render so a large design cannot ship an unbounded payload to a client. */
export const CANVAS_RENDER_FRAME_LIMIT = 24;
export const CANVAS_RENDER_MAX_EDGE = 2048;

/**
 * What one render may put on the wire, in base64 characters.
 *
 * Measured, not guessed: the real engine rasterizing a text-bearing 24-slide deck at the maximum
 * edge produces 547K characters, so this leaves room for the same deck plus a photographic frame
 * and still refuses a payload nobody asked for. A design over budget is re-rendered smaller and,
 * failing that, has its trailing frames dropped — never silently, `omittedFrames` says so.
 */
export const CANVAS_RENDER_PAYLOAD_BUDGET_CHARS = 1_048_576;

/**
 * The smallest edge a reduced render may fall back to. Below this a design is unreadable, so a
 * payload that still does not fit is bounded by dropping frames instead of shrinking them further.
 */
export const CANVAS_RENDER_MIN_EDGE = 256;

/**
 * The smallest scale a view may ask for, and the floor a reduced render falls back to.
 *
 * A wide design fitted into a narrow panel legitimately asks for a quarter of itself, so the floor is
 * well below 1. Below it the frames are unreadable smudges rather than a smaller design, and a view
 * that cannot be read is not a saving.
 */
export const CANVAS_RENDER_MIN_SCALE = 0.25;

/**
 * How many renders one environment may have in flight.
 *
 * A render is server CPU: CanvasKit rasterizes frames and is not built for concurrent work. Without a
 * ceiling, several open views on one machine — or one client rendering several designs at once — would
 * queue behind the engine and starve every other turn. Callers wait rather than fail; the view shows
 * its previous frames until a slot frees.
 */
export const CANVAS_RENDER_CONCURRENCY = 2;

/**
 * The designs in a project, for the entry points that list rather than name one: the palette's
 * "open design" and the surfaces a client restores on reload.
 *
 * This is summaries only. A design is opaque to DAK by design, so a list never carries a document —
 * picking one from here still costs a render.
 */
export const CanvasListClientInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  /** Whether to include designs in the recoverable trash. */
  includeTrash: Schema.optional(Schema.Boolean),
});
export type CanvasListClientInput = typeof CanvasListClientInput.Type;

export const CanvasRenderInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  documentId: CanvasDocumentId,
  /** Cap on the rendered edge length. The engine also refuses to exceed its own maximum. */
  maxEdge: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(CANVAS_RENDER_MAX_EDGE)),
  ),
  /**
   * The scale the view draws the design at: its zoom times its pixel ratio.
   *
   * Frames come back at their own size times this, so a design shown at 125% pixel ratio is
   * rasterized at 125% rather than magnified from its own size, and zooming in asks the engine for
   * the scale it is looking at instead of enlarging a bitmap. The engine renders text and shapes at
   * whatever scale it is given, so this is detail, not interpolation. `maxEdge` and the payload
   * budget still cap what comes back.
   */
  scale: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(CANVAS_RENDER_MIN_SCALE)),
  ),
});
export type CanvasRenderInput = typeof CanvasRenderInput.Type;

export const CanvasRenderResult = Schema.Struct({
  documentId: CanvasDocumentId,
  title: TrimmedNonEmptyString,
  module: CanvasModule,
  /** The authoritative sequence these frames were rendered at. */
  sequence: Schema.Int,
  /** False when the projection JSON may lag the update log the frames were hydrated from. */
  projectionCurrent: Schema.Boolean,
  frames: Schema.Array(CanvasFrame),
  /**
   * The edge cap these frames were rasterized under: the requested one, or lower when the payload did
   * not fit its budget. A frame's own `width` and `height` are what it actually got, which is how a
   * view knows a frame answered below the scale it asked for — by this cap, by the budget, or by the
   * frame being taller than the cap at the scale it wanted.
   */
  maxEdge: Schema.Int,
  /**
   * Top-level frames left out, by `CANVAS_RENDER_FRAME_LIMIT` or by the payload budget, so a capped
   * render reads as capped rather than as the whole design.
   */
  omittedFrames: Schema.Int,
});
export type CanvasRenderResult = typeof CanvasRenderResult.Type;

/**
 * The stream a live view follows. It emits only the sequence, never the frames: a render is
 * expensive, so the sequence tells the client whether to re-render and the client decides when.
 * That keeps a fast agent from queueing a render per edit behind a view the user is scrolling.
 */
export const CanvasSubscribeInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  documentId: CanvasDocumentId,
});
export type CanvasSubscribeInput = typeof CanvasSubscribeInput.Type;

/**
 * `trashed` rather than a separate "gone" item: trash is recoverable, so a view keeps the design it
 * is showing and marks it stale instead of tearing down. A design whose directory is actually gone
 * fails the read outright, which surfaces as an RPC error rather than a silent stream.
 */
export const CanvasSequenceItem = Schema.Struct({
  kind: Schema.Literal("sequence"),
  documentId: CanvasDocumentId,
  sequence: Schema.Int,
  trashed: Schema.Boolean,
});
export type CanvasSequenceItem = typeof CanvasSequenceItem.Type;

export const CanvasStreamItem = CanvasSequenceItem;
export type CanvasStreamItem = typeof CanvasStreamItem.Type;

/**
 * A project's design activity, for a client that has nothing open yet.
 *
 * `CanvasSubscribeInput` names the document a view already knows about. This is the other direction:
 * a design the agent created or edited, which the panel has to be told about before it can subscribe
 * to it. `title` and `module` travel so a tab can be labelled the moment the design appears instead
 * of waiting for a render, and `sequence` lets a view that is already showing the design decide
 * whether it needs to re-render rather than re-rendering on every publish.
 *
 * It is deliberately project-scoped rather than environment-scoped: an agent working in one project
 * must not open a design tab in a thread that is looking at another.
 */
export const CanvasActivityInput = Schema.Struct({ projectId: ProjectId });
export type CanvasActivityInput = typeof CanvasActivityInput.Type;

export const CanvasActivityItem = Schema.Struct({
  kind: Schema.Literal("activity"),
  documentId: CanvasDocumentId,
  title: TrimmedNonEmptyString,
  module: CanvasModule,
  /** The sequence this design reached, so a live view can skip a render it already has. */
  sequence: Schema.Int,
  trashed: Schema.Boolean,
});
export type CanvasActivityItem = typeof CanvasActivityItem.Type;

/**
 * A design the client cannot draw, named so it can say why. Carried as an RPC error rather than a
 * stream item so the client's subscription fails with something it can render, and the value is a
 * public `CanvasFailure` code so nothing about the workspace leaks through the message.
 */
export class CanvasViewError extends Schema.TaggedError<CanvasViewError>()("CanvasViewError", {
  documentId: CanvasDocumentId,
  code: CanvasFailureCode,
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
