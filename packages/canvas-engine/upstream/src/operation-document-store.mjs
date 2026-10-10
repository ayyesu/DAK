import {
  LOCAL_ORIGIN,
  Y,
  applyIncrementalDocumentPayload,
  materialize,
  restoreDocumentModel,
} from "./document-model.mjs";

export function createOperationDocumentStore(api, { maxEntries = 2 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("Operation document cache maxEntries must be a positive integer.");
  }
  const entries = new Map();
  const queues = new Map();

  const remove = (documentId) => {
    const entry = entries.get(documentId);
    if (!entry) return;
    entries.delete(documentId);
    entry.model?.doc.destroy();
  };

  const touch = (entry) => {
    entries.delete(entry.documentId);
    entries.set(entry.documentId, entry);
  };

  const evict = () => {
    while (entries.size > maxEntries) {
      const candidate = [...entries.values()].find((entry) => entry.pins === 0);
      if (!candidate) return;
      remove(candidate.documentId);
    }
  };

  const load = async (documentId) => {
    const { payload, projectionOnly } = await api.getDocumentForExecution(documentId);
    const sequence = authoritativeSequence(payload);
    const entry = {
      documentId,
      model: projectionOnly ? null : restoreDocumentModel(payload),
      source: projectionOnly ? payload.snapshot.source : null,
      sequence,
      catchUpSequence: sequence,
      pins: 0,
    };
    const previous = entries.get(documentId);
    entries.set(documentId, entry);
    previous?.model?.doc.destroy();
    return entry;
  };

  const refresh = async (documentId) => {
    let entry = entries.get(documentId);
    if (!entry) return load(documentId);
    let hasMore;
    do {
      const afterSequence = entry.catchUpSequence;
      let payload;
      try {
        payload = await api.listUpdates(documentId, afterSequence);
      } catch (error) {
        if (error?.status === 403 || error?.status === 404) remove(documentId);
        throw error;
      }
      if (payload.requiresSnapshot || (!entry.model && (payload.updates?.length ?? 0) > 0)) {
        return load(documentId);
      }
      if (entry.model) {
        const result = applyIncrementalDocumentPayload(entry.model, payload, {
          lastSequence: entry.sequence,
          lastCatchUpSequence: entry.catchUpSequence,
        });
        if (result.requiresSnapshot) return load(documentId);
        entry.sequence = result.lastSequence;
        entry.catchUpSequence = result.lastCatchUpSequence;
      } else {
        entry.catchUpSequence = Math.max(
          entry.catchUpSequence,
          Number(payload.latestSequence) || 0,
        );
      }
      hasMore = payload.hasMore === true;
      if (hasMore && entry.catchUpSequence <= afterSequence) {
        throw new Error("Canvas operation catch-up did not advance its update watermark.");
      }
    } while (hasMore);
    return entry;
  };

  const run = async (documentId, operation) => {
    const previous = queues.get(documentId) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    queues.set(documentId, turn);
    await previous.catch(() => undefined);
    let entry;
    try {
      entry = await refresh(documentId);
      entry.pins += 1;
      touch(entry);
      evict();
      return await operation(entry);
    } finally {
      if (entry) entry.pins -= 1;
      release();
      if (queues.get(documentId) === turn) queues.delete(documentId);
      evict();
    }
  };

  const replaceWithPayload = (entry, payload) => {
    const model = restoreDocumentModel(payload);
    entry.model?.doc.destroy();
    entry.model = model;
    entry.source = null;
    entry.sequence = authoritativeSequence(payload);
    entry.catchUpSequence = entry.sequence;
    touch(entry);
    return entry;
  };

  const recordCommittedUpdate = (entry, update, sequence) => {
    if (!entry.model) throw new Error("Canvas cannot retain a committed update without a hydrated document model.");
    Y.applyUpdate(entry.model.doc, update, LOCAL_ORIGIN);
    entry.sequence = sequence;
    entry.catchUpSequence = sequence;
    touch(entry);
  };

  return {
    run,
    source: (entry) => entry.model ? materialize(entry.model) : entry.source,
    replaceWithPayload,
    recordCommittedUpdate,
    clear: () => {
      for (const documentId of [...entries.keys()]) remove(documentId);
    },
  };
}

function authoritativeSequence(payload) {
  return Math.max(
    Number(payload.snapshot?.throughSequence ?? 0),
    ...(payload.updates ?? []).map((update) => Number(update.sequence ?? 0)),
  );
}
