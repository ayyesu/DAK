import {
  Y,
  createModel,
  materializePen,
  openModel,
  setNodeProperty,
  setNodePropertyPath,
  insertNode,
  moveNode,
  deleteNode,
  restoreNode,
  replaceModelContent,
} from "../collaboration/pen-yjs-model.mjs";
import { base64ToBytes, bytesToBase64 } from "./codec.mjs";

export const LOCAL_ORIGIN = Symbol("canvas-local");
export const ENGINE_ORIGIN = Symbol("canvas-engine");
export const REMOTE_ORIGIN = Symbol("canvas-remote");

export function createDocumentModel(source) {
  return createModel(source, { origin: LOCAL_ORIGIN });
}

export function createUndoManager(model) {
  return new Y.UndoManager([model.nodes, model.documentFields], {
    trackedOrigins: new Set([LOCAL_ORIGIN, ENGINE_ORIGIN]),
    captureTimeout: 500,
  });
}

export function createDocumentOperationUpdates(model, document) {
  const cloneDoc = new Y.Doc();
  Y.applyUpdate(cloneDoc, Y.encodeStateAsUpdate(model.doc), REMOTE_ORIGIN);
  const clone = openModel(cloneDoc);
  const operationOrigin = Symbol("canvas-operation");
  const undo = new Y.UndoManager([clone.nodes, clone.documentFields], {
    trackedOrigins: new Set([operationOrigin]),
    captureTimeout: 0,
  });
  try {
    const beforeVector = Y.encodeStateVector(cloneDoc);
    replaceDocument(clone, document, operationOrigin);
    if (!undo.canUndo()) throw new Error("Canvas operation did not produce an undoable update.");
    const forward = Y.encodeStateAsUpdate(cloneDoc, beforeVector);
    const afterVector = Y.encodeStateVector(cloneDoc);
    undo.undo();
    const inverse = Y.encodeStateAsUpdate(cloneDoc, afterVector);
    if (inverse.byteLength <= 2) {
      throw new Error("Canvas operation did not produce a durable inverse update.");
    }
    return { forward, inverse };
  } finally {
    undo.destroy();
    cloneDoc.destroy();
  }
}

export function restoreDocumentModel(payload, options = {}) {
  const doc = new Y.Doc();
  const snapshotBytes = measureRestorePhase(
    options,
    "document.snapshot-decode",
    () => base64ToBytes(payload.snapshot.state),
  );
  measureRestorePhase(
    options,
    "document.snapshot-apply",
    () => Y.applyUpdate(doc, snapshotBytes, REMOTE_ORIGIN),
    { bytes: snapshotBytes.byteLength },
  );
  for (const update of payload.updates ?? []) {
    const updateBytes = measureRestorePhase(
      options,
      "document.update-decode",
      () => base64ToBytes(update.update),
      { sequence: update.sequence },
    );
    measureRestorePhase(
      options,
      "document.update-apply",
      () => Y.applyUpdate(doc, updateBytes, REMOTE_ORIGIN),
      { sequence: update.sequence, bytes: updateBytes.byteLength },
    );
  }
  return openModel(doc);
}

function measureRestorePhase(options, name, action, details = {}) {
  const startedAt = performance.now();
  const result = action();
  options.onPerformance?.(name, performance.now() - startedAt, details);
  return result;
}

export function encodeState(model) {
  return bytesToBase64(Y.encodeStateAsUpdate(model.doc));
}

export function encodeUpdate(update) {
  return bytesToBase64(update);
}

export function applyRemoteUpdate(model, update) {
  let changed = false;
  const observe = (_update, origin) => {
    if (origin === REMOTE_ORIGIN) changed = true;
  };
  model.doc.on("update", observe);
  try {
    Y.applyUpdate(model.doc, base64ToBytes(update), REMOTE_ORIGIN);
  } finally {
    model.doc.off("update", observe);
  }
  return changed;
}

export function reconcileDocumentPayload(model, payload, lastSequence = 0) {
  let nextSequence = Number.isFinite(Number(lastSequence)) ? Number(lastSequence) : 0;
  const snapshotSequence = Number(payload.snapshot?.throughSequence ?? 0);
  // The sequence watermark records what the server has accepted, not every
  // update this client has applied. An offline client can append its own update
  // at sequence N before it catches up with a remote update at N - 1. Yjs
  // updates are idempotent, so replay the payload instead of using the watermark
  // as an application filter.
  if (payload.snapshot?.state) {
    applyRemoteUpdate(model, payload.snapshot.state);
  }
  nextSequence = Math.max(nextSequence, snapshotSequence);
  const updates = [...(payload.updates ?? [])].sort(
    (left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0),
  );
  for (const update of updates) {
    const sequence = Number(update.sequence ?? 0);
    if (!update.update) continue;
    applyRemoteUpdate(model, update.update);
    nextSequence = Math.max(nextSequence, sequence);
  }
  return nextSequence;
}

export function applyIncrementalDocumentPayload(
  model,
  payload,
  { lastSequence = 0, lastCatchUpSequence = 0 } = {},
) {
  if (payload.requiresSnapshot) {
    return { requiresSnapshot: true, changed: false, lastSequence, lastCatchUpSequence };
  }
  let changed = false;
  let nextSequence = Number(lastSequence) || 0;
  for (const update of [...(payload.updates ?? [])].sort(
    (left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0),
  )) {
    if (!update.update) continue;
    changed = applyRemoteUpdate(model, update.update) || changed;
    nextSequence = Math.max(nextSequence, Number(update.sequence ?? 0));
  }
  return {
    requiresSnapshot: false,
    changed,
    lastSequence: nextSequence,
    lastCatchUpSequence: Math.max(
      Number(lastCatchUpSequence) || 0,
      Number(payload.latestSequence) || 0,
    ),
  };
}

export function materialize(model) {
  return materializePen(model);
}

export function listNodes(model) {
  return listDocumentNodes(materialize(model));
}

export function listDocumentNodes(document) {
  const output = [];
  const visit = (nodes = [], depth = 0, parentId = null) => {
    nodes.forEach((node, index) => {
      output.push({ node, depth, parentId, index });
      visit(node.children, depth + 1, node.id);
    });
  };
  visit(document.children);
  return output;
}

export function mutate(model, mutation, origin = LOCAL_ORIGIN) {
  switch (mutation.kind) {
    case "set-property":
      return setNodeProperty(model, mutation.nodeId, mutation.property, mutation.value, origin);
    case "set-property-path":
      return setNodePropertyPath(
        model,
        mutation.nodeId,
        mutation.property,
        mutation.path,
        mutation.value,
        origin,
      );
    case "insert-node":
      return insertNode(model, mutation.node, mutation.parentId ?? null, mutation.position, origin);
    case "move-node":
      return moveNode(model, mutation.nodeId, mutation.parentId ?? null, mutation.position, origin);
    case "delete-node":
      return deleteNode(model, mutation.nodeId, origin);
    case "restore-node":
      return restoreNode(model, mutation.nodeId, origin);
    default:
      throw new Error(`Unsupported Canvas mutation: ${String(mutation?.kind)}`);
  }
}

export function replaceDocument(model, document, origin = LOCAL_ORIGIN) {
  return replaceModelContent(model, document, origin);
}

export { Y };
