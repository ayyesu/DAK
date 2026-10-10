import {
  computeAllLayouts,
  createSVGNodesFromImport,
  prepareSVGImport,
  vectorNetworkToSVGPaths,
} from "../vendor/open-pencil/engine.source.mjs";
import { isSvgAsset } from "./document-assets.mjs";

const RENDER_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse",
  "line", "polygon", "polyline", "lineargradient", "radialgradient", "stop",
  "metadata", "title", "desc",
]);
const IGNORED_ELEMENTS = new Set(["metadata", "title", "desc"]);
const CONVERSION_RISK_ATTRIBUTES = [
  "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end",
  "opacity", "fill-opacity", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset",
  "stroke-miterlimit", "vector-effect", "paint-order", "display", "visibility", "class",
];

export function inspectSvgVectorSupport(bytes) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return supportResult(null, ["invalid UTF-8"], ["invalid UTF-8"]);
  }
  const elementNames = [...source.matchAll(/<\s*([A-Za-z][\w:.-]*)\b/gu)]
    .map((match) => match[1].split(":").at(-1).toLowerCase())
    .filter((name) => !IGNORED_ELEMENTS.has(name));
  const unsupportedElements = [...new Set(elementNames.filter((name) => !RENDER_ELEMENTS.has(name)))];
  const renderIssues = unsupportedElements.map((name) => `unsupported <${name}> element`);
  if (/<\s*style\b/iu.test(source)) renderIssues.push("stylesheet rules are not supported");
  if (/\b(?:href|xlink:href)\s*=\s*["'](?!#)/iu.test(source)) {
    renderIssues.push("external references are not supported");
  }
  const conversionIssues = [...renderIssues];
  for (const attribute of CONVERSION_RISK_ATTRIBUTES) {
    const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`(?:\\b${escaped}\\s*=|${escaped}\\s*:)`, "iu").test(source)) {
      conversionIssues.push(`${attribute} is not editable without loss`);
    }
  }
  return supportResult(source, renderIssues, [...new Set(conversionIssues)]);
}

export function inspectSvgVectorCandidate(node, assets = new Map()) {
  const fills = (Array.isArray(node?.fill) ? node.fill : [node?.fill]).filter(Boolean);
  if (fills.length !== 1 || fills[0]?.type !== "image" || typeof fills[0].url !== "string") return null;
  const asset = assets.get(fills[0].url);
  if (!isSvgAsset(asset)) return null;
  return { asset, fill: fills[0], support: inspectSvgVectorSupport(asset.bytes) };
}

function supportResult(source, renderIssues, conversionIssues) {
  return {
    source,
    renderSupported: renderIssues.length === 0,
    conversionSupported: conversionIssues.length === 0,
    renderIssues,
    conversionIssues,
  };
}

export function registerSvgVectorAsset(graph, asset, state = {}) {
  if (!isSvgAsset(asset) || graph.vectorImages.has(asset.sha256)) {
    return graph.vectorImages.get(asset.sha256) ?? null;
  }
  const support = inspectSvgVectorSupport(asset.bytes);
  if (!support.renderSupported) return null;
  const imported = prepareSVGImport(support.source);
  if (!imported || imported.width <= 0 || imported.height <= 0) return null;
  let page = state.page;
  if (!page) {
    page = graph.addPage("Canvas SVG assets");
    graph.updateNode(page.id, { internalOnly: true });
    state.page = page;
  }
  const node = createSVGNodesFromImport(graph, page.id, imported, {
    name: `SVG ${asset.sha256.slice(0, 12)}`,
  });
  if (!node) return null;
  const record = { nodeId: node.id, width: imported.width, height: imported.height };
  graph.vectorImages.set(asset.sha256, record);
  return record;
}

export function finalizeSvgVectorAssets(graph, state = {}) {
  if (state.page) computeAllLayouts(graph, state.page.id);
}

export function convertSvgAssetToCanvasNode({ sourceNode, asset, createdId, usedIds = new Set() }) {
  if (!isSvgAsset(asset)) throw svgConversionError("The selected image is not an SVG asset.");
  const support = inspectSvgVectorSupport(asset.bytes);
  if (!support.conversionSupported) {
    throw svgConversionError(
      `SVG conversion would lose ${support.conversionIssues.join(", ")}.`,
      support.conversionIssues,
    );
  }
  const imported = prepareSVGImport(support.source);
  if (!imported || imported.paths.length === 0) {
    throw svgConversionError("The SVG did not contain supported visible vector geometry.");
  }
  const fill = onlyImageFill(sourceNode);
  if (fill.mode === "tile") throw svgConversionError("Tiled SVG fills cannot be converted in place without loss.", ["tile fill"]);
  const width = finiteSize(sourceNode.width, imported.width);
  const height = finiteSize(sourceNode.height, imported.height);
  const placement = imagePlacement(fill.mode, width, height, imported.width, imported.height);
  usedIds.add(createdId);
  const children = imported.paths.map((path, index) => vectorPathNode({
    path,
    index,
    rootId: createdId,
    usedIds,
    placement,
    sourceWidth: imported.width,
    sourceHeight: imported.height,
  }));
  return {
    id: createdId,
    type: "frame",
    name: `${sourceNode.name ?? "SVG"} — Editable`,
    x: Number(sourceNode.x ?? 0),
    y: Number(sourceNode.y ?? 0),
    width,
    height,
    layout: "none",
    clip: fill.mode === "fill" || Boolean(sourceNode.clip) || Number(sourceNode.cornerRadius ?? 0) > 0,
    ...(sourceNode.rotation !== undefined ? { rotation: sourceNode.rotation } : {}),
    ...(sourceNode.opacity !== undefined ? { opacity: sourceNode.opacity } : {}),
    ...(sourceNode.enabled !== undefined ? { enabled: sourceNode.enabled } : {}),
    ...(sourceNode.flipX !== undefined ? { flipX: sourceNode.flipX } : {}),
    ...(sourceNode.flipY !== undefined ? { flipY: sourceNode.flipY } : {}),
    ...(sourceNode.cornerRadius !== undefined ? { cornerRadius: sourceNode.cornerRadius } : {}),
    ...(sourceNode.effect !== undefined ? { effect: structuredClone(sourceNode.effect) } : {}),
    children,
  };
}

export function applySvgConversionRequests(document, requests = [], assets = new Map()) {
  const usedIds = new Set();
  walkNodes(document.children, (node) => usedIds.add(node.id));
  const results = [];
  for (const request of requests) {
    const entry = findNodeEntry(document.children, request.sourceNodeId);
    if (!entry) throw svgConversionError(`SVG source node ${request.sourceNodeId} no longer exists.`);
    const fill = onlyImageFill(entry.node);
    const asset = assets.get(fill.url);
    if (!asset) throw svgConversionError(`SVG asset ${fill.url} is not loaded.`);
    if (request.mode === "replace") usedIds.delete(entry.node.id);
    const converted = convertSvgAssetToCanvasNode({
      sourceNode: entry.node,
      asset,
      createdId: request.createdId,
      usedIds,
    });
    if (request.mode === "copy") {
      converted.x = Number(converted.x ?? 0) + Number(request.offset ?? 24);
      converted.y = Number(converted.y ?? 0) + Number(request.offset ?? 24);
      entry.siblings.splice(entry.index + 1, 0, converted);
    } else {
      entry.siblings.splice(entry.index, 1, converted);
    }
    results.push({
      sourceNodeId: request.sourceNodeId,
      createdNodeId: converted.id,
      shapeCount: converted.children.length,
      mode: request.mode,
      fidelity: "exact",
      warnings: [],
    });
  }
  return results;
}

function onlyImageFill(node) {
  const fills = (Array.isArray(node.fill) ? node.fill : [node.fill]).filter(Boolean);
  const images = fills.filter((fill) => fill?.type === "image");
  if (images.length !== 1 || fills.length !== 1 || typeof images[0].url !== "string") {
    throw svgConversionError("Convert to editable vectors requires one SVG image fill and no additional fills.");
  }
  return images[0];
}

function walkNodes(nodes = [], visitor) {
  for (const node of nodes) {
    visitor(node);
    walkNodes(node.children ?? [], visitor);
  }
}

function findNodeEntry(nodes = [], id) {
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index].id === id) return { node: nodes[index], siblings: nodes, index };
    const nested = findNodeEntry(nodes[index].children ?? [], id);
    if (nested) return nested;
  }
  return null;
}

function finiteSize(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function imagePlacement(mode, width, height, sourceWidth, sourceHeight) {
  if (mode === "stretch") return { x: 0, y: 0, width, height, strokeScale: Math.min(width / sourceWidth, height / sourceHeight) };
  const scale = (mode === "fit" ? Math.min : Math.max)(width / sourceWidth, height / sourceHeight);
  const placedWidth = sourceWidth * scale;
  const placedHeight = sourceHeight * scale;
  return {
    x: (width - placedWidth) / 2,
    y: (height - placedHeight) / 2,
    width: placedWidth,
    height: placedHeight,
    strokeScale: scale,
  };
}

function vectorPathNode({ path, index, rootId, usedIds, placement, sourceWidth, sourceHeight }) {
  const id = uniqueId(`${rootId}-path-${index + 1}`, usedIds);
  const geometry = vectorNetworkToSVGPaths(path.vectorNetwork, null).join("");
  const fill = path.fills[0] ? canvasPaint(path.fills[0]) : undefined;
  const stroke = path.strokes[0];
  return {
    id,
    type: "path",
    name: `Path ${index + 1}`,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    geometry,
    viewBox: [0, 0, sourceWidth, sourceHeight],
    fillRule: path.vectorNetwork.regions.some((region) => region.windingRule === "EVENODD")
      ? "evenodd"
      : "nonzero",
    ...(fill !== undefined ? { fill } : {}),
    ...(stroke ? {
      stroke: {
        fill: colorPaint(stroke.color, stroke.opacity),
        thickness: Number(stroke.weight ?? 1) * placement.strokeScale,
        align: "center",
        cap: ({ NONE: "none", ROUND: "round", SQUARE: "square" })[stroke.cap] ?? "none",
        join: ({ MITER: "miter", ROUND: "round", BEVEL: "bevel" })[stroke.join] ?? "miter",
      },
    } : {}),
  };
}

function canvasPaint(fill) {
  if (fill.type === "SOLID") return colorPaint(fill.color, fill.opacity);
  if (fill.type === "GRADIENT_LINEAR") return gradientPaint(fill, "linear");
  if (fill.type === "GRADIENT_RADIAL") return gradientPaint(fill, "radial");
  throw svgConversionError(`The SVG contains an unsupported ${fill.type} paint.`, [fill.type]);
}

function colorPaint(color, opacity = 1) {
  return {
    type: "color",
    color: rgbaHex(color),
    opacity: Number(opacity ?? 1),
  };
}

function gradientPaint(fill, gradientType) {
  const transform = fill.gradientTransform;
  if (!transform) throw svgConversionError("The SVG gradient has no usable transform.", ["gradient transform"]);
  const colors = (fill.gradientStops ?? []).map((stop) => ({
    color: rgbaHex(stop.color),
    position: Number(stop.position),
  }));
  if (colors.length === 0) throw svgConversionError("The SVG gradient has no color stops.", ["gradient stops"]);
  if (gradientType === "linear") {
    const dx = Number(transform.m00);
    const dy = Number(transform.m10);
    return {
      type: "gradient",
      gradientType,
      colors: [...colors].reverse().map((stop) => ({ ...stop, position: 1 - stop.position })),
      center: { x: Number(transform.m02) + dx / 2, y: Number(transform.m12) + dy / 2 },
      size: { width: 1, height: Math.hypot(dx, dy) },
      rotation: Math.atan2(dx, dy) * 180 / Math.PI,
    };
  }
  const width = Math.hypot(Number(transform.m00), Number(transform.m10)) * 2;
  const height = Math.hypot(Number(transform.m01), Number(transform.m11)) * 2;
  return {
    type: "gradient",
    gradientType,
    colors,
    center: { x: Number(transform.m02), y: Number(transform.m12) },
    size: { width, height },
    rotation: Math.atan2(Number(transform.m10), Number(transform.m00)) * 180 / Math.PI,
  };
}

function rgbaHex(color = {}) {
  return `#${[color.r, color.g, color.b, color.a ?? 1]
    .map((value) => Math.max(0, Math.min(255, Math.round(Number(value ?? 0) * 255))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function uniqueId(base, usedIds) {
  let id = base;
  let suffix = 1;
  while (usedIds.has(id)) id = `${base}-${++suffix}`;
  usedIds.add(id);
  return id;
}

function svgConversionError(message, unsupported = []) {
  const error = new Error(message);
  error.code = "CANVAS_SVG_CONVERSION_INCOMPLETE";
  error.unsupported = unsupported;
  return error;
}
