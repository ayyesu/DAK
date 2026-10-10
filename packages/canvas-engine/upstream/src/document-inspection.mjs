import { getTextMeasurer, setTextMeasurer } from "../vendor/open-pencil/engine.source.mjs";
import { computeOverlaps, createOpenPencilGraph } from "./openpencil-engine.mjs";
import { prepareOpenPencilRenderDocument } from "./openpencil-render-document.mjs";
import { designValidationIssues } from "./document-review.mjs";

export function inspectDocument(document, nodes, requestedLimit = 500, nodeIds) {
  // The editor and screenshot renderer install a process-wide text measurer as
  // fonts become available. Inspection must not change for an unchanged source.
  const previousTextMeasurer = getTextMeasurer();
  try {
    setTextMeasurer(null);
    return inspectWithStableText(document, nodes, requestedLimit, nodeIds);
  } finally {
    setTextMeasurer(previousTextMeasurer);
  }
}

function inspectWithStableText(document, nodes, requestedLimit, nodeIds) {
  const limit = Math.min(1_000, Math.max(1, Number(requestedLimit) || 500));
  const prepared = prepareOpenPencilRenderDocument(document);
  const graph = createOpenPencilGraph(document, new Map(), prepared);
  const overflowIssues = computeOverlaps(graph, {
    category: "parent-overflow",
    include_absolute: true,
    limit: 10_000,
  }).overlaps.map((overlap) => ({
    nodeId: overlap.nodeA.id,
    kind: "parent-overflow",
    ancestorId: overlap.nodeB.id,
    severity: overlap.severity,
    message: overlap.message,
    suggestion: overlap.suggestion,
  }));
  const reviewIssues = [...prepared.issues, ...designValidationIssues(document), ...overflowIssues];
  const issuesByNode = new Map();
  for (const issue of reviewIssues) {
    if (typeof issue.nodeId !== "string") continue;
    const items = issuesByNode.get(issue.nodeId) ?? [];
    items.push(issue);
    issuesByNode.set(issue.nodeId, items);
  }
  const nodeById = new Map(nodes.map((entry) => [entry.node.id, entry.node]));
  const parentById = new Map(nodes.map((entry) => [entry.node.id, entry.parentId]));
  const selectedNodes = nodeIds
    ? nodes.filter((entry) => nodeIds.has(entry.node.id))
    : nodes;
  const boundsById = new Map();
  const ensureBounds = (nodeId) => {
    if (!boundsById.has(nodeId)) boundsById.set(nodeId, sceneBounds(graph, nodeId));
    return boundsById.get(nodeId);
  };
  for (const { node } of selectedNodes) {
    ensureBounds(node.id);
    let parentId = parentById.get(node.id);
    while (parentId) {
      ensureBounds(parentId);
      parentId = parentById.get(parentId);
    }
  }
  return {
    items: selectedNodes.slice(0, limit).map(({ node, depth, parentId, index }) => ({
      id: node.id,
      type: node.type,
      name: node.name ?? null,
      depth,
      parentId,
      index,
      properties: Object.fromEntries(
        Object.entries(node).filter(([key]) => !["id", "type", "children"].includes(key)),
      ),
      bounds: boundsById.get(node.id),
      problems: [
        ...(issuesByNode.get(node.id) ?? []).map((issue) => structuredClone(issue)),
        ...clippingProblems(node.id, nodeById, parentById, boundsById),
      ],
    })),
    truncated: selectedNodes.length > limit,
    total: selectedNodes.length,
    issues: reviewIssues,
  };
}

function sceneBounds(graph, nodeId) {
  if (!graph.getNode(nodeId)) return null;
  const bounds = graph.getAbsoluteBounds(nodeId);
  if (!bounds) return null;
  const result = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height),
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function clippingProblems(nodeId, nodeById, parentById, boundsById) {
  const bounds = boundsById.get(nodeId);
  if (!bounds) return [];
  let parentId = parentById.get(nodeId);
  while (parentId) {
    const parent = nodeById.get(parentId);
    if (parent?.clip === true || parent?.clipsContent === true) {
      const clippingBounds = boundsById.get(parentId);
      if (clippingBounds && !contains(clippingBounds, bounds)) {
        return [{
          nodeId,
          kind: "clipping",
          ancestorId: parentId,
          message: `Node ${nodeId} extends beyond clipping ancestor ${parentId}.`,
        }];
      }
    }
    parentId = parentById.get(parentId);
  }
  return [];
}

function contains(outer, inner) {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}
