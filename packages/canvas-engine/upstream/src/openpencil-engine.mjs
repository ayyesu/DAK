import {
  computeBounds,
  computeDescendantVisualBounds,
  computeAllLayouts,
  computeLayout,
  computeOverlaps,
  createDefaultEditorState,
  createEditor,
  createCanvasSceneGraph,
  hydrateCanvasSceneGraphInstances,
  shouldRenderSceneSubtreeDetail,
} from "../vendor/open-pencil/engine.source.mjs";
import { reactive } from "vue";
import { prepareOpenPencilRenderDocument } from "./openpencil-render-document.mjs";
import { pencilResourceAsset } from "./pencil-resources.mjs";
import { resolveCanvasNodeSelection } from "./node-reference.mjs";
import { flattenMarks, isMarkInclusive } from "./rich-text.mjs";
import { finalizeSvgVectorAssets, registerSvgVectorAsset } from "./svg-vectors.mjs";

export { computeOverlaps };

const VISUAL_NODE_TYPES = new Set([
  "frame",
  "rectangle",
  "ellipse",
  "line",
  "polygon",
  "group",
  "text",
  "icon_font",
  "icon",
  "path",
  "ref",
  "script",
  "note",
  "context",
  "prompt",
]);

const DIRECT_PROPERTY_MAP = new Map([
  ["name", "name"],
  ["x", "x"],
  ["y", "y"],
  ["width", "width"],
  ["height", "height"],
  ["rotation", "rotation"],
  ["opacity", "opacity"],
  ["cornerRadius", "cornerRadius"],
  ["visible", "enabled"],
  ["clipsContent", "clip"],
  ["text", "content"],
  ["fontFamily", "fontFamily"],
  ["fontSize", "fontSize"],
  ["fontWeight", "fontWeight"],
  ["lineHeight", "lineHeight"],
  ["letterSpacing", "letterSpacing"],
]);

const TRACKED_SCENE_PROPERTIES = new Set([
  ...DIRECT_PROPERTY_MAP.keys(),
  "layoutMode",
  "itemSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "textAlignHorizontal",
  "textAlignVertical",
  "fills",
  "styleRuns",
]);

export function createOpenPencilEditor(document, options = {}) {
  const graph = createOpenPencilGraph(
    document,
    options.assets,
    options.preparedDocument,
    {
      computeLayout: options.computeInitialLayout !== false,
      deferExternalInstances: options.deferExternalInstances === true,
    },
  );
  return createEditor({
    graph,
    state: reactive(createDefaultEditorState(graph.getPages()[0].id)),
    getViewportSize: options.getViewportSize,
  });
}

export function createOpenPencilGraph(
  document,
  assets = new Map(),
  preparedDocument = null,
  options = {},
) {
  const startedAt = performance.now();
  const renderDocument = measureGraphPhase(
    "engine.graph.prepare",
    () => (preparedDocument ?? prepareOpenPencilRenderDocument(document, { assets })).document,
  );
  const graph = measureGraphPhase(
    "engine.graph.adapt-model",
    () => createCanvasSceneGraph(renderDocument, {
      deferExternalInstances: options.deferExternalInstances === true,
    }),
  );
  measureGraphPhase("engine.graph.adapt", () => {
    applyPencilSceneProperties(graph, renderDocument);
    applyInstanceTextStyles(graph, renderDocument);
    applyImageAssets(graph, assets);
    applyShaderAssets(graph, renderDocument, assets);
    walkPenNodes(renderDocument.children, (renderNode) => {
      if (renderNode.__canvasGenerated && graph.getNode(renderNode.id)) {
        graph.updateNode(renderNode.id, { locked: true });
      }
    });
    walkPenNodes(document.children, (sourceNode) => {
      if (isOpenPencilEditableNode(sourceNode)) return;
      if (graph.getNode(sourceNode.id)) graph.updateNode(sourceNode.id, { locked: true });
    });
  }, { graphNodes: graph.nodes.size });
  if (options.computeLayout !== false) {
    measureGraphPhase("engine.graph.layout", () => {
      for (const page of graph.getPages()) computeAllLayouts(graph, page.id);
    }, { graphNodes: graph.nodes.size });
  }
  recordGraphPerformance("engine.graph.total", performance.now() - startedAt, {
    graphNodes: graph.nodes.size,
  });
  return graph;
}

export function hydrateOpenPencilGraphInstances(graph, document, instanceIds) {
  const startedAt = performance.now();
  const requestedIds = [...instanceIds];
  const beforeGeometry = new Map(requestedIds.map((id) => {
    const node = graph.getNode(id);
    return [id, node ? [node.x, node.y, node.width, node.height] : null];
  }));
  const hydratedIds = measureGraphPhase(
    "engine.graph.hydrate-clones",
    () => hydrateCanvasSceneGraphInstances(graph, document, requestedIds),
  );
  if (hydratedIds.length === 0) return hydratedIds;
  applyInstanceTextStyles(graph, document, hydratedIds);

  let subtreeDurationMs = 0;
  let ancestorDurationMs = 0;
  const ancestorCosts = new Map();
  const pendingAncestors = new Set();
  const laidOutGeometry = new Map();
  for (const instanceId of hydratedIds) {
    const subtreeStartedAt = performance.now();
    // The instance was already sized by its parent while its children were deferred.
    // A detached Yoga pass otherwise treats FILL as unconstrained and gives its
    // fill-width descendants zero space, even though the parent assigned a width.
    computeHydratedInstanceLayout(graph, instanceId);
    subtreeDurationMs += performance.now() - subtreeStartedAt;
    let node = graph.getNode(instanceId);
    if (node) laidOutGeometry.set(instanceId, [node.width, node.height]);
    const previous = beforeGeometry.get(instanceId);
    if (node && previous && previous[0] === node.x && previous[1] === node.y
      && previous[2] === node.width && previous[3] === node.height) continue;
    if (node?.parentId) pendingAncestors.add(node.parentId);
  }
  const depth = (id) => {
    let value = 0;
    let node = graph.getNode(id);
    while (node?.parentId) {
      value += 1;
      node = graph.getNode(node.parentId);
    }
    return value;
  };
  const visitedAncestors = new Set();
  while (pendingAncestors.size > 0) {
    const id = [...pendingAncestors].sort((a, b) => depth(b) - depth(a))[0];
    pendingAncestors.delete(id);
    if (visitedAncestors.has(id)) continue;
    visitedAncestors.add(id);
    const before = graph.getNode(id);
    if (!before) continue;
    const geometry = [before.x, before.y, before.width, before.height];
    const layoutStartedAt = performance.now();
    computeLayout(graph, id);
    const durationMs = performance.now() - layoutStartedAt;
    ancestorDurationMs += durationMs;
    ancestorCosts.set(id, { calls: 1, durationMs });
    const after = graph.getNode(id);
    if (after?.parentId && (after.x !== geometry[0] || after.y !== geometry[1]
      || after.width !== geometry[2] || after.height !== geometry[3])) {
      pendingAncestors.add(after.parentId);
    }
  }
  // A hug-sized ancestor can change the instance's available space after the
  // first pass. Reconcile only those hydrated subtrees, not the whole document.
  for (const instanceId of hydratedIds) {
    const node = graph.getNode(instanceId);
    const laidOut = laidOutGeometry.get(instanceId);
    if (node && laidOut && (node.width !== laidOut[0] || node.height !== laidOut[1])) {
      computeHydratedInstanceLayout(graph, instanceId);
    }
  }
  recordGraphPerformance("engine.graph.hydrate-subtree-layout", subtreeDurationMs, {
    hydratedInstances: hydratedIds.length,
  });
  recordGraphPerformance("engine.graph.hydrate-ancestor-layout", ancestorDurationMs, {
    hydratedInstances: hydratedIds.length,
    ancestorCalls: [...ancestorCosts.values()].reduce((total, item) => total + item.calls, 0),
    distinctAncestors: ancestorCosts.size,
    topAncestors: [...ancestorCosts].sort((a, b) => b[1].durationMs - a[1].durationMs).slice(0, 5)
      .map(([id, cost]) => ({ id, calls: cost.calls, durationMs: Number(cost.durationMs.toFixed(1)) })),
  });
  recordGraphPerformance("engine.graph.hydrate-instances", performance.now() - startedAt, {
    hydratedInstances: hydratedIds.length,
    graphNodes: graph.nodes.size,
  });
  return hydratedIds;
}

function computeHydratedInstanceLayout(graph, instanceId) {
  const instance = graph.getNode(instanceId);
  if (!instance) return;
  const primary = instance.primaryAxisSizing;
  const counter = instance.counterAxisSizing;
  if (primary === "FILL") instance.primaryAxisSizing = "FIXED";
  if (counter === "FILL") instance.counterAxisSizing = "FIXED";
  try {
    computeAllLayouts(graph, instanceId);
  } finally {
    instance.primaryAxisSizing = primary;
    instance.counterAxisSizing = counter;
  }
}

export function createOpenPencilInstanceHydrator({
  editor,
  document,
  getViewportSize,
  onHydrated = () => {},
}) {
  let renderDocument = document;
  let externalInstanceIds = collectExternalInstanceIds(renderDocument);
  let hydratedInstanceIds = new Set();

  const hydrate = (instanceIds) => {
    const requested = [...new Set(instanceIds)].filter((id) => (
      externalInstanceIds.has(id) && !hydratedInstanceIds.has(id)
    ));
    if (requested.length === 0) return [];
    for (const id of requested) hydratedInstanceIds.add(id);
    const hydrated = editor.runDerivedGraphMutation(() => (
      hydrateOpenPencilGraphInstances(editor.graph, renderDocument, requested)
    ));
    if (hydrated.length > 0) {
      editor.requestRender();
      onHydrated(hydrated);
    }
    return hydrated;
  };

  return {
    hydrateInstance(instanceId) {
      return hydrate([instanceId]);
    },
    hydrateVisible() {
      const size = getViewportSize();
      const zoom = Math.max(editor.state.zoom, Number.EPSILON);
      const world = {
        x: -editor.state.panX / zoom,
        y: -editor.state.panY / zoom,
        width: Math.max(1, size.width) / zoom,
        height: Math.max(1, size.height) / zoom,
      };
      const overscanX = world.width * 0.25;
      const overscanY = world.height * 0.25;
      const visible = [];
      for (const instanceId of externalInstanceIds) {
        if (hydratedInstanceIds.has(instanceId)) continue;
        const node = editor.graph.getNode(instanceId);
        if (!node) continue;
        const bounds = computeDescendantVisualBounds(
          [instanceId],
          (id) => editor.graph.getNode(id),
          (id) => editor.graph.getAbsolutePosition(id),
        );
        if (!bounds || !boundsIntersectViewport(bounds, world, overscanX, overscanY)) continue;
        const descendantCount = countGraphDescendants(editor.graph, node.componentId);
        if (!shouldRenderSceneSubtreeDetail(
          node.width,
          node.height,
          zoom,
          descendantCount,
        )) continue;
        visible.push(instanceId);
      }
      return hydrate(visible);
    },
    hydrateForNode(nodeId) {
      const instanceId = [...externalInstanceIds]
        .filter((id) => nodeId === id || nodeId.startsWith(`${id}/`))
        .sort((left, right) => right.length - left.length)[0];
      return instanceId ? hydrate([instanceId]) : [];
    },
    hasDeferredDetail(instanceId) {
      return externalInstanceIds.has(instanceId) && !hydratedInstanceIds.has(instanceId);
    },
    hydratedInstanceIds() {
      return new Set(hydratedInstanceIds);
    },
    replaceDocument(nextDocument, preservedInstanceIds = []) {
      renderDocument = nextDocument;
      externalInstanceIds = collectExternalInstanceIds(renderDocument);
      hydratedInstanceIds = new Set(
        preservedInstanceIds.filter((id) => externalInstanceIds.has(id)),
      );
    },
  };
}

function collectExternalInstanceIds(document) {
  const targetIds = new Set();
  walkPenNodes(document.children, (node) => {
    if (node.type === "ref" && typeof node.ref === "string") targetIds.add(node.ref);
  });
  const instanceIds = new Set();
  const visit = (nodes, insideDefinition = false) => {
    for (const node of nodes ?? []) {
      const nestedInsideDefinition = insideDefinition || targetIds.has(node.id);
      if (node.type === "ref" && !insideDefinition) instanceIds.add(node.id);
      visit(node.children, nestedInsideDefinition);
    }
  };
  visit(document.children);
  return instanceIds;
}

function countGraphDescendants(graph, nodeId) {
  const root = graph.getNode(nodeId);
  if (!root) return 1;
  let count = 0;
  const pending = [...root.childIds];
  const visited = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = graph.getNode(id);
    if (!node) continue;
    count += 1;
    pending.push(...node.childIds);
  }
  return Math.max(1, count);
}

function boundsIntersectViewport(bounds, viewport, overscanX, overscanY) {
  return bounds.maxX >= viewport.x - overscanX
    && bounds.minX <= viewport.x + viewport.width + overscanX
    && bounds.maxY >= viewport.y - overscanY
    && bounds.minY <= viewport.y + viewport.height + overscanY;
}

function applyShaderAssets(graph, document, assets) {
  walkPenNodes(document.children, (node) => {
    for (const fill of Array.isArray(node.fill) ? node.fill : node.fill ? [node.fill] : []) {
      for (const texture of fill?.__canvasShader?.textures ?? []) {
        const asset = pencilResourceAsset(assets, texture.url);
        if (asset) graph.images.set(texture.sha256, asset.renderBytes ?? asset.bytes);
      }
    }
  });
}

function measureGraphPhase(name, operation, detail = {}) {
  const monitor = globalThis.__penkraPerformance?.canvas;
  return monitor?.measure ? monitor.measure(name, operation, detail) : operation();
}

function recordGraphPerformance(name, durationMs, detail = {}) {
  globalThis.__penkraPerformance?.canvas?.record(name, durationMs, detail);
}

function applyPencilSceneProperties(graph, document) {
  walkPenNodes(document.children, (sourceNode) => {
    const sceneNode = graph.getNode(sourceNode.id);
    if (!sceneNode) return;
    const changes = {};
    if (sourceNode.layoutPosition === "absolute") changes.layoutPositioning = "ABSOLUTE";
    if (sourceNode.type === "text" && sourceNode.textGrowth === "fixed-width-height") {
      changes.textAutoResize = "NONE";
    }
    if (sourceNode.type === "text" && (Array.isArray(sourceNode.marks) || sourceNode.style || sourceNode.paragraphs?.some((paragraph) => paragraph.style))) {
      changes.styleRuns = canvasStyleRuns(sourceNode, sourceNode.__canvasResolvedParagraphStyles ?? document.paragraphStyles ?? {});
    }
    if (sourceNode.type === "ellipse" && (
      sourceNode.innerRadius !== undefined
      || sourceNode.startAngle !== undefined
      || sourceNode.sweepAngle !== undefined
    )) {
      const start = degreesToRadians(sourceNode.startAngle ?? 0);
      changes.arcData = {
        startingAngle: start,
        endingAngle: start + degreesToRadians(sourceNode.sweepAngle ?? 360),
        innerRadius: sourceNode.innerRadius ?? 0,
      };
    }
    if (Object.keys(changes).length > 0) graph.updateNode(sourceNode.id, changes);
  });
}

function applyInstanceTextStyles(graph, document, instanceIds = null) {
  const sources = new Map();
  walkPenNodes(document.children, (node) => sources.set(node.id, node));
  const styleCache = new Map();
  for (const sceneNode of graph.nodes.values()) {
    if (sceneNode.type !== "TEXT" || !sceneNode.componentId || sceneNode.id === sceneNode.componentId) continue;
    if (instanceIds && !instanceIds.some((id) => sceneNode.id.startsWith(`${id}/`))) continue;
    const source = sources.get(sceneNode.pencilNodeId) ?? sources.get(sceneNode.componentId);
    if (!source || !(source.style || source.paragraphs?.some((paragraph) => paragraph.style) || source.marks?.length)) continue;
    const theme = {};
    let ancestor = sceneNode.parentId ? graph.getNode(sceneNode.parentId) : null;
    const themeAncestors = [];
    while (ancestor) {
      themeAncestors.unshift(ancestor);
      ancestor = ancestor.parentId ? graph.getNode(ancestor.parentId) : null;
    }
    for (const parent of themeAncestors) {
      Object.assign(theme, (sources.get(parent.pencilNodeId) ?? sources.get(parent.id))?.theme ?? {});
    }
    Object.assign(theme, source.theme ?? {});
    const key = JSON.stringify(theme);
    let styles = styleCache.get(key);
    if (!styles) {
      const styleNames = Object.keys(document.paragraphStyles ?? {});
      const probes = prepareOpenPencilRenderDocument({
        axes: document.axes, variables: document.variables, paragraphStyles: document.paragraphStyles,
        children: styleNames.map((name, index) => ({ id: `__canvas_style_probe_${index}`, type: "text", content: "x", style: name, theme })),
      }).document.children;
      styles = Object.fromEntries(probes.map((probe, index) => [styleNames[index], probe.__canvasResolvedParagraphStyles?.[styleNames[index]] ?? {}]));
      styleCache.set(key, styles);
    }
    const content = sceneNode.text ?? source.content ?? "";
    const unchangedContent = content === source.content;
    const styledSource = {
      ...source,
      content,
      paragraphs: unchangedContent ? source.paragraphs : paragraphPartition(content),
      marks: unchangedContent ? source.marks : [],
    };
    const runs = canvasStyleRuns(styledSource, styles);
    if (runs.length) graph.updateNode(sceneNode.id, { styleRuns: runs });
  }
}

function canvasStyleRuns(node, paragraphStyles) {
  const content = node.content ?? "";
  const paragraphs = node.paragraphs?.length ? node.paragraphs : content ? [{ from: 0, to: content.length }] : [];
  const flattened = paragraphs.flatMap((paragraph) => {
    const marks = (node.marks ?? []).flatMap((mark) => {
      const from = Math.max(mark.from, paragraph.from);
      const to = Math.min(mark.to, paragraph.to);
      return from < to ? [{ ...mark, from: from - paragraph.from, to: to - paragraph.from }] : [];
    });
    const styleName = paragraph.style ?? node.style;
    const base = styleName ? paragraphStyles[styleName] ?? {} : {};
    return flattenMarks(content.slice(paragraph.from, paragraph.to), marks, base)
      .map((run) => ({ ...run, from: run.from + paragraph.from, to: run.to + paragraph.from }));
  });
  return flattened.flatMap((run) => {
    const style = {};
    if (run.weight !== undefined || run.fontWeight !== undefined) style.fontWeight = Number(run.weight ?? run.fontWeight);
    if (run.italic !== undefined || run.fontStyle !== undefined) style.italic = Boolean(run.italic ?? run.fontStyle === "italic");
    if (run.underline !== undefined) style.underline = Boolean(run.underline);
    if (run.strikethrough !== undefined) style.strikethrough = Boolean(run.strikethrough);
    if (run.fontFamily !== undefined) style.fontFamily = run.fontFamily;
    if (run.fontSize !== undefined) style.fontSize = Number(run.fontSize);
    if (run.letterSpacing !== undefined) style.letterSpacing = Number(run.letterSpacing);
    if (run.wordSpacing !== undefined) style.wordSpacing = Number(run.wordSpacing);
    if (run.lang !== undefined || run.language !== undefined) style.textLanguage = run.lang ?? run.language;
    const fill = parseHexColor(run.fill);
    if (fill) style.fills = [{ type: "SOLID", visible: true, opacity: 1, color: fill }];
    return Object.keys(style).length ? [{ start: run.from, length: run.to - run.from, style }] : [];
  });
}

function degreesToRadians(value) {
  return Number(value) * Math.PI / 180;
}

export function refreshOpenPencilEditor(
  editor,
  document,
  selectedId = null,
  assets = new Map(),
  preparedDocument = null,
  options = {},
) {
  const viewport = {
    panX: editor.state.panX,
    panY: editor.state.panY,
    zoom: editor.state.zoom,
  };
  const nextGraph = createOpenPencilGraph(document, assets, preparedDocument, {
    deferExternalInstances: options.deferExternalInstances === true,
  });
  if (options.hydrateInstanceIds?.length) {
    hydrateOpenPencilGraphInstances(
      nextGraph,
      (preparedDocument ?? prepareOpenPencilRenderDocument(document, { assets })).document,
      options.hydrateInstanceIds,
    );
  }
  // The editor owns graph-scoped renderer cache invalidation on replacement.
  editor.replaceGraph(nextGraph);
  editor.state.panX = viewport.panX;
  editor.state.panY = viewport.panY;
  editor.state.zoom = viewport.zoom;
  if (selectedId && editor.graph.getNode(selectedId)) editor.select([selectedId]);
  editor.requestRender();
  return editor;
}

function applyImageAssets(graph, assets) {
  const svgState = {};
  const changedIds = [];
  for (const node of graph.getAllNodes()) {
    if (!node.fills.some((fill) => fill.pencilImage)) continue;
    const fills = node.fills.map((fill) => {
      const image = fill.pencilImage;
      if (!image) return fill;
      const asset = pencilResourceAsset(assets, image.url);
      if (!asset) return fill.type === "IMAGE"
        ? { type: "SOLID", visible: false, opacity: 0, color: { r: 0, g: 0, b: 0, a: 0 }, pencilImage: image }
        : fill;
      if (fill.type === "IMAGE" && fill.imageHash === asset.sha256) return fill;
      registerSvgVectorAsset(graph, asset, svgState);
      graph.images.set(asset.sha256, asset.renderBytes ?? asset.bytes);
      return {
        type: "IMAGE",
        pencilImage: image,
        imageHash: asset.sha256,
        imageScaleMode: imageScaleMode(image.mode),
        // Skia modulates shader output by the paint color. Keep image pixels
        // fully visible instead of multiplying them by transparent black.
        color: { r: 1, g: 1, b: 1, a: 1 },
        opacity: Number(image.opacity ?? 1),
        blendMode: pencilBlendMode(image.blendMode),
        visible: image.enabled !== false,
      };
    });
    if (fills.some((fill, index) => fill !== node.fills[index])) {
      graph.updateNode(node.id, { fills });
      changedIds.push(node.id);
    }
  }
  finalizeSvgVectorAssets(graph, svgState);
  return changedIds;
}

export function refreshOpenPencilImageAssets(editor, document, assets) {
  const { changedIds, shaderChanged } = editor.runDerivedGraphMutation(() => {
    const changedIds = applyImageAssets(editor.graph, assets);
    const before = editor.graph.images.size;
    applyShaderAssets(editor.graph, document, assets);
    return { changedIds, shaderChanged: editor.graph.images.size !== before };
  });
  if (shaderChanged) {
    editor.requestRender();
  } else if (changedIds.length > 0) {
    for (const renderer of editor.canvasRenderers ?? []) {
      for (const nodeId of changedIds) {
        renderer.invalidateSceneTilesForNode(editor.graph, nodeId, { fills: [] });
      }
    }
    editor.requestRender(true);
  }
  return changedIds.length;
}

function imageScaleMode(mode) {
  if (mode === "fit") return "FIT";
  if (mode === "stretch") return "STRETCH";
  if (mode === "tile") return "TILE";
  return "FILL";
}

function pencilBlendMode(value) {
  if (!value || value === "normal") return "NORMAL";
  if (value === "light") return "LIGHTEN";
  return value.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase();
}

export function fitOpenPencilDesign(editor, viewport) {
  const pageNodes = editor.graph.getChildren(editor.state.currentPageId);
  if (pageNodes.length === 0) return null;
  const bounds = computeBounds(pageNodes);
  const left = Math.max(0, viewport.left ?? 0);
  const right = Math.max(0, viewport.right ?? 0);
  const top = Math.max(0, viewport.top ?? 0);
  const bottom = Math.max(0, viewport.bottom ?? 0);
  const availableWidth = Math.max(1, viewport.width - left - right);
  const availableHeight = Math.max(1, viewport.height - top - bottom);
  const padding = 80;
  const paddedWidth = bounds.width + padding * 2;
  const paddedHeight = bounds.height + padding * 2;
  const zoom = Math.min(availableWidth / paddedWidth, availableHeight / paddedHeight, 1);
  const previous = {
    panX: editor.state.panX,
    panY: editor.state.panY,
    zoom: editor.state.zoom,
  };
  editor.state.zoom = zoom;
  editor.state.panX = left + (availableWidth - paddedWidth * zoom) / 2
    - bounds.x * zoom + padding * zoom;
  editor.state.panY = top + (availableHeight - paddedHeight * zoom) / 2
    - bounds.y * zoom + padding * zoom;
  editor.requestRepaint();
  return {
    previous,
    panX: editor.state.panX,
    panY: editor.state.panY,
    zoom: editor.state.zoom,
  };
}

export function analyzeOpenPencilCompatibility(document, assets = new Map(), preparedDocument = null) {
  const prepared = preparedDocument ?? prepareOpenPencilRenderDocument(document, { assets });
  const issues = [...prepared.issues];
  walkPenNodes(document.children, (node) => {
    if (!VISUAL_NODE_TYPES.has(node.type)) {
      issues.push({
        nodeId: node.id,
        kind: "node-type",
        message: `${node.type} is preserved but Canvas does not currently render this node type.`,
      });
    }
    for (const fill of Array.isArray(node.fill) ? node.fill : node.fill ? [node.fill] : []) {
      const supportedFill = ["solid", "color", "gradient"].includes(fill?.type)
        || fill?.type === "image"
        || fill?.type === "shader" && Boolean(fill.__canvasShader)
        || fill?.type === "mesh_gradient" && Boolean(fill.__canvasMesh);
      if (fill?.type === "shader" && !supportedFill) continue;
      if (fill?.type === "mesh_gradient" && !supportedFill) continue;
      if (typeof fill === "object" && fill.type && !supportedFill) {
        issues.push({
          nodeId: node.id,
          kind: "fill",
          message: `${fill.type} fill is preserved but Canvas does not currently render this fill type.`,
        });
      }
    }
    for (const effect of Array.isArray(node.effect) ? node.effect : node.effect ? [node.effect] : []) {
      if (effect?.type && !["shadow", "blur", "background_blur"].includes(effect.type)) {
        issues.push({
          nodeId: node.id,
          kind: "effect",
          message: `${effect.type} effect is preserved but Canvas does not currently render this effect type.`,
        });
      }
    }
    if (node.layout && !["row", "horizontal", "column", "vertical", "none"].includes(node.layout)) {
      issues.push({
        nodeId: node.id,
        kind: "layout",
        message: `${node.layout} layout is preserved but Canvas does not currently render this layout mode.`,
      });
    }
  });
  const sourceNodeIds = new Set();
  walkPenNodes(document.children, (node) => sourceNodeIds.add(node.id));
  walkPenNodes(document.children, (node) => {
    if (node.type !== "ref") return;
    // Imported refs are resolved by the import loader. Every local frame becomes a
    // component definition when a ref targets its ID; no marker field is required.
    if (typeof node.ref === "string") {
      const [alias] = node.ref.split(":", 1);
      if (
        sourceNodeIds.has(node.ref)
        || (node.ref.includes(":") && Object.hasOwn(document.imports ?? {}, alias))
      ) return;
    }
    issues.push({
      nodeId: node.id,
      kind: "component",
      message: `Component ${node.ref ?? "(missing)"} is preserved but is unavailable to the Canvas render graph.`,
    });
  });
  return issues;
}

export function sceneUpdateToMutations(nodeId, changes) {
  const mutations = [];
  const addMutation = (property, value) => {
    mutations.push({ kind: "set-property", nodeId, property, value });
  };
  for (const [sceneProperty, penProperty] of DIRECT_PROPERTY_MAP) {
    if (!(sceneProperty in changes)) continue;
    addMutation(penProperty, changes[sceneProperty]);
  }
  if ("layoutMode" in changes) {
    const value = changes.layoutMode === "HORIZONTAL"
      ? "horizontal"
      : changes.layoutMode === "VERTICAL"
        ? "vertical"
        : "none";
    addMutation("layout", value);
  }
  if ("itemSpacing" in changes) {
    addMutation("gap", changes.itemSpacing);
  }
  if (["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].some((key) => key in changes)) {
    const values = [
      changes.paddingTop ?? 0,
      changes.paddingRight ?? 0,
      changes.paddingBottom ?? 0,
      changes.paddingLeft ?? 0,
    ];
    addMutation("padding", values.every((value) => value === values[0]) ? values[0] : values);
  }
  if ("textAlignHorizontal" in changes) {
    const value = ({ CENTER: "center", RIGHT: "right", JUSTIFIED: "justified" })[
      changes.textAlignHorizontal
    ] ?? "left";
    addMutation("textAlign", value);
  }
  if ("textAlignVertical" in changes) {
    const value = ({ CENTER: "center", BOTTOM: "bottom" })[changes.textAlignVertical] ?? "top";
    addMutation("textAlignVertical", value);
  }
  if ("fills" in changes) {
    const solid = changes.fills?.find((fill) => fill.visible !== false && fill.type === "SOLID");
    addMutation("fill", solid ? rgbaToHex(solid.color, solid.opacity) : null);
  }
  return mutations;
}

export function penPropertyToSceneChanges(node, property, value) {
  for (const [sceneProperty, penProperty] of DIRECT_PROPERTY_MAP) {
    if (penProperty === property) return { [sceneProperty]: value };
  }
  if (property === "gap") return { itemSpacing: value };
  if (property === "padding") {
    const values = normalizePadding(value);
    if (!values) return null;
    return {
      paddingTop: values[0],
      paddingRight: values[1],
      paddingBottom: values[2],
      paddingLeft: values[3],
    };
  }
  if (property === "fill") {
    const color = parseHexColor(value);
    if (!color) return null;
    const previous = node?.fills?.find((fill) => fill.type === "SOLID") ?? {};
    return { fills: [{ ...previous, type: "SOLID", visible: true, opacity: 1, color }] };
  }
  return null;
}

export function sceneEventToPenMutations(
  editor,
  document,
  nodeId,
  changes,
  previousSceneValues,
  { requireSelected = true } = {},
) {
  if (requireSelected && !editor.state.selectedIds.has(nodeId)) return [];
  const selection = resolveCanvasNodeSelection({ document, graph: editor.graph, selectedId: nodeId });
  if (!selection?.effectiveNode || !isOpenPencilEditableNode(selection.effectiveNode)) return [];
  const mutations = sceneUpdateToMutations(
    nodeId,
    changedSceneProperties(previousSceneValues, changes),
  );
  if (!selection.isInstanceDescendant) return mutations;
  return mutations.map((mutation) => ({
    kind: "set-property-path",
    nodeId: selection.instanceId,
    property: "descendants",
    path: [selection.descendantPath, mutation.property],
    value: mutation.value,
  }));
}

export function sceneTextEditCommitMutations(editor, document, nodeId, previousSceneValues) {
  const node = editor.graph.getNode(nodeId);
  if (!node) return [];
  const sourceNode = findPenNode(document, nodeId);
  if (!sourceNode) {
    const insertion = sceneNodeInsertionMutation(editor, node);
    return insertion ? [insertion] : [];
  }
  const mutations = sceneEventToPenMutations(
    editor,
    document,
    nodeId,
    sceneNodePropertySnapshot(node),
    previousSceneValues,
  );
  const textChanged = previousSceneValues?.text !== node.text;
  const runsChanged = !Object.is(previousSceneValues?.styleRuns, node.styleRuns);
  if (!textChanged && !runsChanged) return mutations;

  const selection = resolveCanvasNodeSelection({ document, graph: editor.graph, selectedId: nodeId });
  const effectiveSource = selection?.effectiveNode ?? sourceNode;
  const richMutations = [];
  if (Array.isArray(effectiveSource.marks)) {
    richMutations.push({
      kind: "set-property",
      nodeId,
      property: "marks",
      value: sceneStyleRunsToMarks(node, effectiveSource, previousSceneValues?.text),
    });
  }
  if (textChanged && Array.isArray(effectiveSource.paragraphs)) {
    richMutations.push({
      kind: "set-property",
      nodeId,
      property: "paragraphs",
      value: remapParagraphsForTextEdit(effectiveSource, node.text),
    });
  }
  if (!selection?.isInstanceDescendant) return [...mutations, ...richMutations];
  return [...mutations, ...richMutations.map((mutation) => ({
    kind: "set-property-path",
    nodeId: selection.instanceId,
    property: "descendants",
    path: [selection.descendantPath, mutation.property],
    value: mutation.value,
  }))];
}

export function sceneStyleRunsToMarks(sceneNode, sourceNode, previousText = sourceNode.content ?? "") {
  const content = sceneNode.text ?? "";
  const { from, to, inserted } = singleTextEdit(previousText, content);
  const preserved = (sourceNode.marks ?? [])
    .filter((mark) => mark.type === "link")
    .map((mark) => remapRangeForReplacement(mark, from, to, inserted.length))
    .filter(Boolean);
  const marks = [...preserved];
  for (const run of sceneNode.styleRuns ?? []) {
    const range = { from: run.start, to: run.start + run.length };
    const style = run.style ?? {};
    appendSceneMark(marks, range, "weight", style.fontWeight);
    appendSceneMark(marks, range, "italic", style.italic);
    const underline = style.underline !== undefined
      ? style.underline
      : style.textDecoration !== undefined ? style.textDecoration === "UNDERLINE" : undefined;
    const strikethrough = style.strikethrough !== undefined
      ? style.strikethrough
      : style.textDecoration !== undefined ? style.textDecoration === "STRIKETHROUGH" : undefined;
    appendSceneMark(marks, range, "underline", underline);
    appendSceneMark(marks, range, "strikethrough", strikethrough);
    appendSceneMark(marks, range, "fontFamily", style.fontFamily);
    appendSceneMark(marks, range, "fontSize", style.fontSize);
    appendSceneMark(marks, range, "letterSpacing", style.letterSpacing);
    appendSceneMark(marks, range, "wordSpacing", style.wordSpacing);
    appendSceneMark(marks, range, "lang", style.textLanguage);
    const solid = style.fills?.find((fill) => fill.visible !== false && fill.type === "SOLID");
    appendSceneMark(marks, range, "fill", solid ? rgbaToHex(solid.color, solid.opacity) : undefined);
  }
  return mergeCanvasMarks(marks.filter((mark) => mark.from >= 0 && mark.from < mark.to && mark.to <= content.length));
}

function appendSceneMark(marks, range, type, value) {
  if (value === undefined || value === null) return;
  marks.push({ type, ...range, value });
}

function remapParagraphsForTextEdit(sourceNode, content) {
  const previous = sourceNode.content ?? "";
  const edit = singleTextEdit(previous, content);
  if (content.length === 0) return [];
  const paragraphs = sourceNode.paragraphs?.length
    ? sourceNode.paragraphs
    : [{ from: 0, to: previous.length }];
  const result = [];
  let from = 0;
  while (from < content.length) {
    const newline = content.indexOf("\n", from);
    const to = newline < 0 ? content.length : newline + 1;
    const contributors = new Set();
    for (let offset = from; offset < to; offset += 1) {
      if (offset >= edit.from && offset < edit.from + edit.inserted.length) continue;
      const oldOffset = offset < edit.from ? offset : offset - edit.inserted.length + (edit.to - edit.from);
      const paragraphIndex = paragraphs.findIndex((paragraph) => paragraph.from <= oldOffset && oldOffset < paragraph.to);
      if (paragraphIndex >= 0) contributors.add(paragraphIndex);
    }
    let paragraphIndex = contributors.size ? Math.max(...contributors) : paragraphs.findIndex((paragraph) => paragraph.from <= edit.from && edit.from < paragraph.to);
    if (paragraphIndex < 0) paragraphIndex = Math.max(0, paragraphs.length - 1);
    const { from: ignoredFrom, to: ignoredTo, ...style } = paragraphs[paragraphIndex] ?? {};
    void ignoredFrom; void ignoredTo;
    result.push({ from, to, ...style });
    from = to;
  }
  return result;
}

function singleTextEdit(previous, next) {
  let from = 0;
  while (from < previous.length && from < next.length && previous[from] === next[from]) from += 1;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { from, to: oldEnd, inserted: next.slice(from, newEnd) };
}

function remapRangeForReplacement(range, from, to, insertedLength, paragraph = false) {
  const removed = to - from;
  const mapDelete = (offset) => offset <= from ? offset : offset >= to ? offset - removed : from;
  let mapped = { ...range, from: mapDelete(range.from), to: mapDelete(range.to) };
  if (mapped.from >= mapped.to && !paragraph) return null;
  const inclusive = paragraph || isMarkInclusive(mapped.type);
  if (mapped.to < from) return mapped;
  if (mapped.from > from) mapped = { ...mapped, from: mapped.from + insertedLength, to: mapped.to + insertedLength };
  else if (mapped.from < from && from < mapped.to) mapped = { ...mapped, to: mapped.to + insertedLength };
  else if (mapped.to === from && inclusive) mapped = { ...mapped, to: mapped.to + insertedLength };
  else if (mapped.from === from) mapped = inclusive
    ? { ...mapped, to: mapped.to + insertedLength }
    : { ...mapped, from: mapped.from + insertedLength, to: mapped.to + insertedLength };
  return mapped.from < mapped.to ? mapped : null;
}

function mergeCanvasMarks(marks) {
  const sorted = [...marks].sort((a, b) => a.from - b.from || a.to - b.to || a.type.localeCompare(b.type));
  const result = [];
  for (const mark of sorted) {
    const previous = result.at(-1);
    if (previous && previous.to === mark.from && previous.type === mark.type
      && JSON.stringify(previous.value) === JSON.stringify(mark.value)) previous.to = mark.to;
    else result.push({ ...mark });
  }
  return result;
}

export function sceneNodeInsertionMutation(editor, node) {
  const penNode = sceneNodeToCanvasNode(node);
  const position = sceneNodePosition(editor, node);
  if (!penNode || position === null) return null;
  const pageIds = new Set(editor.graph.getPages(true).map((page) => page.id));
  return {
    kind: "insert-node",
    node: penNode,
    parentId: pageIds.has(node.parentId) ? null : node.parentId,
    position,
  };
}

export function sceneNodePosition(editor, node) {
  const parent = editor.graph.getNode(node.parentId);
  const position = parent?.childIds?.indexOf(node.id) ?? -1;
  return position < 0 ? null : position;
}

export function isOpenPencilEditableNode(node) {
  return Boolean(
    node
    && !["note", "context", "prompt", "script"].includes(node.type)
    && VISUAL_NODE_TYPES.has(node.type),
  );
}

export function sceneNodePropertySnapshot(node) {
  return Object.fromEntries(
    [...TRACKED_SCENE_PROPERTIES]
      .filter((property) => property in node)
      .map((property) => [property, node[property]]),
  );
}

export function changedSceneProperties(previous, changes) {
  return Object.fromEntries(
    Object.entries(changes).filter(
      ([property, value]) => TRACKED_SCENE_PROPERTIES.has(property)
        && !Object.is(previous?.[property], value),
    ),
  );
}

export function sceneNodeToCanvasNode(node) {
  const type = ({
    FRAME: "frame",
    RECTANGLE: "rectangle",
    ROUNDED_RECTANGLE: "rectangle",
    ELLIPSE: "ellipse",
    TEXT: "text",
    LINE: "line",
    VECTOR: "path",
  })[node.type];
  if (!type) return null;
  const pen = {
    id: node.id,
    type,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  };
  if (type === "frame") pen.children = [];
  if (type === "text") {
    pen.content = node.text;
    pen.fontFamily = node.fontFamily;
    pen.fontSize = node.fontSize;
    pen.fontWeight = node.fontWeight;
    pen.marks = sceneStyleRunsToMarks(node, { content: node.text, marks: [] });
    pen.paragraphs = paragraphPartition(node.text ?? "");
  }
  const solid = node.fills?.find((fill) => fill.visible && fill.type === "SOLID");
  if (solid) pen.fill = rgbaToHex(solid.color, solid.opacity);
  return pen;
}

function paragraphPartition(content) {
  if (!content) return [];
  const paragraphs = [];
  let from = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    paragraphs.push({ from, to: index + 1 });
    from = index + 1;
  }
  if (from < content.length) paragraphs.push({ from, to: content.length });
  return paragraphs;
}

export function findPenNode(document, nodeId) {
  let match = null;
  walkPenNodes(document.children, (node) => {
    if (node.id === nodeId) match = node;
  });
  return match;
}

function walkPenNodes(nodes, visit) {
  for (const node of nodes ?? []) {
    visit(node);
    walkPenNodes(node.children, visit);
  }
}

function rgbaToHex(color, opacity = 1) {
  const channel = (value) => Math.round(Math.max(0, Math.min(1, value ?? 0)) * 255)
    .toString(16)
    .padStart(2, "0");
  const alpha = channel((color?.a ?? 1) * opacity);
  const value = `#${channel(color?.r)}${channel(color?.g)}${channel(color?.b)}`;
  return alpha === "ff" ? value : `${value}${alpha}`;
}

function normalizePadding(value) {
  const input = Array.isArray(value)
    ? value
    : String(value).split(",").map((part) => Number(part.trim()));
  if (!input.length || input.length > 4 || input.some((part) => !Number.isFinite(Number(part)))) return null;
  const values = input.map(Number);
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return values;
}

function parseHexColor(value) {
  const match = String(value).trim().match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu);
  if (!match) return null;
  const hex = match[1].length <= 4
    ? [...match[1]].map((part) => `${part}${part}`).join("")
    : match[1];
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
}
