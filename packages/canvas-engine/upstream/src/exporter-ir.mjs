import { capabilityTableFor, extractionEmissionSupport } from "./capability-tables.mjs";
import { isCascade, resolveCanvasDocument } from "./canvas-resolver.mjs";
import { createOpenPencilGraph } from "./openpencil-engine.mjs";
import { computeDescendantVisualBounds, getAbsolutePositionFull } from "../vendor/open-pencil/engine.source.mjs";
import { flattenMarks } from "./rich-text.mjs";
import { rasterPolicyFor } from "./raster-policy.mjs";
import { vectorForNode } from "./vector-path.mjs";

const CAPABILITY_VERIFICATION = Symbol("canvas-capability-verification");
const MEASURED_PDF_TEXT_PATHS = new Set(["properties.textAlign", "properties.textAlignVertical", "properties.textGrowth", "properties.lineHeight", "properties.letterSpacing", "properties.text.run.letterSpacing", "properties.text.paragraph.align"]);

export function buildCapabilityVerificationIR(document, request, assumedNativePaths) {
  if (!Array.isArray(assumedNativePaths) || assumedNativePaths.some((path) => typeof path !== "string")) {
    throw new TypeError("Capability verification requires an explicit array of property paths.");
  }
  const build = request.nodeId === undefined ? buildExporterIR : buildExtractionIR;
  return build(document, { ...request, [CAPABILITY_VERIFICATION]: new Set(assumedNativePaths) });
}

export function buildExporterIR(document, request) {
  if (!["slide", "route", "ios", "android"].includes(request.role)) throw exportError("CANVAS_EXPORT_ROLE", `No deliverable exporter exists for role ${request.role}; PDF uses extraction.`);
  const format = { slide: "pptx", route: "html", ios: "swift", android: "kotlin" }[request.role];
  const capability = capabilityTableFor(format);
  if (!capability) throw exportError("CANVAS_EXPORT_ROLE", `No exporter exists for role ${request.role}.`);
  const projection = request.projection ?? (["route", "ios", "android"].includes(request.role) ? "semantic" : "resolved");
  const resolved = resolveCanvasDocument(document, { modes: request.modes, bindings: request.bindings, imports: request.imports });
  const graph = request.preparedText?.graph ?? createOpenPencilGraph(resolved.document);
  const sourceById = indexNodes(resolved.document.children);
  const authoredById = projection === "semantic" ? indexNodes(document.children) : sourceById;
  const documentPaths = documentCapabilityPaths(resolved.document, request.role);
  const verification = request[CAPABILITY_VERIFICATION] ?? null;
  const outputs = request.frames.map((frameId, index) => {
    const frame = sourceById.get(frameId);
    if (!frame) throw exportError("CANVAS_EXPORT_FRAME", `Frame ${frameId} was not found.`);
    if (frame.role !== request.role) throw exportError("CANVAS_EXPORT_ROLE", `Frame ${frameId} carries role ${frame.role ?? "none"}, not ${request.role}.`);
    const graphNode = graph.getNode(frameId);
    const physical = frame.physical;
    if (request.role === "slide" && !physical) {
      const error = new Error(`Physical size is not declared for ${frameId}.`);
      error.code = "CANVAS_PHYSICAL_SIZE_UNDECLARED";
      throw error;
    }
    const rootCapability = frame.export === "image"
      ? { verdict: "raster", reason: "Author requested image export.", paths: ["properties.export"] }
      : evaluateCapabilities([...documentPaths, ...capabilityPaths(frame, projection)], capability.properties, verification);
    return {
      kind: request.role,
      index,
      id: frameId,
      name: frame.name ?? frameId,
      width: graphNode.width,
      height: graphNode.height,
      unit: "px",
      ...(physical ? { physical } : {}),
      ...(frame.bleed !== undefined ? { bleed: frame.bleed } : {}),
      ...(frame.safeMargin !== undefined ? { safeMargin: frame.safeMargin } : {}),
      ...(frame.folds !== undefined ? { folds: structuredClone(frame.folds) } : {}),
      root: {
        id: frameId,
        type: "frame",
        export: frame.export ?? "default",
        geometry: { x: 0, y: 0, localX: 0, localY: 0, w: graphNode.width, h: graphNode.height, rotation: graphNode.rotation ?? 0 },
        paint: { fill: frame.fill ?? null, stroke: frame.stroke ?? null, effect: frame.effect ?? null, cornerRadius: frame.cornerRadius ?? null, opacity: graphNode.opacity, blendMode: frame.blendMode ?? "normal" },
        semantics: { description: frame.description ?? null, decorative: frame.decorative === true, landmark: frame.landmark ?? null },
        layout: semanticLayout(frame),
        variants: semanticVariants(authoredById.get(frameId) ?? frame),
        capability: rootCapability,
      },
      nodes: rootCapability.verdict === "raster" ? [] : collectOutputNodes(graph, sourceById, authoredById, { ...graphNode, ...graph.getAbsolutePosition(frameId) }, capability, frameId, projection, resolved.document.paragraphStyles ?? {}, resolved.document.lang ?? null, verification),
    };
  });
  for (const output of outputs) {
    if (output.root.capability.verdict !== "raster") continue;
    output.nodes.unshift({ ...output.root, parent: null, z: 0, isolation: output.id, clip: null });
  }
  const evaluatedNodes = outputs.flatMap((output) => output.nodes);
  const rasters = rasterScopes(evaluatedNodes, request, graph, outputs);
  for (const output of outputs) {
    if (rasters.some((raster) => raster.id === output.id) && !output.nodes.some((node) => node.id === output.id)) {
      output.nodes.unshift({ ...output.root, parent: null, z: 0, isolation: output.id, clip: null });
    }
    output.nodes = applyRasterScopes(output.nodes, rasters);
    if (!output.nodes.some((node) => node.id === output.id)) continue;
    let hostId = `${output.id}:export-container`;
    while (sourceById.has(hostId)) hostId += ":host";
    output.nodes[0].parent = hostId;
    output.root = { ...output.root, id: hostId, paint: {}, layout: { layout: "none" }, variants: {}, capability: { verdict: "native" } };
  }
  const nodes = outputs.flatMap((output) => output.nodes);
  const consequences = [
    ...resolved.consequences,
    ...outputs.filter((output) => output.root.capability.verdict !== "native").map((output) => ({ node: output.id, kind: output.root.capability.verdict, why: output.root.capability.reason })),
    ...evaluatedNodes.filter((node) => node.capability.verdict !== "native").map((node) => ({
      node: node.id,
      kind: node.capability.verdict,
      why: node.capability.reason,
    })),
    ...outputs.flatMap((output) => (output.root.capability.ignored ?? []).map((path) => ({ node: output.id, kind: "ignore", why: `${path} is intentionally omitted by the ${format} exporter.` }))),
    ...evaluatedNodes.flatMap((node) => (node.capability.ignored ?? []).map((path) => ({
      node: node.id,
      kind: "ignore",
      why: `${path} is intentionally omitted by the ${format} exporter.`,
    }))),
  ];
  const notes = [...sourceById.values()].filter((node) => node.type === "text" && typeof node.notesFor === "string");
  return {
    format,
    renderDocument: resolved.document,
    projection,
    lang: document.lang ?? null,
    axes: structuredClone(document.axes ?? {}),
    modes: resolved.modes,
    outputs,
    notes,
    // Flow lowering is a forward feature. Keeping the IR field stable costs
    // nothing, while emitting authored flows before its vocabulary is settled
    // would make each target invent incompatible semantics.
    flows: [],
    rasters,
    consequences,
    lowered: resolved.lowered,
    colorSpace: "sRGB",
  };
}

export function buildExtractionIR(document, request) {
  const format = request.format ?? "svg";
  if (!["svg", "pdf"].includes(format)) throw exportError("CANVAS_EXTRACTION_FORMAT", `Unsupported vector extraction format ${format}.`);
  const extractionScale = Number(request.scale ?? 1);
  if (!Number.isFinite(extractionScale) || extractionScale <= 0) throw exportError("CANVAS_EXTRACTION_SCALE", "Extraction scale must be a finite positive number.");
  const capability = extractionEmissionSupport(format);
  const resolved = resolveCanvasDocument(document, { modes: request.modes, bindings: request.bindings, imports: request.imports });
  const graph = request.preparedText?.graph ?? createOpenPencilGraph(resolved.document);
  const sourceById = indexNodes(resolved.document.children);
  const source = sourceById.get(request.nodeId);
  const graphNode = graph.getNode(request.nodeId);
  if (!source || !graphNode) throw exportError("CANVAS_EXTRACTION_NODE", `Node ${request.nodeId} was not found.`);
  let bounds = computeDescendantVisualBounds(
    [request.nodeId],
    (nodeId) => graph.getNode(nodeId) ?? undefined,
    (nodeId) => graph.getAbsolutePosition(nodeId),
  );
  if (!bounds) throw exportError("CANVAS_EXTRACTION_EMPTY", `Node ${request.nodeId} has no visual bounds.`);
  const origin = graph.getAbsolutePosition(request.nodeId);
  // Physical size describes the authored trim frame, not the union of effects
  // and overflow. Overflow remains paint outside trim, available to the bleed.
  if (format === "pdf" && source.physical) bounds = { minX: origin.x, minY: origin.y, maxX: origin.x + graphNode.width, maxY: origin.y + graphNode.height };
  const syntheticRoot = { ...graphNode, x: origin.x, y: origin.y };
  const nodes = collectOutputNodes(graph, sourceById, sourceById, syntheticRoot, capability, request.nodeId, "resolved", resolved.document.paragraphStyles ?? {}, resolved.document.lang ?? null, request[CAPABILITY_VERIFICATION] ?? null, true, format === "pdf" ? request.preparedText?.textLayouts : null);
  const offsetX = bounds.minX - origin.x;
  const offsetY = bounds.minY - origin.y;
  for (const node of nodes) {
    node.geometry.x -= offsetX;
    node.geometry.y -= offsetY;
  }
  const output = {
    kind: "extraction",
    index: 0,
    id: request.nodeId,
    name: source.name ?? request.nodeId,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    unit: "px",
    ...(format === "pdf" ? { physical: source.physical, bleed: source.bleed ?? 0 } : {}),
    origin: { x: bounds.minX, y: bounds.minY },
    root: { id: request.nodeId, type: "frame", semantics: { description: source.description ?? null, decorative: source.decorative === true }, capability: { verdict: "native" } },
    nodes,
  };
  const rasters = rasterScopes(nodes, { rasterPolicy: [{ scale: extractionScale, density: `${extractionScale}x`, ppi: null }] }, graph, [output]);
  output.nodes = applyRasterScopes(nodes, rasters);
  const consequences = [
    ...resolved.consequences,
    ...nodes.filter((node) => node.capability.verdict !== "native").map((node) => ({ node: node.id, kind: node.capability.verdict, why: node.capability.reason })),
    ...nodes.flatMap((node) => (node.capability.ignored ?? []).map((path) => ({ node: node.id, kind: "ignore", why: `${path} is intentionally omitted by ${format.toUpperCase()} extraction.` }))),
  ];
  return { format, renderDocument: resolved.document, projection: "resolved", lang: document.lang ?? null, axes: structuredClone(document.axes ?? {}), modes: resolved.modes, outputs: [output], notes: [], flows: [], rasters, consequences, lowered: resolved.lowered, colorSpace: "sRGB" };
}

function collectOutputNodes(graph, sources, authored, root, capability, rootId, projection, paragraphStyles, documentLanguage, verification, includeRoot = false, textLayouts = null) {
  const result = [];
  const visit = (node, parent = null, z = 0) => {
    const source = sources.get(node.id) ?? {};
    const authoredSource = authored.get(node.id) ?? source;
    if (source.enabled === false) return;
    if (node.id !== rootId || includeRoot) {
      const world = getAbsolutePositionFull(node, graph);
      const absolute = { x: world.centerX - node.width / 2, y: world.centerY - node.height / 2 };
      const paths = capabilityPaths(source, projection);
      const textLayout = source.type === "text" ? textLayouts?.get(node.id) : null;
      const entry = source.export === "image"
        ? { verdict: "raster", reason: "Author requested image export.", paths: ["properties.export"] }
        : evaluateCapabilities(textLayout ? paths.filter((path) => !MEASURED_PDF_TEXT_PATHS.has(path)) : paths, capability.properties, verification);
      result.push({
        id: node.id, type: source.type ?? node.type.toLowerCase(), parent: node.id === rootId ? null : parent, z,
        geometry: {
          x: absolute.x - root.x,
          y: absolute.y - root.y,
          localX: node.x,
          localY: node.y,
          w: node.width,
          h: node.height,
          rotation: node.rotation ?? 0,
        },
        paint: { fill: source.fill ?? null, stroke: source.stroke ?? null, effect: source.effect ?? null, cornerRadius: source.cornerRadius ?? null, opacity: node.opacity, blendMode: source.blendMode ?? "normal" },
        semantics: source.type === "text" ? { content: source.content ?? "", runs: richTextRuns(source, paragraphStyles, documentLanguage), paragraphs: (source.paragraphs?.length ? source.paragraphs : (source.content ? [{ from: 0, to: source.content.length, ...(source.headingLevel ? { headingLevel: source.headingLevel } : {}) }] : [])).map((paragraph) => ({ ...paragraph, resolvedStyle: paragraph.style ? paragraphStyles[paragraph.style] : undefined })), language: source.lang ?? source.language ?? documentLanguage, description: source.description ?? null, decorative: source.decorative === true, landmark: source.landmark ?? null, linkName: source.linkName ?? null } : { description: source.description ?? null, decorative: source.decorative === true, landmark: source.landmark ?? null, linkName: source.linkName ?? null },
        layout: semanticLayout(source),
        ...(textLayout ? { textLayout } : {}),
        ...(source.type === "path" || source.type === "polygon" ? { vector: vectorForNode(source) } : {}),
        variants: semanticVariants(authoredSource),
        export: source.export ?? "default", capability: entry,
        provenance: source.provenance ?? null, clip: source.clip === true ? node.id : null, isolation: needsIsolation(source) ? node.id : null,
      });
      if (entry.verdict === "raster") return;
    }
    node.childIds.forEach((id, index) => { const child = graph.getNode(id); if (child) visit(child, node.id === rootId ? rootId : node.id, index); });
  };
  visit(root);
  return result;
}
function semanticVariants(node) {
  return Object.fromEntries(Object.entries(node).filter(([, value]) =>
    isCascade(value)));
}

function rasterScopes(nodes, request, graph, outputs) {
  const byId = new Map([...outputs.map((output) => ({ ...output.root, parent: null, isolation: output.id })), ...nodes].map((node) => [node.id, node]));
  const scopes = new Set();
  for (const node of nodes.filter((item) => item.capability.verdict === "raster")) {
    let scope = node;
    if (hasBackgroundBlur(node.paint.effect) || hasBackdropBlend(node.paint)) while (scope.parent && byId.has(scope.parent)) {
      scope = byId.get(scope.parent);
      if (scope.isolation) break;
    }
    scopes.add(scope.id);
  }
  const subsumed = (id) => { let parent = byId.get(id)?.parent; while (parent && byId.has(parent)) { if (scopes.has(parent)) return true; parent = byId.get(parent).parent; } return false; };
  const policy = request.rasterPolicy ?? rasterPolicyFor(request.role);
  return [...scopes].filter((id) => !subsumed(id)).map((id) => {
    const scope = byId.get(id);
    const output = outputs.find((candidate) => candidate.id === id || candidate.id === scope.parent || candidate.nodes.some((node) => node.id === id));
    const rootAbsolute = output.origin ?? graph.getAbsolutePosition(output.id);
    const visual = computeDescendantVisualBounds(
      [id],
      (nodeId) => graph.getNode(nodeId) ?? undefined,
      (nodeId) => graph.getAbsolutePosition(nodeId),
    );
    if (!visual) throw exportError("CANVAS_RASTER_EMPTY", `Raster scope ${id} has no visual bounds.`);
    const visualLeft = visual.minX - rootAbsolute.x;
    const visualTop = visual.minY - rootAbsolute.y;
    const visualRight = visual.maxX - rootAbsolute.x;
    const visualBottom = visual.maxY - rootAbsolute.y;
    const outset = {
      left: Math.max(0, scope.geometry.x - visualLeft),
      top: Math.max(0, scope.geometry.y - visualTop),
      right: Math.max(0, visualRight - scope.geometry.x - scope.geometry.w),
      bottom: Math.max(0, visualBottom - scope.geometry.y - scope.geometry.h),
    };
    const logicalWidth = visualRight - visualLeft;
    const logicalHeight = visualBottom - visualTop;
    const variants = policy.map((variant) => ({
      ...variant,
      pixelWidth: Math.max(1, Math.ceil(logicalWidth * variant.scale)),
      pixelHeight: Math.max(1, Math.ceil(logicalHeight * variant.scale)),
    }));
    return {
      id,
      reason: scope.capability.reason ?? "Raster compositing scope.",
      renderBounds: { minX: visual.minX, minY: visual.minY, maxX: visual.maxX, maxY: visual.maxY },
      outset,
      bounds: { x: visualLeft, y: visualTop, w: logicalWidth, h: logicalHeight },
      colorSpace: "sRGB",
      alpha: "unpremultiplied",
      ppi: variants.at(-1).ppi,
      pixelWidth: variants.at(-1).pixelWidth,
      pixelHeight: variants.at(-1).pixelHeight,
      variants,
    };
  });
}
function hasBackgroundBlur(effect) {
  return (Array.isArray(effect) ? effect : [effect]).some((item) =>
    item?.type === "background_blur" || item?.type === "backgroundBlur");
}

function hasBackdropBlend(paint) {
  const nonNormal = (mode) => ![undefined, "normal", "pass_through"].includes(mode);
  const fills = Array.isArray(paint.fill) ? paint.fill : [paint.fill];
  return nonNormal(paint.blendMode) || fills.some((fill) => fill?.enabled !== false && nonNormal(fill?.blendMode))
    || nonNormal(paint.stroke?.fill?.blendMode);
}

function applyRasterScopes(nodes, rasters) {
  const scopes = new Map(rasters.map((raster) => [raster.id, raster]));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const insideScope = (node) => {
    let parent = node.parent;
    while (parent && byId.has(parent)) {
      if (scopes.has(parent)) return true;
      parent = byId.get(parent).parent;
    }
    return false;
  };
  return nodes.filter((node) => !insideScope(node)).map((node) => scopes.has(node.id)
    ? (() => {
      const raster = scopes.get(node.id);
      return {
        ...node,
        geometry: {
          ...node.geometry,
          x: raster.bounds.x,
          y: raster.bounds.y,
          localX: Number(node.geometry.localX ?? node.geometry.x) + raster.bounds.x - node.geometry.x,
          localY: Number(node.geometry.localY ?? node.geometry.y) + raster.bounds.y - node.geometry.y,
          w: raster.bounds.w,
          h: raster.bounds.h,
          rotation: 0,
        },
        // Raster pixels already include these visual operations. Native image
        // wrappers must not apply opacity, rotation or paint a second time.
        paint: { fill: null, stroke: null, effect: null, cornerRadius: null, opacity: 1, blendMode: "normal" },
        capability: { verdict: "raster", reason: raster.reason ?? "Raster compositing scope." },
      };
    })()
    : node);
}

function capabilityPaths(node, projection) {
  const paths = new Set([`nodes.${node.type}`]);
  for (const key of ["rotation", "flipX", "flipY", "opacity", "clip", "cornerRadius", "blendMode", "decorative", "bleed", "safeMargin", "folds"]) {
    if (node[key] !== undefined) paths.add(`properties.${key}`);
  }
  if (node.description !== undefined) paths.add("properties.accessibility.description");
  if (node.landmark !== undefined) paths.add("properties.accessibility.landmark");
  if (node.linkName !== undefined) paths.add("properties.accessibility.linkName");
  const fills = Array.isArray(node.fill) ? node.fill : [node.fill];
  if (node.fill !== undefined) paths.add("properties.fill");
  for (const fill of fills.filter(Boolean)) {
    if (fill.enabled !== false && ![undefined, "normal", "pass_through"].includes(fill.blendMode)) paths.add("properties.blendMode");
    if (typeof fill === "string" || fill.type === "color" || fill.type === "solid") paths.add("properties.fill.solid");
    else if (fill.type === "image") paths.add("properties.fill.image");
    else if (fill.type === "shader") paths.add("properties.fill.shader");
    else if (fill.type === "mesh_gradient") paths.add("properties.fill.gradient.mesh");
    else if (fill.type === "gradient") {
      const kind = fill.gradientType ?? "linear";
      paths.add(`properties.fill.gradient.${kind}`);
      const transformed = Number(fill.center?.x ?? 0.5) !== 0.5 || Number(fill.center?.y ?? 0.5) !== 0.5 || Number(fill.size?.width ?? 1) !== 1 || Number(fill.size?.height ?? 1) !== 1 || (kind === "radial" && Number(fill.rotation ?? 0) !== 0);
      if (transformed && ["linear", "radial"].includes(kind)) paths.add(`properties.fill.gradient.${kind}.transformed`);
    }
  }
  if (node.stroke !== undefined) {
    paths.add("properties.stroke");
    if (![undefined, "normal", "pass_through"].includes(node.stroke?.fill?.blendMode)) paths.add("properties.blendMode");
    for (const key of ["width", "align", "cap", "join", "dash", "fill"]) if (node.stroke?.[key] !== undefined || (key === "width" && node.stroke?.thickness !== undefined)) paths.add(`properties.stroke.${key}`);
  }
  for (const effect of (Array.isArray(node.effect) ? node.effect : [node.effect]).filter(Boolean)) {
    paths.add("properties.effect");
    const kind = effect.type === "backgroundBlur" ? "background_blur" : effect.type;
    if (["shadow", "blur", "background_blur"].includes(kind)) paths.add(`properties.effect.${kind}`);
    if (kind === "shadow" && Number(effect.spread ?? 0) !== 0) paths.add("properties.effect.shadow.spread");
  }
  if (node.type === "text") {
    paths.add("properties.content");
    const baseRunPaths = {
      fill: "fill", fontFamily: "fontFamily", fontSize: "fontSize", fontWeight: "weight",
      fontStyle: "italic", letterSpacing: "letterSpacing", wordSpacing: "wordSpacing",
      underline: "underline", strikethrough: "strikethrough", lang: "language",
    };
    for (const [key, mapped] of Object.entries(baseRunPaths)) if (node[key] !== undefined) paths.add(`properties.text.run.${mapped}`);
    for (const key of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "textAlign", "textAlignVertical", "textGrowth", "underline", "strikethrough", "lang", "headingLevel", "paragraphs", "marks"]) if (node[key] !== undefined) paths.add(`properties.${key}`);
    if (node.textAlign !== undefined) paths.add("properties.text.paragraph.align");
    if (node.headingLevel !== undefined) paths.add("properties.text.paragraph.headingLevel");
    for (const mark of node.marks ?? []) {
      const mapped = { fill: "fill", weight: "weight", italic: "italic", underline: "underline", strikethrough: "strikethrough", fontFamily: "fontFamily", fontSize: "fontSize", letterSpacing: "letterSpacing", wordSpacing: "wordSpacing", lang: "language", link: "link" }[mark.type];
      if (mapped) paths.add(`properties.text.run.${mapped}`);
    }
    for (const paragraph of node.paragraphs ?? []) {
      for (const key of ["align", "style", "list", "headingLevel"]) if (paragraph[key] !== undefined) paths.add(`properties.text.paragraph.${key}`);
    }
  }
  if (node.type === "path" || node.type === "polygon") for (const key of ["geometry", "viewBox", "fillRule"]) if (node[key] !== undefined) paths.add(`properties.${key}`);
  if (projection === "semantic") for (const key of ["layout", "gap", "rowGap", "columnGap", "padding", "justifyContent", "alignItems", "wrap", "minWidth", "maxWidth", "minHeight", "maxHeight", "gridTemplateColumns", "gridTemplateRows", "gridColumn", "gridRow", "layoutPosition"]) if (node[key] !== undefined) paths.add(`properties.${key}`);
  return [...paths];
}

function evaluateCapabilities(paths, table, verification = null) {
  const entries = paths.map((path) => {
    const entry = table[path] ?? { verdict: "raster", reason: `Capability ${path} is absent from the table.` };
    // Only the module-private verification symbol can exercise candidate native
    // emission, including a previously raster-only implementation. This never
    // changes the production table or exposes an author force-native override.
    return { path, ...(verification?.has(path) ? { verdict: "native", status: "verification-only" } : entry) };
  });
  const unknown = entries.filter((entry) => entry.verdict === null || entry.status === "unverified");
  if (unknown.length) {
    const error = new Error(`Unverified capabilities: ${unknown.map((entry) => entry.path).join(", ")}.`);
    error.code = "CANVAS_CAPABILITY_UNVERIFIED";
    throw error;
  }
  const raster = entries.filter((entry) => entry.verdict === "raster");
  if (raster.length) return { verdict: "raster", reason: raster.map((entry) => `${entry.path}: ${entry.reason ?? "not native"}`).join("; "), paths };
  const native = entries.filter((entry) => entry.verdict === "native");
  if (native.length) return { verdict: "native", paths, ignored: entries.filter((entry) => entry.verdict === "ignore").map((entry) => entry.path) };
  return { verdict: "ignore", reason: entries.map((entry) => `${entry.path}: ${entry.reason ?? "ignored"}`).join("; "), paths };
}
function documentCapabilityPaths(document, role) {
  const paths = new Set([`roles.${role}`]);
  for (const key of ["module", "lang", "axes", "variables", "paragraphStyles", "imports", "children"])
    if (document[key] !== undefined) paths.add(`root.${key}`);
  if ((document.flows ?? []).length) paths.add("root.flows");
  if (Object.keys(document.imports ?? {}).length) paths.add("relationships.import");
  if ((document.flows ?? []).length) paths.add("relationships.flow");
  const nodes = [...indexNodes(document.children).values()];
  if (nodes.some((node) => node.type === "ref")) paths.add("relationships.ref");
  if (nodes.some((node) => node.notesFor !== undefined)) paths.add("relationships.notesFor");
  return [...paths];
}
export function richTextRuns(node, paragraphStyles, documentLanguage = null) {
  const content = node.content ?? "";
  const paragraphs = node.paragraphs?.length ? node.paragraphs : content ? [{ from: 0, to: content.length }] : [];
  return paragraphs.flatMap((paragraph) => {
    const paragraphContent = content.slice(paragraph.from, paragraph.to);
    const marks = (node.marks ?? []).flatMap((mark) => {
      const from = Math.max(mark.from, paragraph.from); const to = Math.min(mark.to, paragraph.to);
      return from < to ? [{ ...mark, from: from - paragraph.from, to: to - paragraph.from }] : [];
    });
    const styleName = paragraph.style ?? node.style;
    const base = { ...textBase(node), ...(styleName ? paragraphStyles[styleName] : {}) };
    return flattenMarks(paragraphContent, marks, base).map((run) => ({ ...run, from: run.from + paragraph.from, to: run.to + paragraph.from }));
  }).map((run) => {
    if (run.lang === undefined) return run.language === undefined && documentLanguage ? { ...run, language: documentLanguage } : run;
    const { lang, ...rest } = run;
    return { ...rest, language: lang };
  });
}
function textBase(node) { return Object.fromEntries(["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "fill", "underline", "strikethrough"].filter((key) => node[key] !== undefined).map((key) => [key, node[key]])); }
function semanticLayout(node) { return Object.fromEntries(["textGrowth", "layout", "gap", "rowGap", "columnGap", "padding", "alignItems", "justifyContent", "layoutPosition", "wrap", "minWidth", "maxWidth", "minHeight", "maxHeight", "gridTemplateColumns", "gridTemplateRows", "gridColumn", "gridRow", "width", "height"].filter((key) => node[key] !== undefined).map((key) => [key, node[key]])); }
function needsIsolation(node) { return Number(node.opacity ?? 1) < 1 || ![undefined, "normal", "pass_through"].includes(node.blendMode) || node.clip === true; }
function indexNodes(children, map = new Map()) { for (const node of children ?? []) { map.set(node.id, node); indexNodes(node.children, map); } return map; }
function exportError(code, message) { const error = new Error(message); error.code = code; return error; }
