// @effect-diagnostics nodeBuiltinImport:off - A design is a directory of files, so this module is
// deliberately the filesystem boundary for Canvas, the same shape as attachmentStore.
// @effect-diagnostics globalDate:off - Timestamps are wall-clock strings written into those files,
// and the store already takes an injectable clock for tests.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { CanvasModule } from "@dak/contracts";

import { authoritativeSequence, isProjectionCurrent } from "./canvasInvariants.ts";
import type {
  CanvasAppendInput,
  CanvasAppendResult,
  CanvasDocumentChange,
  CanvasDocumentPayload,
  CanvasSnapshot,
  CanvasStore,
  CanvasStoredDocument,
  CanvasStoredUpdate,
} from "./CanvasPorts.ts";

/**
 * Where a design lives on disk, and the only thing that writes one.
 *
 * A document is a snapshot plus an append-only log of Yjs updates. The log is the write path; the
 * snapshot is a compaction artifact that is allowed to lag, which is exactly why
 * `authoritativeSequence` takes the max of both rather than trusting either alone. A crash between
 * an append and its compaction therefore needs no repair step â€” the newer of the two simply wins.
 *
 * All of it sits under `<workspace>/.dak/canvas/<documentId>/`, inside the project it belongs to:
 *
 *   meta.json      title, module, timestamps, trash flag
 *   snapshot.json  { throughSequence, state, source } â€” `state` is the Yjs base, `source` the
 *                  readable projection that humans and git diffs can look at
 *   updates.jsonl  one committed mutation per line, carrying its `clientUpdateId` for idempotency
 *                  and its `inverseUpdate` so the mutation stays undoable
 *
 * The log is never truncated. It is a few hundred bytes per edit, and truncating it would silently
 * discard the `clientUpdateId`s that make a replayed write idempotent â€” a much worse trade than
 * disk we are not short of.
 */

const CANVAS_DIRECTORY = ".dak/canvas";

interface CanvasMeta {
  readonly id: string;
  readonly title: string;
  readonly module: CanvasModule;
  readonly starterFrameId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly trashed: boolean;
}

interface StoredSnapshot {
  readonly throughSequence: number;
  readonly state: string;
  readonly source: unknown;
}

export interface CanvasStoreOptions {
  /** The project directory a design belongs to. Exports and storage never leave it. */
  readonly workspaceRoot: string;
  readonly newDocumentId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * Announces a committed change to whoever is watching. A store without one writes designs that
   * nobody can watch live, which is fine for a single call and wrong for a real project.
   */
  readonly publish?: ((change: CanvasDocumentChange) => void) | undefined;
}
const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await NodeFSP.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const parseUpdates = (source: string): CanvasStoredUpdate[] =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CanvasStoredUpdate);

export const make = (options: CanvasStoreOptions): CanvasStore => {
  const root = NodePath.resolve(options.workspaceRoot);
  const canvasRoot = NodePath.join(root, CANVAS_DIRECTORY);
  const newDocumentId = options.newDocumentId ?? (() => `design-${NodeCrypto.randomUUID()}`);
  const now = options.now ?? (() => new Date());

  /**
   * Announces a change, re-reading the authoritative sequence rather than trusting the caller's
   * arithmetic. A viewer compares sequences to decide whether what it shows is current, so a wrong
   * one is worse than a late one.
   *
   * The read is asynchronous and the write path already returned, so it happens after the fact and
   * swallows failures: the write has committed, and reporting here would invite a retry of applied
   * work. It also means an announcement is at most one read behind, which a subscriber cannot tell
   * from an edit landing during its own render.
   */
  const publish = (documentId: string, known?: { readonly trashed: boolean }): void => {
    const announce = options.publish;
    if (announce === undefined) return;
    void (async () => {
      try {
        const summary = await summarize(await readMeta(documentId));
        announce({
          documentId,
          sequence: summary.sequence,
          trashed: known?.trashed ?? summary.trashed,
          // Read here rather than handed in by the writer: an announcement that carries a stale title
          // would label a tab wrongly, and this read is already being paid for.
          title: summary.title,
          module: summary.module,
        });
      } catch {
        // A document that vanished between the write and this read has nothing to announce.
      }
    })();
  };

  const directoryOf = (documentId: string) => {
    // A document id becomes a path segment, so it is validated rather than trusted. Everything
    // below is generated by `newDocumentId`, but a bad id from anywhere else must not escape root.
    if (documentId.length === 0 || documentId.includes("/") || documentId.includes("\\")) {
      throw new Error(`Unsafe Canvas document id ${JSON.stringify(documentId)}.`);
    }
    const directory = NodePath.join(canvasRoot, documentId);
    if (NodePath.relative(canvasRoot, directory).startsWith("..")) {
      throw new Error(`Canvas document ${documentId} resolves outside the project.`);
    }
    return directory;
  };

  const readMeta = async (documentId: string): Promise<CanvasMeta> => {
    const meta = await readJson<CanvasMeta>(NodePath.join(directoryOf(documentId), "meta.json"));
    if (meta === null) throw new Error(`No Canvas document ${documentId} in this project.`);
    return meta;
  };

  const readSnapshot = async (documentId: string): Promise<StoredSnapshot> => {
    const snapshot = await readJson<StoredSnapshot>(
      NodePath.join(directoryOf(documentId), "snapshot.json"),
    );
    if (snapshot === null) throw new Error(`Canvas document ${documentId} has no snapshot.`);
    return snapshot;
  };

  const readUpdates = async (documentId: string): Promise<CanvasStoredUpdate[]> => {
    try {
      return parseUpdates(
        await NodeFSP.readFile(NodePath.join(directoryOf(documentId), "updates.jsonl"), "utf8"),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
  };

  const summarize = async (meta: CanvasMeta): Promise<CanvasStoredDocument> => {
    const [snapshot, updates] = await Promise.all([readSnapshot(meta.id), readUpdates(meta.id)]);
    return {
      id: meta.id,
      title: meta.title,
      module: meta.module,
      sequence: authoritativeSequence({
        snapshot: { throughSequence: snapshot.throughSequence },
        updates,
      }),
      // Whether the projection has absorbed the log, which is a comparison against the newest
      // committed sequence. The log is never truncated, so counting updates would report every
      // edited design as permanently behind.
      projectionCurrent: isProjectionCurrent({
        snapshot: { throughSequence: snapshot.throughSequence },
        updates,
      }),
      trashed: meta.trashed,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
  };

  const listDocuments: CanvasStore["listDocuments"] = async (input) => {
    let entries: string[];
    try {
      entries = await NodeFSP.readdir(canvasRoot);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    const documents: CanvasStoredDocument[] = [];
    for (const entry of entries) {
      const meta = await readJson<CanvasMeta>(NodePath.join(canvasRoot, entry, "meta.json"));
      if (meta === null) continue;
      documents.push(await summarize(meta));
    }
    const query = input.query?.trim().toLowerCase();
    const filtered = documents
      .filter((document) => input.includeTrash === true || !document.trashed)
      .filter((document) => query === undefined || document.title.toLowerCase().includes(query));
    filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return filtered.slice(0, input.limit ?? 500);
  };

  const getDocument: CanvasStore["getDocument"] = async (documentId) =>
    summarize(await readMeta(documentId));

  const getDocumentForExecution: CanvasStore["getDocumentForExecution"] = async (documentId) => {
    const meta = await readMeta(documentId);
    const [summary, snapshot, updates] = await Promise.all([
      summarize(meta),
      readSnapshot(documentId),
      readUpdates(documentId),
    ]);
    const payload: CanvasDocumentPayload = {
      snapshot: {
        throughSequence: snapshot.throughSequence,
        state: snapshot.state,
        source: snapshot.source,
      } satisfies CanvasSnapshot,
      updates,
    };
    return { summary, payload };
  };

  // Appends for one document are serialized so two edits racing in the same process cannot both
  // read sequence N and both write N + 1. Cross-process writers are out of scope: one DAK server
  // owns a project's directory.
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(documentId: string, action: () => Promise<T>): Promise<T> => {
    const previous = queues.get(documentId) ?? Promise.resolve();
    const turn = previous.then(action, action);
    queues.set(
      documentId,
      turn.then(
        () => undefined,
        () => undefined,
      ),
    );
    return turn;
  };

  const createDocument: CanvasStore["createDocument"] = async (input) => {
    const documentId = newDocumentId();
    const directory = directoryOf(documentId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const timestamp = now().toISOString();
    const meta: CanvasMeta = {
      id: documentId,
      title: input.title,
      module: input.module,
      starterFrameId: input.starterFrameId,
      createdAt: timestamp,
      updatedAt: timestamp,
      trashed: false,
    };
    await writeJson(NodePath.join(directory, "meta.json"), meta);
    await writeJson(NodePath.join(directory, "snapshot.json"), {
      throughSequence: input.snapshot.throughSequence,
      state: input.snapshot.state,
      source: input.snapshot.source,
    });
    await NodeFSP.writeFile(NodePath.join(directory, "updates.jsonl"), "");
    // Announced like any other change, not only on the first edit: a design the agent creates is the
    // moment a user most wants to see it, and the tab it opens is blank-but-real rather than a
    // promise of one.
    publish(documentId);
    return { documentId };
  };

  const appendUpdate: CanvasStore["appendUpdate"] = (input: CanvasAppendInput) =>
    serialize(input.documentId, async () => {
      const meta = await readMeta(input.documentId);
      if (meta.trashed) throw new Error(`Canvas document ${input.documentId} is in the trash.`);
      const [snapshot, updates] = await Promise.all([
        readSnapshot(input.documentId),
        readUpdates(input.documentId),
      ]);
      // A replayed write applies its mutation once. The idempotency record travels with the update,
      // so no separate bookkeeping can drift from it.
      const existing = updates.find((update) => update.clientUpdateId === input.clientUpdateId);
      if (existing !== undefined) {
        return { sequence: existing.sequence, duplicate: true } satisfies CanvasAppendResult;
      }
      const current = authoritativeSequence({
        snapshot: { throughSequence: snapshot.throughSequence },
        updates,
      });
      if (current !== input.expectedSequence) {
        throw new Error(
          `Canvas document ${input.documentId} is at sequence ${current}, not ${input.expectedSequence}.`,
        );
      }
      const sequence = current + 1;
      const stored: CanvasStoredUpdate = {
        sequence,
        update: input.update,
        clientUpdateId: input.clientUpdateId,
        operationId: input.operationId,
        inverseUpdate: input.inverseUpdate,
      };
      await NodeFSP.appendFile(
        NodePath.join(directoryOf(input.documentId), "updates.jsonl"),
        `${JSON.stringify(stored)}\n`,
      );
      await writeJson(NodePath.join(directoryOf(input.documentId), "meta.json"), {
        ...meta,
        updatedAt: now().toISOString(),
      });
      return { sequence, duplicate: false } satisfies CanvasAppendResult;
    }).then((appended) => {
      // Only a real append is announced; a replayed one moved nothing.
      if (!appended.duplicate) publish(input.documentId);
      return appended;
    });

  const undoOperation: CanvasStore["undoOperation"] = (input) =>
    serialize(input.documentId, async () => {
      const [snapshot, updates] = await Promise.all([
        readSnapshot(input.documentId),
        readUpdates(input.documentId),
      ]);
      const current = authoritativeSequence({
        snapshot: { throughSequence: snapshot.throughSequence },
        updates,
      });
      if (current !== input.expectedSequence) {
        throw new Error(
          `Canvas document ${input.documentId} is at sequence ${current}, not ${input.expectedSequence}.`,
        );
      }
      const head = updates.at(-1);
      if (head === undefined) throw new Error("There is no Canvas operation to undo.");
      // Undo is only safe while the operation is still the document head. Reversing an older one
      // would silently discard the work that came after it.
      if (input.operationId !== undefined && head.operationId !== input.operationId) {
        throw new Error(
          `Canvas operation ${input.operationId} is no longer the head of ${input.documentId}.`,
        );
      }
      if (head.operationId === undefined || head.inverseUpdate === undefined) {
        throw new Error("The head Canvas update carries no inverse, so it cannot be undone.");
      }
      const sequence = current + 1;
      const stored: CanvasStoredUpdate = {
        sequence,
        update: head.inverseUpdate,
        clientUpdateId: `undo-${sequence}-${head.clientUpdateId}`,
        // Deliberately not the undone operation's id: this reversal is no longer that operation, so
        // undoing the same operation twice is refused instead of silently re-applied. Its own
        // inverse is the original change, so undoing *without* an id still reverses the reversal.
        inverseUpdate: head.update,
      };
      await NodeFSP.appendFile(
        NodePath.join(directoryOf(input.documentId), "updates.jsonl"),
        `${JSON.stringify(stored)}\n`,
      );
      await writeJson(NodePath.join(directoryOf(input.documentId), "meta.json"), {
        ...(await readMeta(input.documentId)),
        updatedAt: now().toISOString(),
      });
      return {
        operationId: head.operationId,
        sequence,
        update: stored.update,
        inverseUpdate: stored.inverseUpdate ?? "",
      };
    }).then((undone) => {
      publish(input.documentId);
      return undone;
    });

  const createSnapshot: CanvasStore["createSnapshot"] = async (input) => {
    const directory = directoryOf(input.documentId);
    await writeJson(NodePath.join(directory, "snapshot.json"), {
      throughSequence: input.throughSequence,
      state: input.state,
      source: input.projection,
    });
  };

  const setTrashed = async (documentId: string, trashed: boolean): Promise<void> => {
    const meta = await readMeta(documentId);
    await writeJson(NodePath.join(directoryOf(documentId), "meta.json"), {
      ...meta,
      trashed,
      updatedAt: now().toISOString(),
    });
    publish(documentId, { trashed });
  };

  const trashDocument: CanvasStore["trashDocument"] = (documentId) => setTrashed(documentId, true);
  const restoreDocument: CanvasStore["restoreDocument"] = (documentId) =>
    setTrashed(documentId, false);

  const pathExists = async (path: string): Promise<boolean> => {
    try {
      await NodeFSP.access(path);
      return true;
    } catch {
      return false;
    }
  };

  return {
    listDocuments,
    getDocument,
    getDocumentForExecution,
    createDocument,
    appendUpdate,
    undoOperation,
    createSnapshot,
    trashDocument,
    restoreDocument,
    pathExists,
  };
};
