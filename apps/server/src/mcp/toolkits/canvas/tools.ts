import {
  CanvasArtifactResult,
  CanvasCreateResult,
  CanvasDocumentId,
  CanvasEditResult,
  CanvasExtractFormat,
  CanvasFailure,
  CanvasListResult,
  CanvasModule,
  CanvasOutline,
  CanvasRestoreSummary,
  CanvasTrashSummary,
  CanvasUndoSummary,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
} from "@dak/contracts";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/ai";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as CanvasChangeBus from "../../../canvas/CanvasChangeBus.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * A Canvas failure travels as declared rather than being flattened into
 * `OrchestratorMcpFailure`, so the agent gets the specific code it can branch on
 * (`document_conflict` says re-read and retry, `script_timeout` says the script
 * ran too long) instead of one generic refusal. The access gate's own refusals
 * arrive as `OrchestratorMcpFailure`.
 */
const CanvasToolFailure = Schema.Union([CanvasFailure, OrchestratorMcpFailure]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  Crypto.Crypto,
  // Building the per-project store reaches the change bus, so a client view following this
  // design's sequence hears about an edit made through these tools.
  CanvasChangeBus.CanvasChangeBus,
];

const shared = {
  failure: CanvasToolFailure,
  failureMode: "return" as const,
  dependencies,
};

const ProjectTarget = Schema.optional(
  ProjectId.annotate({
    description:
      "Project holding the designs. Omit for the calling thread's project; an MCP client outside a DAK thread must pass it.",
  }),
);

/** `starterFrameId` names the blank document's first frame, which the agent authors into. */
const CanvasCreateTool = Tool.make("dak_canvas_create", {
  ...shared,
  description:
    "Start a new blank design in this project and get back its documentId and the starterFrameId to author into. module picks the deliverable: 'generic' stays flexible and extracts to PNG, SVG, and PDF, while 'deck', 'web', and 'mobile' settle on slides, a web page, or a phone screen. preset chooses a physical page size for a blank generic document. Author it with dak_canvas_edit.",
  parameters: Schema.Struct({
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
      description: "Name for the design. The user sees this, so use their wording.",
    }),
    module: CanvasModule.annotate({ description: "What the design is for." }),
    preset: Schema.optional(
      Schema.Literals(["a4", "letter"]).annotate({
        description: "Physical page size for a blank generic document.",
      }),
    ),
    projectId: ProjectTarget,
  }),
  success: CanvasCreateResult,
})
  .annotate(Tool.Title, "Create a design")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CanvasListTool = Tool.make("dak_canvas_list", {
  ...shared,
  description:
    "List the designs in this project: id, title, module, sequence, and updated time. Set includeTrash to also list designs in the recoverable trash, which dak_canvas_restore can bring back.",
  parameters: Schema.Struct({
    query: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).annotate({
        description: "Maximum designs to return.",
      }),
    ),
    includeTrash: Schema.optional(
      Schema.Boolean.annotate({ description: "Also list designs in the trash." }),
    ),
    projectId: ProjectTarget,
  }),
  success: CanvasListResult,
})
  .annotate(Tool.Title, "List designs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/**
 * An outline rather than the document. A deck can carry thousands of nodes, and
 * shipping the whole model on every read would flood the agent's context for
 * something it only needs ids and roles to address with. Run dak_canvas_edit for
 * anything deeper; its `result` is whatever the script returns.
 */
const CanvasReadTool = Tool.make("dak_canvas_read", {
  ...shared,
  description:
    "Read one design's structure: its title, module, sequence, and an outline of its top-level frames with node ids, kinds, roles, and child counts. Use the ids to address nodes in dak_canvas_edit. The outline is bounded, and `omitted` says how many nodes it left out, so check it before assuming you saw the whole design; run a script through dak_canvas_edit to inspect deeper.",
  parameters: Schema.Struct({
    documentId: CanvasDocumentId.annotate({ description: "Design to read, from dak_canvas_list." }),
    projectId: ProjectTarget,
  }),
  success: CanvasOutline,
})
  .annotate(Tool.Title, "Read a design")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/**
 * How a document is laid out, stated once and attached to every tool that writes one.
 *
 * Two defaults silently discard what an author writes, and both have cost a real design: a frame
 * with no `layout` mode and children carrying their own x and y is treated as a horizontal row, and
 * text with no `textGrowth` grows to fit its content instead of wrapping. Neither raises an error at
 * the point of authoring, so the only place they can be told is here.
 */
const AUTHORING_NOTES =
  " Authoring rules that are not obvious from a rejected edit: " +
  "(1) A frame with no `layout` key whose children carry their own x and y is placed absolutely, " +
  'exactly as written. Set `layout: "vertical"` to stack children and `layout: "horizontal"` ' +
  "for a row; a frame that declares either is never overridden. " +
  "(2) Text grows to fit its content and never wraps by default, so a long string is drawn past " +
  'its frame and clipped. To wrap it, set BOTH `textGrowth: "fixed-width-height"` and an explicit ' +
  "`height` on the node — the first stops it growing, the second gives the wrapped lines room. " +
  "Either alone leaves it on one line. " +
  "(3) Any edit returns the structural problems found in the result: content that leaves its frame " +
  "(`bounds_overflow`), text that will be cut off (`text_overflow`), a phone-width frame in a `web` " +
  "design (`viewport_mismatch`). Read them and fix the design rather than assuming the edit landed " +
  "as drawn.";

const CanvasEditTool = Tool.make("dak_canvas_edit", {
  ...shared,
  description:
    "Apply one design intent by running bounded JavaScript against the design. The script runs on a private copy and commits as a single all-or-nothing change, so a script that throws partway leaves the design exactly as it was. Address nodes by the ids from dak_canvas_read. `result` is whatever the script returns, which is how you read values back; `print` adds lines to `prints`; a screenshot request returns a PNG you can see. The response carries the structural issues the engine found, ranked and counted: issueSummary is always complete even when `issues` is a bounded sample, so check `inspected` and `omitted` rather than assuming `issues` is everything. A refused script changes nothing, so read the failure and retry differently rather than repeating it. Returns operationId when it committed, which is the only handle dak_canvas_undo accepts." +
    AUTHORING_NOTES,
  parameters: Schema.Struct({
    documentId: CanvasDocumentId.annotate({ description: "Design to edit." }),
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)).annotate({
      description: "JavaScript run against a private copy of this design.",
    }),
    issueDetail: Schema.optional(
      Schema.Literals(["summary", "all"]).annotate({
        description:
          "'summary' (default) returns a bounded ranked sample; 'all' returns every review issue.",
      }),
    ),
    projectId: ProjectTarget,
  }),
  success: CanvasEditResult,
})
  .annotate(Tool.Title, "Edit a design")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CanvasUndoTool = Tool.make("dak_canvas_undo", {
  ...shared,
  description:
    "Reverse one of your own edits, by the operationId dak_canvas_edit returned. This only works while that edit is still the design's most recent change: once the user or another agent has edited since, the undo is refused rather than reconstructed over their work. Omit operationId only to reverse the latest edit, which is right after a timed-out edit that may have committed and lost its result.",
  parameters: Schema.Struct({
    documentId: CanvasDocumentId.annotate({ description: "Design to reverse an edit in." }),
    operationId: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "The edit to reverse. Omit to reverse the most recent one.",
      }),
    ),
    projectId: ProjectTarget,
  }),
  success: CanvasUndoSummary,
})
  .annotate(Tool.Title, "Undo a design edit")
  .annotate(Tool.Readonly, false)
  // It discards a committed edit, so a client must confirm it.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CanvasTrashTool = Tool.make("dak_canvas_trash", {
  ...shared,
  description:
    "Move a design to the trash, where it stays recoverable with dak_canvas_restore. Needs the design's exact current title in confirmTitle, so read it with dak_canvas_list and confirm it with the user first. There is no permanent delete here. Fails on a stale title rather than moving whatever now carries that name.",
  parameters: Schema.Struct({
    documentId: CanvasDocumentId.annotate({ description: "Design to move to the trash." }),
    confirmTitle: TrimmedNonEmptyString.annotate({
      description: "The design's exact current title, confirmed with the user.",
    }),
    projectId: ProjectTarget,
  }),
  success: CanvasTrashSummary,
})
  .annotate(Tool.Title, "Move a design to the trash")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CanvasRestoreTool = Tool.make("dak_canvas_restore", {
  ...shared,
  description:
    "Bring a design back out of the trash so it can be listed and edited again. Restoring is safe: it never overwrites a newer design, and the restored design keeps its sequence.",
  parameters: Schema.Struct({
    documentId: CanvasDocumentId.annotate({ description: "Design to restore." }),
    projectId: ProjectTarget,
  }),
  success: CanvasRestoreSummary,
})
  .annotate(Tool.Title, "Restore a design")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CanvasExportTool = Tool.make("dak_canvas_export", {
  ...shared,
  description:
    "Write a design's frames out as a deliverable file inside this project's workspace: PNG, SVG, or PDF. `nodeIds` are the frames to export, from dak_canvas_read — for a deck that is its slide frames, for a web design its route frames. `destination` must be an absolute path inside the project, and it must not already exist — an export is never allowed to overwrite something. The result lists what the artifact could not carry (`consequences`, such as text that became outlines, and `rasterized`), so tell the user rather than implying the file is a perfect copy of the design.",
  parameters: Schema.Struct({
    documentId: CanvasDocumentId.annotate({ description: "Design to export from." }),
    nodeIds: Schema.Array(TrimmedNonEmptyString)
      .check(Schema.isMinLength(1), Schema.isMaxLength(1000))
      .annotate({ description: "Frame node ids to export, from dak_canvas_read." }),
    format: CanvasExtractFormat.annotate({ description: "Artifact format to write." }),
    destination: TrimmedNonEmptyString.annotate({
      description:
        "Absolute path inside this project's workspace to write to. A trailing separator creates a directory. Refused if it exists.",
    }),
    scale: Schema.optional(
      Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8)).annotate({
        description: "Raster scale for PNG. Ignored for SVG and PDF.",
      }),
    ),
    projectId: ProjectTarget,
  }),
  success: CanvasArtifactResult,
})
  .annotate(Tool.Title, "Export a design")
  .annotate(Tool.Readonly, false)
  // It writes a new file into the user's workspace.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CanvasToolkit = Toolkit.make(
  CanvasCreateTool,
  CanvasListTool,
  CanvasReadTool,
  CanvasEditTool,
  CanvasUndoTool,
  CanvasTrashTool,
  CanvasRestoreTool,
  CanvasExportTool,
);
