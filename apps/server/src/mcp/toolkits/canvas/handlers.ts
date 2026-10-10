import {
  CANVAS_OUTLINE_NODE_LIMIT,
  type CanvasDocumentSummary,
  type CanvasOutlineNode,
  type CanvasRole,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@dak/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as CanvasProjects from "../../../canvas/CanvasProjects.ts";
import * as CanvasEngineLive from "../../../canvas/CanvasEngineLive.ts";
import {
  answerCanvasScreenshot,
  type CanvasScreenshotAnswerShape,
} from "../../../canvas/canvasScreenshotTool.ts";
import type * as CanvasService from "../../../canvas/CanvasService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { type Caller, readCaller, resolveProjectId } from "../../threadAccess.ts";
import { CanvasScreenshotToolkit, CanvasToolkit } from "./tools.ts";

type CanvasServiceType = CanvasService.CanvasService["Service"];

const projectNotFound = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "The project was not found.",
  });

/**
 * The service for the project a tool acts in. `projectId` selects it; an omitted one means the
 * calling thread's project, and a caller outside a thread is told to pass one rather than guessing.
 *
 * Id minting lives here rather than in the shared resolver because only this surface edits: the
 * service mints ids synchronously, so one unguessable prefix plus a counter gives it unique ids
 * without pulling an Effect into a synchronous callback.
 */
const forProject = Effect.fn("mcp.canvas.forProject")(function* (
  caller: Caller,
  projectId: ProjectId | undefined,
) {
  const target = yield* resolveProjectId(caller, projectId);
  const crypto = yield* Crypto.Crypto;
  const prefix = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  let minted = 0;
  const nextId = (kind: string) => () => `${kind}-${prefix}-${(minted += 1)}`;
  const resolved = yield* CanvasProjects.servicesForProject(target, {
    newOperationId: nextId("op"),
    newClientUpdateId: nextId("cu"),
  }).pipe(Effect.mapError(() => projectNotFound()));
  return { ...resolved, projectId: target };
});

/** The role of a top-level frame, when it carries one. DAK does not interpret these beyond export. */
const roleOf = (value: unknown): CanvasRole | undefined =>
  value === "slide" || value === "route" || value === "ios" || value === "android"
    ? value
    : undefined;

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * A node as the agent sees it: enough to address it in a script, never enough to redraw the design.
 * `childCount` is the node's direct child count, so the agent can see a frame's weight without the
 * outline having to list everything inside it.
 */
const toOutlineNode = (node: Record<string, unknown>, role?: CanvasRole): CanvasOutlineNode => {
  const name = stringOrUndefined(node.name);
  const text = stringOrUndefined(node.text);
  return {
    id: String(node.id ?? ""),
    kind: stringOrUndefined(node.type) ?? stringOrUndefined(node.kind) ?? "unknown",
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(text === undefined ? {} : { text }),
    childCount: Array.isArray(node.children) ? node.children.length : 0,
  };
};

/** Every node in a subtree, counted without materializing a list. */
const countNodes = (nodes: ReadonlyArray<Record<string, unknown>>): number =>
  nodes.reduce(
    (total, node) => total + 1 + (Array.isArray(node.children) ? countNodes(node.children) : 0),
    0,
  );

/**
 * The top-level frames of a design, bounded. `totalNodes` counts the whole tree and `omitted`
 * everything the bound left out, so the agent can tell a shallow design from one this cut short
 * rather than assuming it saw the whole thing.
 */
export const outlineOf = (
  summary: CanvasDocumentSummary,
  document: unknown,
): {
  readonly summary: CanvasDocumentSummary;
  readonly frames: ReadonlyArray<CanvasOutlineNode>;
  readonly totalNodes: number;
  readonly omitted: number;
} => {
  const children =
    (document as { readonly children?: ReadonlyArray<Record<string, unknown>> } | null)?.children ??
    [];
  const listed = children.slice(0, CANVAS_OUTLINE_NODE_LIMIT);
  const totalNodes = countNodes(children);
  return {
    summary,
    frames: listed.map((node) => toOutlineNode(node, roleOf(node.role))),
    totalNodes,
    omitted: totalNodes - countNodes(listed),
  };
};

/**
 * The current title of a design, read through the store rather than taken from the caller. Undo and
 * restore report it so the agent can name what it acted on, and trash needs the agent to have
 * confirmed this exact value.
 */
const readTitle = (service: CanvasServiceType, documentId: string) =>
  service
    .list({ limit: 500, includeTrash: true })
    .pipe(
      Effect.flatMap(({ items }) =>
        Effect.succeed(items.find((item) => item.id === documentId)?.title ?? ""),
      ),
    );

/**
 * The `canvas` capability, checked here rather than by `readCaller`, which only knows about
 * orchestration. A credential issued for another environment's MCP surface must not reach a design.
 */
const requireCanvasCapability = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.capabilities.has("canvas")
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This credential cannot use Canvas designs.",
          }),
        ),
  ),
);

/**
 * The screenshot tool is registered by hand so its PNGs go out as image blocks, but it still runs
 * through `McpToolAccess` like every other canvas tool, so the capability check and the caller's
 * project resolution are the ordinary ones rather than a second implementation of both.
 *
 * The answer is reshaped here rather than in the transport: the canvas answer carries `heightPx`
 * because `height` is the design-space height of the part and the two are genuinely different
 * numbers, and only the pixels are ever rendered.
 */
const screenshotResult = (answer: CanvasScreenshotAnswerShape) => ({
  ...answer,
  parts: answer.parts.map((part) => ({
    mimeType: part.mimeType,
    width: part.width,
    height: part.heightPx,
    /** Kept so the text part can say what each image is and where the full-size file is. */
    role: part.role,
    y: part.y,
    designHeight: part.height,
    ...(part.path === undefined ? {} : { path: part.path }),
    // The tool's success schema names this `heightPx`, because `height` is the part's height in
    // design units and the two are genuinely different numbers. The transport needs the pixel one.
    heightPx: part.heightPx,
    // Omitted rather than empty when the caller asked for paths only: an empty string is not a
    // valid image and the schema (rightly) rejects it.
    ...(part.data === undefined ? {} : { data: part.data }),
  })),
});

/**
 * Its own layer, because `dak_canvas_screenshot` is registered by hand rather than as part of
 * `CanvasToolkit`: `McpServer.toolkit` serialises every result as JSON text, and the whole point of
 * this tool is that the PNG reaches the model as an image block.
 */
export const screenshotLayer = McpToolAccess.toLayer(CanvasScreenshotToolkit, {
  dak_canvas_screenshot: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service, store, workspaceRoot } = yield* forProject(caller, input.projectId);
      const engine = CanvasEngineLive.make();
      const answer = yield* Effect.promise(() =>
        answerCanvasScreenshot(service, store, engine, workspaceRoot, {
          documentId: input.documentId,
          ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
          ...(input.selector === undefined ? {} : { selector: input.selector }),
          ...(input.region === undefined ? {} : { region: input.region }),
          ...(input.save === undefined ? {} : { save: input.save }),
          // Inlining is opt-out rather than opt-in: this route exists to attach the image, and a
          // caller that wants only the paths is a client that cannot render an image anyway. The
          // ordinary toolkit route never attaches images, so it passes `includeImage: false`.
          includeImageData: input.includeImage !== false,
        }),
      );
      return screenshotResult(answer);
    }),
  ),
});

export const layer = McpToolAccess.toLayer(CanvasToolkit, {
  dak_canvas_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      return yield* service.create({
        title: input.title,
        module: input.module,
        ...(input.preset === undefined ? {} : { preset: input.preset }),
      });
    }),
  ),

  dak_canvas_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      return yield* service.list({
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.includeTrash === undefined ? {} : { includeTrash: input.includeTrash }),
      });
    }),
  ),

  dak_canvas_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      const { summary, document } = yield* service.read({ documentId: input.documentId });
      return outlineOf(summary, document);
    }),
  ),

  /**
   * The screenshot bytes are dropped here rather than returned: `McpServer.toolkit` serializes a
   * result as JSON text, so a PNG inside the structured payload would reach the model as base64 it
   * cannot look at. `screenshots` keeps the metadata (which nodes, what size) and the agent reads
   * the pixels itself with dak_canvas_export, which writes a real file in the project.
   */
  dak_canvas_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      const { screenshotImages: _bytes, ...rest } = yield* service.execute({
        documentId: input.documentId,
        code: input.code,
        ...(input.issueDetail === undefined ? {} : { issueDetail: input.issueDetail }),
      });
      return rest;
    }),
  ),

  dak_canvas_inspect: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      return yield* service.inspect({
        documentId: input.documentId,
        ...(input.selector === undefined ? {} : { selector: input.selector }),
      });
    }),
  ),

  dak_canvas_measure: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      return yield* service.measure({
        documentId: input.documentId,
        ...(input.selectors === undefined ? {} : { selectors: input.selectors }),
      });
    }),
  ),

  dak_canvas_undo: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      const undone = yield* service.undo({
        documentId: input.documentId,
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      });
      return {
        documentId: undone.documentId,
        operationId: undone.operationId,
        sequence: undone.sequence,
        title: yield* readTitle(service, input.documentId),
      };
    }),
  ),

  dak_canvas_trash: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      const trashed = yield* service.trash({
        documentId: input.documentId,
        confirmTitle: input.confirmTitle,
      });
      // The service re-read the title and refused a stale one, so this is the title that was trashed.
      return {
        documentId: input.documentId,
        title: trashed.title,
        trashed: true as const,
      };
    }),
  ),

  dak_canvas_restore: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      yield* service.restore({ documentId: input.documentId });
      return {
        documentId: input.documentId,
        title: yield* readTitle(service, input.documentId),
        restored: true as const,
      };
    }),
  ),

  dak_canvas_export: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireCanvasCapability;
      const caller = yield* readCaller();
      const { service } = yield* forProject(caller, input.projectId);
      return yield* service.extract({
        documentId: input.documentId,
        nodeIds: input.nodeIds,
        format: input.format,
        destination: input.destination,
        ...(input.scale === undefined ? {} : { scale: input.scale }),
      });
    }),
  ),
});
