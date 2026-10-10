export function formatCanvasNodeReference({ node, nodeId }) {
  const id = nodeId ?? node?.id;
  if (!id) throw new Error("A Canvas node reference requires a node ID.");
  return `Node ID: ${id}`;
}

export function resolveCanvasNodeReferenceId({ document, graph, selectedId }) {
  if (!selectedId) return null;
  const sourceIds = collectSourceNodeIds(document?.children);
  if (sourceIds.has(selectedId)) return selectedId;
  if (!graph?.getNode) return null;

  const descendantPath = [];
  const visited = new Set();
  let current = graph.getNode(selectedId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (sourceIds.has(current.id)) {
      return descendantPath.length > 0
        ? [current.id, ...descendantPath.reverse()].join("/")
        : current.id;
    }
    if (typeof current.componentId !== "string" || current.componentId.length === 0) {
      return null;
    }
    descendantPath.push(stableComponentId(graph, current.componentId, sourceIds));
    current = current.parentId ? graph.getNode(current.parentId) : null;
  }
  return null;
}

export function resolveCanvasNodeSelection({ document, graph, selectedId }) {
  if (!selectedId) return null;
  const referenceId = resolveCanvasNodeReferenceId({ document, graph, selectedId });
  const runtimeNode = graph?.getNode?.(selectedId) ?? null;
  if (!referenceId) {
    return {
      selectedId,
      referenceId: null,
      runtimeNode,
      sourceNode: null,
      effectiveNode: null,
      instanceId: null,
      descendantPath: null,
      override: null,
      isInstanceDescendant: false,
    };
  }

  const sourceNodes = collectSourceNodes(document?.children);
  const [instanceId, ...descendantIds] = referenceId.split("/");
  const descendantPath = descendantIds.length > 0 ? descendantIds.join("/") : null;
  const sourceNodeId = descendantIds.at(-1) ?? instanceId;
  const sourceNode = sourceNodes.get(sourceNodeId) ?? null;
  const instanceNode = sourceNodes.get(instanceId) ?? null;
  const override = descendantPath && isPlainObject(instanceNode?.descendants?.[descendantPath])
    ? instanceNode.descendants[descendantPath]
    : null;
  const effectiveNode = sourceNode
    ? { ...structuredClone(sourceNode), ...structuredClone(override ?? {}) }
    : null;

  return {
    selectedId,
    referenceId,
    runtimeNode,
    sourceNode,
    effectiveNode,
    instanceId,
    descendantPath,
    override,
    isInstanceDescendant: descendantPath !== null,
  };
}

function collectSourceNodeIds(nodes = [], output = new Set()) {
  for (const node of nodes ?? []) {
    if (typeof node?.id === "string") output.add(node.id);
    collectSourceNodeIds(node?.children, output);
  }
  return output;
}

function collectSourceNodes(nodes = [], output = new Map()) {
  for (const node of nodes ?? []) {
    if (typeof node?.id === "string") output.set(node.id, node);
    collectSourceNodes(node?.children, output);
  }
  return output;
}

function stableComponentId(graph, componentId, sourceIds) {
  const visited = new Set();
  let id = componentId;
  while (!visited.has(id)) {
    visited.add(id);
    if (sourceIds.has(id)) break;
    const component = graph.getNode(id);
    if (typeof component?.componentId !== "string" || component.componentId.length === 0) break;
    id = component.componentId;
  }
  return id;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function copyTextToClipboard(text, {
  documentObject = globalThis.document,
  navigatorObject = globalThis.navigator,
} = {}) {
  if (documentObject?.body && typeof documentObject.execCommand === "function") {
    const input = documentObject.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.setAttribute("aria-hidden", "true");
    input.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
    documentObject.body.append(input);
    input.select();
    const copied = documentObject.execCommand("copy");
    input.remove();
    if (copied) return;
  }
  if (typeof navigatorObject?.clipboard?.writeText === "function") {
    await navigatorObject.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard writing is unavailable in this Canvas frame.");
}
