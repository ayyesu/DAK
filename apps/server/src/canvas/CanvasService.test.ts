import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CanvasService, CANVAS_CONFLICT_MAX_ATTEMPTS, layer } from "./CanvasService.ts";
import type {
  CanvasAppendInput,
  CanvasDocumentPayload,
  CanvasEngine,
  CanvasScriptResult,
  CanvasStore,
  CanvasStoredDocument,
} from "./CanvasPorts.ts";

/**
 * Doubles for the parts DAK does not own. The engine can really run documents and the store can
 * really persist them; what is tested here is every decision the service makes between them, which
 * is where the invariants live.
 */
const payload: CanvasDocumentPayload = {
  snapshot: { throughSequence: 0, state: "blank-state", source: { children: [] } },
  updates: [],
};

const makeDoubles = (
  options: {
    readonly document?: Partial<CanvasStoredDocument>;
    readonly script?: Partial<CanvasScriptResult>;
    readonly executeThrows?: Error;
    readonly snapshotThrows?: Error;
    readonly undoThrows?: Error;
    readonly conflicts?: number;
  } = {},
) => {
  const appends: CanvasAppendInput[] = [];
  const snapshotAttempts: number[] = [];
  const created: Array<{ title: string; module: string; state: string }> = [];
  let sequence = options.document?.sequence ?? 4;
  let remainingConflicts = options.conflicts ?? 0;
  let counter = 0;

  const document: CanvasStoredDocument = {
    id: "doc-1",
    title: "Launch deck",
    module: "generic",
    sequence,
    projectionCurrent: true,
    trashed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...options.document,
  };

  const store: CanvasStore = {
    // The store owns listing, including the trash filter, so the double mirrors that.
    listDocuments: async (input) =>
      input.includeTrash === true || !document.trashed ? [document] : [],
    getDocument: async () => document,
    getDocumentForExecution: async () => ({ summary: { ...document, sequence }, payload }),
    createDocument: async (input) => {
      assert.strictEqual(input.starterFrameId, "frame-1");
      created.push({ title: input.title, module: input.module, state: input.snapshot.state });
      return { documentId: "doc-new" };
    },
    appendUpdate: async (input) => {
      if (remainingConflicts > 0) {
        remainingConflicts -= 1;
        throw new Error("expected sequence 4 but the document is at 5");
      }
      appends.push(input);
      sequence += 1;
      return { sequence, duplicate: false };
    },
    undoOperation: async () => {
      if (options.undoThrows) throw options.undoThrows;
      sequence += 1;
      return { operationId: "op-1", sequence, update: "inverse", inverseUpdate: "forward" };
    },
    createSnapshot: async (input) => {
      snapshotAttempts.push(input.throughSequence);
      if (options.snapshotThrows) throw options.snapshotThrows;
    },
    trashDocument: async () => undefined,
    restoreDocument: async () => undefined,
    pathExists: async () => false,
  };

  const engine: CanvasEngine = {
    createBlankDocument: async () => ({
      document: { children: [{ id: "frame-1" }] },
      state: "blank-state",
      starterFrameId: "frame-1",
    }),
    execute: async () => {
      if (options.executeThrows) throw options.executeThrows;
      return {
        changed: true,
        document: { children: [] },
        prints: [],
        result: null,
        touchedNodeIds: ["frame-1"],
        issues: [],
        screenshots: [],
        forward: "forward",
        inverse: "inverse",
        state: "head-state",
        ...options.script,
      };
    },
    materialize: async () => ({ children: [{ id: "frame-1" }] }),
    renderRegion: () => Promise.reject(new Error("not used in this test")),
    renderFrames: async (input) =>
      input.nodeIds.map((nodeId) => ({
        nodeIds: [nodeId],
        width: 10,
        height: 5,
        mimeType: "image/png" as const,
        data: "cG5n",
      })),
    extract: async (input) => ({
      artifacts: [input.destination],
      consequences: [],
      rasterized: [],
    }),
  };

  return {
    layer: layer({
      store,
      engine,
      workspaceRoot: "/projects/demo",
      newOperationId: () => `op-${counter + 1}`,
      newClientUpdateId: () => `client-${counter + 1}`,
    }),
    appends,
    snapshotAttempts,
    created,
  };
};

const overflowIssues = Array.from({ length: 50 }, (_, index) => ({
  nodeId: `n${index}`,
  kind: "overflow",
  severity: "minor" as const,
}));

const schemaError = Object.assign(new Error("root.module is required"), {
  code: "CANVAS_SCHEMA_INVALID",
});

describe("canvas service", () => {
  describe("create", () => {
    it.effect("returns the starter frame the agent authors into", () => {
      const doubles = makeDoubles();
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.create({ title: "Poster", module: "generic" });
        assert.strictEqual(result.starterFrameId, "frame-1");
        assert.strictEqual(result.documentId, "doc-new");
      }).pipe(Effect.provide(doubles.layer));
    });

    it.effect("stores a snapshot starting at the blank state", () => {
      const doubles = makeDoubles();
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        yield* canvas.create({ title: "Poster", module: "generic" });
        assert.deepStrictEqual(doubles.created, [
          { title: "Poster", module: "generic", state: "blank-state" },
        ]);
      }).pipe(Effect.provide(doubles.layer));
    });
  });

  describe("list", () => {
    it.effect("hides trashed designs by default", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        assert.strictEqual((yield* canvas.list({})).items.length, 0);
      }).pipe(Effect.provide(makeDoubles({ document: { trashed: true } }).layer)),
    );

    it.effect("includes trashed designs when asked for them", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        assert.strictEqual((yield* canvas.list({ includeTrash: true })).items.length, 1);
      }).pipe(Effect.provide(makeDoubles({ document: { trashed: true } }).layer)),
    );

    it.effect("carries the sequence and whether the projection still matches it", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const { items } = yield* canvas.list({});
        assert.strictEqual(items[0]?.sequence, 9);
        assert.strictEqual(items[0]?.projectionCurrent, false);
      }).pipe(
        Effect.provide(makeDoubles({ document: { sequence: 9, projectionCurrent: false } }).layer),
      ),
    );
  });

  describe("read", () => {
    it.effect("returns the readable document at its sequence", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.read({ documentId: "doc-1" });
        assert.strictEqual(result.summary.id, "doc-1");
        assert.deepStrictEqual(result.document, { children: [{ id: "frame-1" }] });
      }).pipe(Effect.provide(makeDoubles().layer)),
    );
  });

  describe("execute", () => {
    it.effect("appends one update carrying both the change and its inverse", () => {
      const doubles = makeDoubles();
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.execute({ documentId: "doc-1", code: "return 1;" });
        assert.strictEqual(result.changed, true);
        assert.strictEqual(doubles.appends.length, 1);
        assert.strictEqual(doubles.appends[0]?.inverseUpdate, "inverse");
        assert.strictEqual(doubles.appends[0]?.update, "forward");
        assert.strictEqual(doubles.appends[0]?.operationId, result.operationId);
      }).pipe(Effect.provide(doubles.layer));
    });

    it.effect("writes nothing when the resulting design is invalid", () => {
      const doubles = makeDoubles({ executeThrows: schemaError });
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const outcome = yield* Effect.result(
          canvas.execute({ documentId: "doc-1", code: "return 1;" }),
        );
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure") assert.strictEqual(outcome.failure.code, "schema_invalid");
        assert.deepStrictEqual(doubles.appends, []);
        assert.deepStrictEqual(doubles.snapshotAttempts, []);
      }).pipe(Effect.provide(doubles.layer));
    });

    it.effect("writes nothing when the edit is too broad", () => {
      const doubles = makeDoubles({
        script: { touchedNodeIds: Array.from({ length: 10_001 }, (_, index) => `n${index}`) },
      });
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const outcome = yield* Effect.result(
          canvas.execute({ documentId: "doc-1", code: "return 1;" }),
        );
        assert.strictEqual(outcome._tag, "Failure");
        assert.deepStrictEqual(doubles.appends, []);
      }).pipe(Effect.provide(doubles.layer));
    });

    it.effect("reports a timeout separately from a rejected script", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const outcome = yield* Effect.result(canvas.execute({ documentId: "doc-1", code: "x" }));
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure") assert.strictEqual(outcome.failure.code, "script_timeout");
      }).pipe(
        Effect.provide(
          makeDoubles({
            executeThrows: Object.assign(new Error("Canvas script failed: interrupted"), {
              code: "CANVAS_SCRIPT_TIMEOUT",
            }),
          }).layer,
        ),
      ),
    );

    it.effect("reports an out-of-memory script as a memory failure", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const outcome = yield* Effect.result(canvas.execute({ documentId: "doc-1", code: "x" }));
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure")
          assert.strictEqual(outcome.failure.code, "script_memory_exceeded");
      }).pipe(Effect.provide(makeDoubles({ executeThrows: new Error("out of memory") }).layer)),
    );

    it.effect("succeeds even when compaction fails, because the edit already committed", () => {
      const doubles = makeDoubles({ snapshotThrows: new Error("disk full") });
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.execute({ documentId: "doc-1", code: "x" });
        assert.strictEqual(result.changed, true);
        assert.strictEqual(doubles.snapshotAttempts.length, 1);
      }).pipe(Effect.provide(doubles.layer));
    });

    it.effect("reports a read-only execution without an operation to undo", () => {
      const doubles = makeDoubles({ script: { changed: false } });
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.execute({ documentId: "doc-1", code: "return 1;" });
        assert.strictEqual(result.changed, false);
        assert.isUndefined(result.operationId);
        assert.deepStrictEqual(doubles.appends, []);
      }).pipe(Effect.provide(doubles.layer));
    });

    it.effect("bounds the issue sample but reports complete counts", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.execute({ documentId: "doc-1", code: "x" });
        assert.strictEqual(result.issues.length, 20);
        assert.strictEqual(result.issueSummary.total, 50);
        assert.strictEqual(result.issueSummary.omitted, 30);
        assert.deepStrictEqual(result.issueSummary.byKind, { overflow: 50 });
      }).pipe(Effect.provide(makeDoubles({ script: { issues: overflowIssues } }).layer)),
    );

    it.effect("returns every issue when asked for all of them", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.execute({
          documentId: "doc-1",
          code: "x",
          issueDetail: "all",
        });
        assert.strictEqual(result.issues.length, 50);
        assert.strictEqual(result.issueSummary.omitted, 0);
      }).pipe(Effect.provide(makeDoubles({ script: { issues: overflowIssues } }).layer)),
    );

    it.effect("carries screenshot bytes out of band for the transport", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.execute({ documentId: "doc-1", code: "x" });
        assert.strictEqual(result.screenshotImages[0]?.mimeType, "image/png");
      }).pipe(
        Effect.provide(
          makeDoubles({
            script: {
              screenshots: [
                {
                  nodeIds: ["frame-1"],
                  width: 10,
                  height: 10,
                  mimeType: "image/png",
                  data: "AAAA",
                },
              ],
            },
          }).layer,
        ),
      ),
    );

    it.effect("retries a conflict and succeeds once the user stops editing", () => {
      const doubles = makeDoubles({ conflicts: 2 });
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.execute({ documentId: "doc-1", code: "x" });
        assert.strictEqual(result.changed, true);
        assert.strictEqual(doubles.appends.length, 1);
      }).pipe(Effect.provide(doubles.layer));
    });

    it.effect("gives up rather than spinning when the user never stops editing", () => {
      const doubles = makeDoubles({ conflicts: CANVAS_CONFLICT_MAX_ATTEMPTS + 5 });
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const outcome = yield* Effect.result(canvas.execute({ documentId: "doc-1", code: "x" }));
        assert.strictEqual(outcome._tag, "Failure");
        assert.deepStrictEqual(doubles.appends, []);
      }).pipe(Effect.provide(doubles.layer));
    });

    it.effect("refuses to edit a design in the trash", () => {
      const doubles = makeDoubles({ document: { trashed: true } });
      return Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const outcome = yield* Effect.result(canvas.execute({ documentId: "doc-1", code: "x" }));
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure")
          assert.strictEqual(outcome.failure.code, "document_deleted");
        assert.deepStrictEqual(doubles.appends, []);
      }).pipe(Effect.provide(doubles.layer));
    });
  });

  describe("undo", () => {
    it.effect("undoes the operation the caller names", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.undo({ documentId: "doc-1", operationId: "op-9" });
        assert.strictEqual(result.changed, true);
      }).pipe(Effect.provide(makeDoubles().layer)),
    );

    it.effect("refuses when the operation is no longer the head", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const outcome = yield* Effect.result(
          canvas.undo({ documentId: "doc-1", operationId: "op-1" }),
        );
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure")
          assert.strictEqual(outcome.failure.code, "document_conflict");
      }).pipe(Effect.provide(makeDoubles({ undoThrows: new Error("not the head") }).layer)),
    );
  });

  describe("trash", () => {
    it.effect("requires the exact current title", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const outcome = yield* Effect.result(
          canvas.trash({ documentId: "doc-1", confirmTitle: "Old name" }),
        );
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure") {
          assert.strictEqual(outcome.failure.code, "trash_confirmation_mismatch");
          assert.include(outcome.failure.detail, '"Launch deck"');
        }
      }).pipe(Effect.provide(makeDoubles().layer)),
    );

    it.effect("trashes on the exact title", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.trash({ documentId: "doc-1", confirmTitle: "Launch deck" });
        assert.strictEqual(result.title, "Launch deck");
      }).pipe(Effect.provide(makeDoubles().layer)),
    );
  });

  describe("extract", () => {
    it.effect("refuses a destination outside the project workspace", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const outcome = yield* Effect.result(
          canvas.extract({
            documentId: "doc-1",
            nodeIds: ["frame-1"],
            format: "png",
            destination: "/etc/passwd.png",
          }),
        );
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure")
          assert.strictEqual(outcome.failure.code, "destination_unsafe");
      }).pipe(Effect.provide(makeDoubles().layer)),
    );

    it.effect("writes an artifact inside the workspace", () =>
      Effect.gen(function* () {
        const canvas = yield* CanvasService;
        const result = yield* canvas.extract({
          documentId: "doc-1",
          nodeIds: ["frame-1"],
          format: "png",
          destination: "/projects/demo/out/hero.png",
        });
        assert.deepStrictEqual(result.artifacts, ["/projects/demo/out/hero.png"]);
      }).pipe(Effect.provide(makeDoubles().layer)),
    );
  });

  it.effect("exposes every method as an Effect service", () =>
    Effect.gen(function* () {
      const canvas = yield* CanvasService;
      for (const method of [
        "create",
        "list",
        "read",
        "execute",
        "undo",
        "trash",
        "restore",
        "extract",
      ] as const) {
        assert.isFunction(canvas[method]);
      }
      assert.strictEqual(CanvasService.key, "dak/canvas/CanvasService");
    }).pipe(Effect.provide(makeDoubles().layer)),
  );
});
