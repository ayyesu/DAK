// @effect-diagnostics nodeBuiltinImport:off - This renders and writes real files.
import { McpSchema } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { base64ToBytes } from "./bytes.ts";
import {
  CANVAS_SCREENSHOT_MAX_EDGE,
  planSections,
  planScreenshot,
  renderScreenshot,
  type CanvasBox,
  type CanvasScreenshotPart,
} from "./canvasScreenshot.ts";
import { writeScratchScreenshots } from "./canvasScreenshotScratch.ts";
import { absoluteBoxes } from "./canvasText.ts";
import type { CanvasService } from "./CanvasService.ts";
import type { CanvasFailure } from "@dak/contracts";

/**
 * `dak_canvas_screenshot` — the agent's eyes.
 *
 * Registered through the low-level `addTool` rather than `McpServer.toolkit`, because the toolkit
 * serializes a structured result as JSON text and a PNG inside that reaches the model as base64 it
 * cannot look at. `preview_snapshot` in `McpHttpServer.ts` is the same shape and the reason this
 * pattern was already known to work here.
 *
 * Both delivery routes are offered because there are two kinds of harness and the server cannot tell
 * them apart: the image block for a model that can see, and a written file whose path is in the text
 * for a model that cannot. `includeImage: false` takes the second without the first, which is also
 * what a caller uses when it only wants to show the user a picture.
 */

/** The contract, kept here so the schema and the handler cannot drift. */
export const CanvasScreenshotInput = Schema.Struct({
  documentId: Schema.String,
  /** A frame or node id. Omit to shoot the design's first frame. */
  nodeId: Schema.optional(Schema.String),
  /** A Canvas selector: `#id`, `type:frame`, `name:nav`, or a slash-separated path. */
  selector: Schema.optional(Schema.String),
  /** An explicit region in design units, which wins over nodeId and selector. */
  region: Schema.optional(
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
  /** Set false to get only the written paths, for a harness whose model cannot see images. */
  includeImage: Schema.optional(Schema.Boolean),
  /** Write the PNGs into the project workspace and return their paths. Default true. */
  save: Schema.optional(Schema.Boolean),
});

export interface ScreenshotTarget {
  readonly nodeId: string;
  readonly name: string;
  readonly box: CanvasBox;
  readonly boundaries: ReadonlyArray<number>;
}

/** The y of every top-level child's box within the target, which is where sections begin. */
const boundariesOf = (
  document: unknown,
  nodeId: string,
  boxes: ReadonlyMap<string, CanvasBox>,
): ReadonlyArray<number> => {
  const target = boxes.get(nodeId);
  if (target === undefined) return [];
  const boundaries: number[] = [];
  const findChildren = (node: any): ReadonlyArray<any> => node?.children ?? [];
  let node = findChildren(document).find((child) => child?.id === nodeId);
  if (node === undefined) {
    const search = (candidate: any): any =>
      candidate?.id === nodeId ? candidate : findChildren(candidate).map(search).find(Boolean);
    node = search(document);
  }
  for (const child of findChildren(node)) {
    const box = boxes.get(child?.id);
    if (box === undefined) continue;
    const top = box.y - target.y;
    if (top > 0 && top < target.height) boundaries.push(top);
  }
  return boundaries;
};

const resolveTarget = (
  document: unknown,
  input: {
    readonly nodeId?: string | undefined;
    readonly selector?: string | undefined;
    readonly region?: CanvasBox | undefined;
  },
  boxes: ReadonlyMap<string, CanvasBox>,
): ScreenshotTarget => {
  if (input.region !== undefined) {
    return { nodeId: input.nodeId ?? "", name: "region", box: input.region, boundaries: [] };
  }
  const id =
    input.nodeId ??
    (input.selector !== undefined
      ? input.selector
          .replace(/^#|^(?:type|name):/u, "")
          .split("/")
          .pop()
      : undefined);
  const first = (document as { children?: ReadonlyArray<{ id?: string; name?: string }> })
    .children?.[0];
  const nodeId = id ?? first?.id ?? "";
  const box = boxes.get(nodeId) ?? { x: 0, y: 0, width: 390, height: 844 };
  return {
    nodeId,
    name: String(id ?? first?.name ?? "design"),
    box,
    boundaries: boundariesOf(document, nodeId, boxes),
  };
};

const textOf = (value: unknown): string => JSON.stringify(value);

/**
 * Renders one screenshot and answers with an MCP result carrying the images.
 *
 * Kept separate from the tool registration so it can be called directly by a test without a server,
 * and so the registration is a thin shell around something that is already exercised.
 */
export const takeCanvasScreenshot = async (
  service: CanvasService["Service"],
  store: {
    getDocumentForExecution: (
      id: string,
    ) => Promise<{ summary: { id: string; title: string }; payload: never }>;
  },
  engine: { renderRegion: (input: never) => Promise<never> },
  workspaceRoot: string,
  input: {
    readonly documentId: string;
    readonly nodeId?: string | undefined;
    readonly selector?: string | undefined;
    readonly region?: CanvasBox | undefined;
    readonly includeImage?: boolean | undefined;
    readonly save?: boolean | undefined;
  },
): Promise<McpSchema.CallToolResult> => {
  const { payload, summary } = await store.getDocumentForExecution(input.documentId);
  // `service.read` is an Effect; the normalized document is what every other reader uses, so a
  // screenshot is cut from the same geometry the panel is showing.
  const read = await Effect.runPromise(
    (
      service.read({ documentId: input.documentId }) as Effect.Effect<
        { document: unknown },
        CanvasFailure
      >
    ).pipe(Effect.orDie),
  );
  const document = read.document;
  const boxes = absoluteBoxes(document);
  const target = resolveTarget(document, input, boxes);

  const parts: ReadonlyArray<CanvasScreenshotPart> = await renderScreenshot(
    engine as never,
    payload,
    target,
  );

  const saved =
    input.save === false
      ? { paths: [] as ReadonlyArray<string> }
      : await writeScratchScreenshots(workspaceRoot, input.documentId, parts);

  const summaryText = {
    document: summary.title,
    target: target.name,
    parts: parts.map((part) => ({
      role: part.role,
      y: Math.round(part.y),
      designHeight: Math.round(part.height),
      width: part.image.width,
      height: part.image.height,
      ...(saved.paths[parts.indexOf(part)] === undefined
        ? {}
        : { path: saved.paths[parts.indexOf(part)] }),
    })),
    ...(saved.error === undefined ? {} : { scratchError: saved.error }),
  };

  const content: McpSchema.CallToolResult["content"] = [
    {
      type: "text",
      text:
        `${parts.length} image(s) for ${target.name}: ` +
        parts
          .map(
            (part) =>
              `${part.role} ${part.image.width}x${part.image.height}` +
              (saved.paths[parts.indexOf(part)] === undefined
                ? ""
                : ` at ${saved.paths[parts.indexOf(part)]}`),
          )
          .join("; ") +
        ". If you cannot see the attached images, open the paths above with your file tools. " +
        textOf(summaryText),
    },
    ...(input.includeImage === false
      ? []
      : parts.map((part) => ({
          type: "image" as const,
          data: base64ToBytes(part.image.data),
          mimeType: part.image.mimeType,
        }))),
  ];

  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: summaryText,
    content,
  });
};

export { CANVAS_SCREENSHOT_MAX_EDGE, planScreenshot, planSections };
