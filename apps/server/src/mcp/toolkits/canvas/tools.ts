import {
  CanvasArtifactResult,
  CanvasCreateResult,
  CanvasDocumentId,
  CanvasEditResult,
  CanvasExtractFormat,
  CanvasFailure,
  CanvasInspectResult,
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
import { CanvasMeasureResult } from "./measure.ts";
import {
  CanvasScreenshotAnswer,
  CanvasScreenshotRegion,
} from "../../../canvas/canvasScreenshotSchema.ts";
import { shippedFontDescription } from "../../../canvas/CanvasHostFonts.ts";
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
    "Start a new blank design in this project and get back its documentId and the starterFrameId to author into. " +
    "module is required and picks the deliverable, and it is fixed for the life of the design: SetModule only " +
    "works on a generic design with no role-bearing frames, so a web or mobile design cannot be converted " +
    "afterwards and choosing wrong means starting again. Pick it by the width you are designing for: " +
    "'web' is a desktop or tablet route and is reviewed at about 1440px wide, 'mobile' is a phone screen at " +
    "about 390px, 'deck' is landscape slides, and 'generic' has no width of its own — its presets run from a " +
    "phone card to an A4 sheet, so use it when you genuinely do not know yet. preset chooses a physical page " +
    "size for a blank generic document. Author it with dak_canvas_edit.",
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
  "(3) A rectangle cannot hold children, so you cannot add a label to a shape by inserting text " +
  "into it: replace it with a frame of the same geometry and put the label inside. Use Button to " +
  "get this right the first time. " +
  "(4) A design's module is fixed when it is created and cannot be changed afterwards. " +
  "(5) Every edit returns the structural problems found in the result: content that leaves its frame " +
  "(`bounds_overflow`), text that will be cut off (`text_overflow`), a shape that looks like a button " +
  "with no label (`empty_control`), two text runs drawn over each other (`sibling_overlap`), " +
  "a phone-width frame in a `web` design (`viewport_mismatch`), and more. `feedback.delta` says " +
  "which of those THIS edit introduced and which it resolved, so you can see immediately whether " +
  "you made the design worse. `feedback.touched` carries the measured box of every node you " +
  "touched, so you can place the next element under one without guessing — take a screenshot " +
  "after each section, look at it, and fix what looks wrong before moving on.";

const CanvasEditTool = Tool.make("dak_canvas_edit", {
  ...shared,
  description:
    "Apply one design intent by running bounded JavaScript against the design. The script runs on a private copy and commits as a single all-or-nothing change, so a script that throws partway leaves the design exactly as it was. Address nodes by the ids from dak_canvas_read. `result` is whatever the script returns, which is how you read values back; `print` adds lines to `prints`; a screenshot request returns a PNG you can see. The response carries the structural issues the engine found, ranked and counted: issueSummary is always complete even when `issues` is a bounded sample, so check `inspected` and `omitted` rather than assuming `issues` is everything. A refused script changes nothing, so read the failure and retry differently rather than repeating it. Returns operationId when it committed, which is the only handle dak_canvas_undo accepts." +
    ` Shipped text families: ${shippedFontDescription()}. Set fontFamily to one of these with a listed style's weight (400 Regular, 500 Medium, 600 SemiBold, 700 Bold, 800 ExtraBold); any other family fails with unknown_font, which suggests the nearest shipped match.` +
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

/**
 * `dak_canvas_screenshot`, answering with files rather than pixels.
 *
 * Step A of two. It needs no special MCP registration, so it is an ordinary toolkit tool and works
 * today. Step B attaches the same bytes as image blocks for a harness that passes them through; the
 * paths are in the answer either way, because there is no way to tell from inside the server whether
 * the model on the other end can see an image or can only open a file.
 */
export const CanvasScreenshotTool = Tool.make("dak_canvas_screenshot", {
  ...shared,
  description:
    "Look at a design. Writes PNGs into the project and returns their paths with the region each one " +
    "covers, so you can open them and see them. Target a frame by nodeId, a node by selector " +
    "(#id, type:frame, name:nav, or a slash-separated path), or an explicit region in design units; " +
    "omit all three for the design's first frame. A design short enough comes back as one sharp " +
    "image; a long one comes back as a small overview plus sharp section crops cut at its section " +
    "boundaries, because a single image of a long page would be too small to read. " +
    "WORKFLOW: take a screenshot after you finish each section, open it, look at it, and fix what " +
    "looks wrong before building the next section. This is the only way to see spacing, hierarchy, " +
    "contrast, and whether text is clipped — dak_canvas_inspect catches what can be measured and " +
    "cannot tell you a layout is weak. Do not skip it and do not assume an edit rendered as intended. " +
    "If an image comes back attached to this result, look at it directly instead of opening the path.",
  parameters: Schema.Struct({
    documentId: CanvasDocumentId.annotate({
      description: "Design to shoot, from dak_canvas_list.",
    }),
    nodeId: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "A frame or node id. Omit for the first frame.",
      }),
    ),
    selector: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "#id, type:frame, name:nav, or a slash path.",
      }),
    ),
    region: Schema.optional(
      CanvasScreenshotRegion.annotate({
        description: "An explicit region in design units. Wins over nodeId and selector.",
      }),
    ),
    save: Schema.optional(
      Schema.Boolean.annotate({
        description: "Write the PNGs. Default true; false returns dimensions only.",
      }),
    ),
    sectionIndex: Schema.optional(
      Schema.Number.annotate({
        description:
          "Which page of sections to return, for a frame too tall for one answer. Omit for the " +
          "first. The answer carries nextSectionIndex when there is more; call again with it to " +
          "see the rest. Every section is written to a path either way.",
      }),
    ),
    includeImage: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Attach each PNG to the result as well as writing it. Default true, because the attached " +
          "image is what lets you see the design without opening anything. Set false for paths alone.",
      }),
    ),
    projectId: ProjectTarget,
  }),
  success: CanvasScreenshotAnswer,
})
  .annotate(Tool.Title, "Look at a design")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/**
 * `dak_canvas_screenshot` on its own, because it is registered by hand: `McpServer.toolkit`
 * serialises every result as JSON text, and the whole point of this tool is that the PNG reaches
 * the model as an image block. See `registerImageTool`.
 */
export const CanvasScreenshotToolkit = Toolkit.make(CanvasScreenshotTool);
/**
 * `dak_canvas_inspect` and `dak_canvas_measure`, kept together because both are read-only answers
 * about a design's geometry and neither draws anything.
 */
const CanvasInspectTool = Tool.make("dak_canvas_inspect", {
  ...shared,
  description:
    "Check a design for problems you cannot see by reading the file: text that will be clipped, " +
    "content that runs outside its frame, nodes outside the frame they belong to, shapes that look " +
    "like buttons with no label, empty frames, two text runs drawn over each other, overlapping " +
    "frames, unnamed frames, a phone-width frame in a design whose module says otherwise, and text " +
    "below a readable contrast ratio. Every issue comes with severity, the nodes it names, the " +
    "numbers behind it and a one-line fix. This is the programmatic half of a review: it will not " +
    "tell you a layout is boring or a headline is weak, so look at a screenshot too. Pass a " +
    "selector to narrow the answer to one node. Issues are capped at 25 and ranked by severity; " +
    "`counts` says how many of each kind were found in total, so a capped answer is never mistaken " +
    "for a clean one.",
  parameters: Schema.Struct({
    documentId: CanvasDocumentId.annotate({ description: "Design to check." }),
    selector: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "A node id or selector. Narrows the answer to that node's subtree.",
      }),
    ),
    projectId: ProjectTarget,
  }),
  success: CanvasInspectResult,
})
  .annotate(Tool.Title, "Inspect a design")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CanvasMeasureTool = Tool.make("dak_canvas_measure", {
  ...shared,
  description:
    "Measure nodes in a design and get their real boxes, in design units: x, y, width, height. Use " +
    "this to place one element below another — measure the headline, add its height to its y, and " +
    "you will not overlap whatever is next. Wrap makes this necessary rather than optional: a text " +
    "node's height is the height of its wrapped lines, which is usually not what you wrote. " +
    "Omit selectors to measure every top-level frame.",
  parameters: Schema.Struct({
    documentId: CanvasDocumentId.annotate({ description: "Design to measure." }),
    selectors: Schema.optional(
      Schema.Array(TrimmedNonEmptyString)
        .check(Schema.isMaxLength(200))
        .annotate({ description: "Node ids or selectors. Omit for every top-level frame." }),
    ),
    projectId: ProjectTarget,
  }),
  success: CanvasMeasureResult,
})
  .annotate(Tool.Title, "Measure a design")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CanvasToolkit = Toolkit.make(
  CanvasCreateTool,
  CanvasListTool,
  CanvasReadTool,
  CanvasEditTool,
  CanvasInspectTool,
  CanvasMeasureTool,
  CanvasUndoTool,
  CanvasTrashTool,
  CanvasRestoreTool,
  CanvasExportTool,
);
