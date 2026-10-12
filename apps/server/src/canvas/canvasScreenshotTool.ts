// @effect-diagnostics nodeBuiltinImport:off - This writes screenshot scratch files to disk.
import { base64ToBytes } from "./bytes.ts";
import {
  CANVAS_SCREENSHOT_MAX_EDGE,
  planScreenshot,
  planSections,
  renderScreenshot,
  type CanvasBox,
} from "./canvasScreenshot.ts";
import * as Effect from "effect/Effect";
import { writeScratchScreenshots } from "./canvasScreenshotScratch.ts";
import { absoluteBoxes } from "./canvasText.ts";
import { narrowToSelector } from "./canvasInspect.ts";
import type { CanvasService } from "./CanvasService.ts";
import type { CanvasEngine, CanvasStore } from "./CanvasPorts.ts";

/**
 * What `dak_canvas_screenshot` answers with, as data.
 *
 * Step A of two. This writes the PNGs and returns their paths as ordinary JSON, which needs no
 * special MCP registration and therefore already works. Step B attaches the same bytes as image
 * blocks so a model that can see does not have to open a file. Both halves come from this one
 * function, so the two can never disagree about what was captured.
 *
 * The paths are in the answer either way, because not every harness passes image content through to
 * the model, and there is no way to tell from inside the server which kind is on the other end.
 */
export interface CanvasScreenshotAnswerShape {
  readonly documentId: string;
  readonly target: string;
  readonly nodeId: string;
  readonly bounds: CanvasBox;
  readonly scale: number;
  readonly tall: boolean;
  /** How many sections this frame needs in total, so a caller can tell how many pages there are. */
  readonly totalSections: number;
  /** The next `sectionIndex` to ask for. Absent when this was the last page. */
  readonly nextSectionIndex?: number;
  readonly parts: ReadonlyArray<{
    readonly role: "overview" | "section";
    readonly y: number;
    readonly height: number;
    readonly width: number;
    readonly heightPx: number;
    readonly mimeType: "image/png";
    readonly path?: string;
    /** Base64 PNG, present only when the caller asked for it. */
    readonly data?: string;
  }>;
  readonly maxEdge: number;
}

const nodeById = (document: unknown, id: string): Record<string, unknown> | undefined => {
  const search = (node: any): Record<string, unknown> | undefined => {
    if (node?.id === id) return node;
    for (const child of (node?.children ?? []) as ReadonlyArray<unknown>) {
      const found = search(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const child of (document as { children?: unknown[] }).children ?? []) {
    const found = search(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * The y of every section-like child inside the target, in target-relative units.
 *
 * Only children that are frames, or that carry a role or a name, count as section boundaries. Every
 * child of a frame has an offset, and treating all of them as boundaries cut a page into dozens of
 * unusable slivers.
 */
const sectionBoundaries = (
  document: unknown,
  nodeId: string,
  boxes: ReadonlyMap<string, CanvasBox>,
): ReadonlyArray<number> => {
  const target = boxes.get(nodeId);
  if (target === undefined) return [];
  const node = nodeById(document, nodeId);
  const boundaries: number[] = [];
  for (const child of (node?.children ?? []) as ReadonlyArray<Record<string, unknown>>) {
    if (typeof child.id !== "string") continue;
    const isSection =
      child.type === "frame" ||
      child.role !== undefined ||
      (typeof child.name === "string" && child.name.length > 0);
    if (!isSection) continue;
    const box = boxes.get(child.id);
    if (box === undefined) continue;
    const top = box.y - target.y;
    if (top > 0 && top < target.height) boundaries.push(top);
  }
  return boundaries;
};

export interface ScreenshotRequest {
  readonly documentId: string;
  readonly nodeId?: string | undefined;
  readonly selector?: string | undefined;
  readonly region?: CanvasBox | undefined;
  /** False to skip writing; the parts are still returned with their dimensions. */
  readonly save?: boolean | undefined;
  /**
   * True to inline each PNG as base64 alongside its path. Off by default: it doubles the answer's
   * size, and only a caller that attaches MCP image blocks needs it. The bytes are taken from what
   * was just rendered, so an inlined image and the file at `path` are the same picture.
   */
  readonly includeImageData?: boolean | undefined;
  /**
   * Which page of sections to return, for a frame too tall for one call. Omitted is the first page;
   * the answer carries `nextSectionIndex` when there is more.
   */
  readonly sectionIndex?: number | undefined;
}

export const answerCanvasScreenshot = async (
  service: CanvasService["Service"],
  store: CanvasStore,
  engine: CanvasEngine,
  workspaceRoot: string,
  request: ScreenshotRequest,
): Promise<CanvasScreenshotAnswerShape> => {
  // Read through the store first so a design that has been trashed or removed fails here, with the
  // service's own error, rather than part-way through rendering.
  await store.getDocumentForExecution(request.documentId);
  // `service.read` is an Effect; going through it means the document is the one the agent's own
  // edit path would produce, rather than a second reading that could disagree.
  const read = await Effect.runPromise(
    service.read({ documentId: request.documentId }).pipe(Effect.orDie),
  );
  const document = read.document;
  const boxes = absoluteBoxes(document);

  // An explicit region wins over a node, and a node over a selector, so a caller that knows exactly
  // which part it wants is never second-guessed by the first frame in the document.
  let nodeId = request.nodeId ?? "";
  if (request.selector !== undefined && nodeId === "") {
    const narrowed = narrowToSelector(document, request.selector);
    nodeId = String((narrowed as { id?: unknown }).id ?? nodeId);
  }
  if (nodeId === "") {
    nodeId = String(
      (document as { children?: ReadonlyArray<{ id?: string }> }).children?.[0]?.id ?? "",
    );
  }
  const frame = nodeById(document, nodeId) ?? {};
  const box = boxes.get(nodeId) ?? {
    x: 0,
    y: 0,
    width: Number(frame.width ?? 390),
    height: Number(frame.height ?? 844),
  };
  const target: CanvasBox =
    request.region === undefined
      ? box
      : {
          x: request.region.x + box.x,
          y: request.region.y + box.y,
          width: request.region.width,
          height: request.region.height,
        };

  // A selector or a region means the caller asked about one specific piece, so that piece gets the
  // full upscale budget; a whole frame does not, because its slice count does.
  const targeted =
    request.region !== undefined ||
    (request.selector !== undefined && request.nodeId === undefined);

  const { parts, nextSectionIndex, totalSections } = await renderScreenshot(
    {
      renderRegion: (input) =>
        Effect.runPromise(
          // The service's render rather than the engine's: it is the one that refuses an oversized
          // region with a readable failure instead of letting the engine's throw escape.
          service
            .renderRegion({
              documentId: request.documentId,
              nodeId: input.nodeId,
              bounds: input.bounds,
              ...(input.scale === undefined ? {} : { scale: input.scale }),
              ...(input.maxEdge === undefined ? {} : { maxEdge: input.maxEdge }),
            })
            .pipe(Effect.orDie),
        ),
    },
    undefined as never,
    {
      nodeId,
      box: target,
      boundaries: sectionBoundaries(document, nodeId, boxes),
      targeted,
      ...(request.sectionIndex === undefined ? {} : { sectionIndex: request.sectionIndex }),
    },
  );

  const saved =
    request.save === false
      ? { paths: [] as ReadonlyArray<string> }
      : await writeScratchScreenshots(workspaceRoot, request.documentId, parts);

  return {
    documentId: request.documentId,
    target: String(frame.name ?? nodeId),
    nodeId,
    bounds: target,
    scale: planScreenshot(target, { targeted }).scale,
    tall: parts.length > 1,
    totalSections,
    ...(nextSectionIndex === undefined ? {} : { nextSectionIndex }),
    maxEdge: CANVAS_SCREENSHOT_MAX_EDGE,
    parts: parts.map((part, index) => ({
      role: part.role,
      y: Math.round(part.y),
      height: Math.round(part.height),
      width: part.image.width,
      heightPx: part.image.height,
      mimeType: part.image.mimeType,
      ...(saved.paths[index] === undefined ? {} : { path: saved.paths[index] }),
      ...(request.includeImageData === true ? { data: part.image.data } : {}),
    })),
  };
};
