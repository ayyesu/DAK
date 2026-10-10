import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  computeAllLayouts,
  computeDescendantVisualBounds,
  createCanvasSceneGraph,
  createSVGNodesFromImport,
  fontManager,
  getCanvasKit,
  getWorldMatrix,
  prepareSVGImport,
  SkiaRenderer,
} from "../vendor/open-pencil/engine.source.mjs";
import { createOpenPencilGraph } from "./openpencil-engine.mjs";
import { ensurePencilDocumentIconCatalogs } from "./pencil-icon-provider.mjs";
import { configureCanvasFonts } from "./font-runtime.mjs";
import { collectPencilDocumentFonts } from "./pencil-resources.mjs";

const MAX_SCREENSHOT_DIMENSION = 2048;
const MAX_SVG_RASTER_DIMENSION = 4096;
const BUNDLED_FONT_FILES = new Map([
  ["Inter|Regular", "Inter-Regular.ttf"],
  ["Inter|Medium", "Inter-Medium.ttf"],
  ["Inter|SemiBold", "Inter-SemiBold.ttf"],
  ["Inter|Bold", "Inter-Bold.ttf"],
  ["Inter|ExtraBold", "Inter-ExtraBold.ttf"],
  ["JetBrains Mono|Regular", "jetbrains-mono-400.woff2"],
  ["JetBrains Mono|Medium", "jetbrains-mono-500.woff2"],
  ["Material Symbols Outlined|Regular", "material-symbols-outlined.woff2"],
  ["Material Symbols Rounded|Regular", "material-symbols-rounded.woff2"],
  ["Material Symbols Sharp|Regular", "material-symbols-sharp.woff2"],
  ["Noto Color Emoji|Regular", "NotoColorEmoji.ttf"],
]);
let fontsConfigured = false;
let canvasKitWasmPath;

export async function takeDocumentScreenshots(document, requests, assets = new Map(), options = {}) {
  if (requests.length === 0) return [];
  await ensurePencilDocumentIconCatalogs(document);
  configureScreenshotFonts();
  for (const font of collectPencilDocumentFonts(document, assets)) {
    fontManager.registerDocumentFont(font.family, font.bytes);
  }
  const graph = createOpenPencilGraph(document, assets);
  const page = graph.getPages()[0];
  if (!page) throw screenshotError("CANVAS_SCREENSHOT_EMPTY", "The Canvas document has no page.");
  const screenshots = [];
  for (const request of requests) {
    screenshots.push(await renderScreenshot(graph, page.id, request.nodeIds, options, request.bounds));
  }
  return screenshots;
}

export async function rasterizeSvgImage(bytes, options = {}) {
  configureScreenshotFonts();
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw screenshotError("CANVAS_IMAGE_SVG_INVALID", "The SVG image is not valid UTF-8.");
  }
  const imported = prepareSVGImport(source);
  if (!imported || imported.width <= 0 || imported.height <= 0) {
    throw screenshotError("CANVAS_IMAGE_SVG_INVALID", "Canvas could not parse visible SVG geometry.");
  }
  const graph = createCanvasSceneGraph({ version: "2.15", children: [] });
  const page = graph.getPages()[0];
  if (!page) throw screenshotError("CANVAS_SCREENSHOT_EMPTY", "Canvas could not create an SVG render page.");
  const node = createSVGNodesFromImport(graph, page.id, imported, { name: "Imported SVG" });
  if (!node) {
    throw screenshotError("CANVAS_IMAGE_SVG_INVALID", "Canvas could not create renderable SVG geometry.");
  }
  computeAllLayouts(graph, page.id);
  const maxDimension = options.maxDimension ?? MAX_SVG_RASTER_DIMENSION;
  const scale = Math.min(1, maxDimension / Math.max(imported.width, imported.height));
  const width = Math.max(1, Math.ceil(imported.width * scale));
  const height = Math.max(1, Math.ceil(imported.height * scale));
  return withPreparedRenderer(graph, page.id, [node.id], (renderer, ck) => {
    const surface = ck.MakeSurface(width, height);
    if (!surface) {
      throw screenshotError("CANVAS_SCREENSHOT_FAILED", "CanvasKit could not allocate an SVG raster surface.");
    }
    renderer.replaceSurface(surface);
    renderer.pageId = page.id;
    renderer.worldViewport = { x: 0, y: 0, w: imported.width, h: imported.height };
    const canvas = surface.getCanvas();
    canvas.clear(ck.TRANSPARENT);
    canvas.scale(scale, scale);
    renderer.renderNode(canvas, graph, node.id, {}, 0, 0);
    surface.flush();
    const image = surface.makeImageSnapshot();
    try {
      const encoded = image.encodeToBytes(ck.ImageFormat.PNG, 100);
      if (!encoded) {
        throw screenshotError("CANVAS_SCREENSHOT_FAILED", "CanvasKit could not encode the SVG raster as PNG.");
      }
      return new Uint8Array(encoded);
    } finally {
      image.delete();
    }
  });
}

function configureScreenshotFonts() {
  if (fontsConfigured) return;
  fontsConfigured = true;
  if (globalThis.penkra?.network?.fetch) {
    configureCanvasFonts(globalThis.penkra, { cache: null });
  }
  fontManager.setHostFontLoader(async (family, style) => {
    const file = BUNDLED_FONT_FILES.get(`${family}|${style}`);
    if (!file) return null;
    for (const url of [
      new URL(`./${file}`, import.meta.url),
      new URL(`../vendor/open-pencil/fonts/${file}`, import.meta.url),
    ]) {
      try {
        const bytes = await readFile(url);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return null;
  });
}

async function withPreparedRenderer(graph, pageId, nodeIds, visit) {
  for (const nodeId of nodeIds) {
    if (!graph.getNode(nodeId)) {
      throw screenshotError("CANVAS_SCREENSHOT_NODE_NOT_FOUND", `Canvas node ${nodeId} is unavailable to the renderer.`);
    }
  }
  // CanvasKit's generated Node loader otherwise resolves its WASM beside the
  // package-manager source file that Bun bundled. That path is both outside an
  // installed App and unavailable to Penkra's operation controller.
  const wasmPath = await resolveCanvasKitWasmPath();
  const ck = await getCanvasKit({
    locateFile: () => wasmPath,
  });
  const initialSurface = ck.MakeSurface(1, 1);
  if (!initialSurface) {
    throw screenshotError("CANVAS_SCREENSHOT_FAILED", "CanvasKit could not create a screenshot surface.");
  }
  const renderer = new SkiaRenderer(ck, initialSurface, null);
  let restoreTextMeasurer = null;
  try {
    await renderer.loadFonts();
    restoreTextMeasurer = await renderer.prepareForExport(graph, pageId, nodeIds);
    return await visit(renderer, ck);
  } finally {
    restoreTextMeasurer?.();
    renderer.destroy();
  }
}

// Use the same fonts, line breaking, shaping and half-leading as the visible
// Canvas renderer. Consumers receive plain values, never live WASM objects.
export async function measureDocumentText(document, nodeIds, assets = new Map()) {
  await ensurePencilDocumentIconCatalogs(document);
  configureScreenshotFonts();
  for (const font of collectPencilDocumentFonts(document, assets)) {
    fontManager.registerDocumentFont(font.family, font.bytes);
  }
  const graph = createOpenPencilGraph(document, assets);
  const page = graph.getPages()[0];
  if (!page) throw screenshotError("CANVAS_SCREENSHOT_EMPTY", "The Canvas document has no page.");
  return withPreparedRenderer(graph, page.id, nodeIds, (renderer) => {
    const result = new Map();
    const fontHashes = Object.fromEntries([...BUNDLED_FONT_FILES.keys()].flatMap((key) => {
      const [family, style] = key.split("|");
      const bytes = fontManager.loadedData(family, style);
      return bytes ? [[key, createHash("sha256").update(new Uint8Array(bytes)).digest("hex")]] : [];
    }));
    for (const id of nodeIds) {
      const node = graph.getNode(id);
      if (node.type !== "TEXT") continue;
      const paragraph = renderer.buildParagraph(node, undefined, { halfLeading: true });
      try {
        const available = Math.max(0, node.height - paragraph.getHeight());
        const offsetY = node.textAlignVertical === "CENTER" ? available / 2 : node.textAlignVertical === "BOTTOM" ? available : 0;
        result.set(id, {
          width: node.width, height: node.height, offsetY, fontHashes,
          lines: paragraph.getShapedLines().map((line) => ({
            baseline: line.baseline, top: line.top, bottom: line.bottom,
            runs: line.runs.map((run) => ({
              size: run.size, fakeBold: run.fakeBold, fakeItalic: run.fakeItalic,
              glyphs: Array.from(run.glyphs), positions: Array.from(run.positions), offsets: Array.from(run.offsets),
            })),
          })),
        });
      } finally { paragraph.delete(); }
    }
    return { graph, textLayouts: result };
  });
}

async function renderScreenshot(graph, pageId, nodeIds, options = {}, requestedBounds = null) {
  return withPreparedRenderer(graph, pageId, nodeIds, async (renderer, ck) => {
    const bounds = requestedBounds ?? computeDescendantVisualBounds(
      nodeIds,
      (id) => graph.getNode(id) ?? undefined,
      (id) => graph.getAbsolutePosition(id),
    );
    if (!bounds) {
      throw screenshotError("CANVAS_SCREENSHOT_EMPTY", "The selected Canvas nodes have no visible content.");
    }
    const sourceWidth = Math.max(1, bounds.maxX - bounds.minX);
    const sourceHeight = Math.max(1, bounds.maxY - bounds.minY);
    const maxDimension = options.maxDimension ?? MAX_SCREENSHOT_DIMENSION;
    const requestedScale = options.scale ?? 1;
    const scale = Math.min(requestedScale, maxDimension / Math.max(sourceWidth, sourceHeight));
    if (options.failOnDownscale === true && scale < requestedScale) {
      throw screenshotError(
        "CANVAS_SCREENSHOT_RESOLUTION_LIMIT",
        `Requested scale ${requestedScale} exceeds the ${maxDimension}px raster limit.`,
      );
    }
    const width = Math.max(1, Math.ceil(sourceWidth * scale));
    const height = Math.max(1, Math.ceil(sourceHeight * scale));
    const surface = ck.MakeSurface(width, height);
    if (!surface) {
      throw screenshotError("CANVAS_SCREENSHOT_FAILED", "CanvasKit could not allocate the screenshot surface.");
    }
    renderer.replaceSurface(surface);
    renderer.pageId = pageId;
    renderer.worldViewport = {
      x: bounds.minX,
      y: bounds.minY,
      w: sourceWidth,
      h: sourceHeight,
    };
    const canvas = surface.getCanvas();
    canvas.clear(ck.TRANSPARENT);
    canvas.scale(scale, scale);
    canvas.translate(-bounds.minX, -bounds.minY);
    for (const nodeId of nodeIds) {
      const node = graph.getNode(nodeId);
      const parent = node.parentId ? graph.getNode(node.parentId) : null;
      const parentAbsolute = parent ? graph.getAbsolutePosition(parent.id) : { x: 0, y: 0 };
      canvas.save();
      if (parent) canvas.concat(getWorldMatrix(parent, graph));
      renderer.renderNode(canvas, graph, nodeId, {}, parentAbsolute.x, parentAbsolute.y);
      canvas.restore();
    }
    surface.flush();
    const image = surface.makeImageSnapshot();
    try {
      const bytes = image.encodeToBytes(ck.ImageFormat.PNG, 100);
      if (!bytes) {
        throw screenshotError("CANVAS_SCREENSHOT_FAILED", "CanvasKit could not encode the screenshot as PNG.");
      }
      return {
        nodeIds,
        width,
        height,
        mimeType: "image/png",
        data: Buffer.from(bytes).toString("base64"),
      };
    } finally {
      image.delete();
    }
  });
}

async function resolveCanvasKitWasmPath() {
  if (canvasKitWasmPath) return canvasKitWasmPath;
  // Builds place the asset beside this module. Source tests use the declared
  // dependency directly; neither path depends on the caller's working directory.
  const candidates = [
    new URL("./canvaskit.wasm", import.meta.url),
    new URL("../node_modules/canvaskit-wasm/bin/canvaskit.wasm", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      canvasKitWasmPath = fileURLToPath(candidate);
      return canvasKitWasmPath;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw screenshotError(
    "CANVAS_SCREENSHOT_RUNTIME_UNAVAILABLE",
    "CanvasKit is missing from this Canvas installation.",
  );
}

function screenshotError(code, message) {
  return Object.assign(new Error(message), { code });
}
