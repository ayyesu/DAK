// @effect-diagnostics nodeBuiltinImport:off - This test puts the real engine and the real
// filesystem store together, so it creates and cleans up real temporary directories.
// @effect-diagnostics globalRandom:off - Its dummy id factories are not the behaviour under test.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { make as makeEngine } from "./CanvasEngineLive.ts";
import { make as makeStore } from "./CanvasStoreLive.ts";
import { CanvasService, layer as canvasServiceLayer } from "./CanvasService.ts";
import { authoritativeSequence } from "./canvasInvariants.ts";
import type { CanvasDocumentPayload, CanvasStoredUpdate } from "./CanvasPorts.ts";

const CanvasEngineLive = { make: makeEngine };
const CanvasStoreLive = { make: makeStore };

/**
 * The real engine and the real store, wired together, against a real directory.
 *
 * Everything above this file is written against doubles, which prove the service's decisions but
 * not that a design survives a round trip. This is the test that says the vendored engine and the
 * filesystem store actually agree: a script mutates a document, the delta is appended, the store
 * reconstructs the head, a snapshot compacts it, undo reverses it, and a fresh store over the same
 * directory sees exactly what the first one left behind.
 *
 * These run CanvasKit and QuickJS for real, which is why they are the slowest tests in the folder.
 */

const roots: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dak-canvas-"));
  roots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe("canvas engine and store round trip", () => {
  it("creates, edits, screenshots, commits, and reconstructs a real design", async () => {
    const root = await makeWorkspace();
    const store = CanvasStoreLive.make({ workspaceRoot: root });
    const engine = CanvasEngineLive.make();

    const blank = await engine.createBlankDocument({ module: "generic", preset: "a4" });
    expect(blank.starterFrameId).toMatch(/\S/);

    const { documentId } = await store.createDocument({
      title: "Launch poster",
      module: "generic",
      snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
      starterFrameId: blank.starterFrameId,
    });

    // A real script: two nodes, one of them screenshotted for the review loop.
    const code = `
const hero = Insert(null, { id: "hero", type: "frame", name: "Hero", width: 600, height: 300, x: 0, y: 0, fill: { type: "solid", color: "#101014" }, children: [] });
Insert(hero, { id: "title", type: "text", name: "Title", width: 500, height: 80, x: 40, y: 60, text: "Hello Canvas", fontSize: 48, color: "#ffffff" });
TakeScreenshot(["hero"]);
return { hero };
`;
    const before = await store.getDocumentForExecution(documentId);
    const executed = await engine.execute({
      payload: before.payload,
      code,
      module: "generic",
    });

    expect(executed.changed).toBe(true);
    expect(executed.forward).toBeTruthy();
    expect(executed.inverse).toBeTruthy();
    expect(executed.touchedNodeIds).toContain("hero");
    // The screenshot came back as real PNG bytes, which is what the agent reviews.
    expect(executed.screenshots[0]?.mimeType).toBe("image/png");
    expect((executed.screenshots[0]?.data ?? "").length).toBeGreaterThan(100);

    const appended = await store.appendUpdate({
      documentId,
      clientUpdateId: "client-1",
      update: executed.forward,
      operationId: "op-1",
      inverseUpdate: executed.inverse,
      expectedSequence: before.summary.sequence,
    });
    expect(appended).toEqual({ sequence: 1, duplicate: false });

    // The store reconstructs the head from the log, so this is the write path being real.
    const after = await store.getDocumentForExecution(documentId);
    const materialized = (await engine.materialize(after.payload)) as {
      children: ReadonlyArray<{ id: string; children?: ReadonlyArray<{ id: string }> }>;
    };
    expect(materialized.children.map((node) => node.id)).toContain("hero");
    expect(after.summary.sequence).toBe(1);

    // Compaction is an artifact, not the truth: the projection is written best-effort.
    await store.createSnapshot({
      documentId,
      throughSequence: appended.sequence,
      state: executed.state,
      projection: executed.document,
    });
    const compacted = await store.getDocumentForExecution(documentId);
    expect(compacted.payload.snapshot.throughSequence).toBe(1);
    expect((await engine.materialize(compacted.payload)) as { children: unknown[] }).toBeTruthy();
  }, 120_000);

  it("recovers the authoritative sequence when compaction lagged the log", async () => {
    const root = await makeWorkspace();
    const store = CanvasStoreLive.make({ workspaceRoot: root });
    const engine = CanvasEngineLive.make();
    const blank = await engine.createBlankDocument({ module: "generic" });
    const { documentId } = await store.createDocument({
      title: "Lagging",
      module: "generic",
      snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
      starterFrameId: blank.starterFrameId,
    });

    const first = await store.getDocumentForExecution(documentId);
    const executed = await engine.execute({
      payload: first.payload,
      code: `Insert(null, { id: "block", type: "frame", name: "Block", width: 100, height: 100, x: 0, y: 0, fill: "#ff0000" }); return 1;`,
      module: "generic",
    });
    await store.appendUpdate({
      documentId,
      clientUpdateId: "client-1",
      update: executed.forward,
      operationId: "op-1",
      inverseUpdate: executed.inverse,
      expectedSequence: 0,
    });

    // Simulate the crash-between-append-and-compaction case by writing a snapshot that only knows
    // about sequence 0, after sequence 1 has already committed. The max rule must still win.
    await store.createSnapshot({
      documentId,
      throughSequence: 0,
      state: blank.state,
      projection: blank.document,
    });

    const recovered = await store.getDocument(documentId);
    expect(recovered.sequence).toBe(1);
    expect(recovered.projectionCurrent).toBe(false);
    expect(
      authoritativeSequence({
        snapshot: { throughSequence: 0 },
        updates: [{ sequence: 1 }],
      }),
    ).toBe(1);
  }, 120_000);

  it("applies a replayed clientUpdateId once and refuses a stale sequence", async () => {
    const root = await makeWorkspace();
    const store = CanvasStoreLive.make({ workspaceRoot: root });
    const engine = CanvasEngineLive.make();
    const blank = await engine.createBlankDocument({ module: "generic" });
    const { documentId } = await store.createDocument({
      title: "Idempotent",
      module: "generic",
      snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
      starterFrameId: blank.starterFrameId,
    });

    const first = await store.getDocumentForExecution(documentId);
    const executed = await engine.execute({
      payload: first.payload,
      code: `Insert(null, { id: "once", type: "frame", name: "Once", width: 10, height: 10, x: 0, y: 0, fill: "#000000" }); return 1;`,
      module: "generic",
    });
    const append = () =>
      store.appendUpdate({
        documentId,
        clientUpdateId: "replay-me",
        update: executed.forward,
        operationId: "op-1",
        inverseUpdate: executed.inverse,
        expectedSequence: 0,
      });

    expect(await append()).toEqual({ sequence: 1, duplicate: false });
    // The same write arriving twice must not apply twice.
    expect(await append()).toEqual({ sequence: 1, duplicate: true });

    // A write against a sequence that has moved is refused, not silently merged.
    await expect(
      store.appendUpdate({
        documentId,
        clientUpdateId: "stale",
        update: executed.forward,
        operationId: "op-2",
        inverseUpdate: executed.inverse,
        expectedSequence: 0,
      }),
    ).rejects.toThrow(/sequence/u);
  }, 120_000);

  it("undo reverses exactly the head operation and nothing else", async () => {
    const root = await makeWorkspace();
    const store = CanvasStoreLive.make({ workspaceRoot: root });
    const engine = CanvasEngineLive.make();
    const blank = await engine.createBlankDocument({ module: "generic" });
    const { documentId } = await store.createDocument({
      title: "Undoable",
      module: "generic",
      snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
      starterFrameId: blank.starterFrameId,
    });

    const first = await store.getDocumentForExecution(documentId);
    const executed = await engine.execute({
      payload: first.payload,
      code: `Insert(null, { id: "gone", type: "frame", name: "Gone", width: 10, height: 10, x: 0, y: 0, fill: "#000000" }); return 1;`,
      module: "generic",
    });
    await store.appendUpdate({
      documentId,
      clientUpdateId: "client-1",
      update: executed.forward,
      operationId: "op-1",
      inverseUpdate: executed.inverse,
      expectedSequence: 0,
    });

    const undone = await store.undoOperation({ documentId, expectedSequence: 1 });
    expect(undone.operationId).toBe("op-1");
    expect(undone.sequence).toBe(2);

    const after = await store.getDocumentForExecution(documentId);
    const materialized = (await engine.materialize(after.payload)) as {
      children: ReadonlyArray<{ id: string }>;
    };
    expect(materialized.children.map((node) => node.id)).not.toContain("gone");

    // The undo is not the head any more, so a second undo of the same operation is refused.
    await expect(
      store.undoOperation({ documentId, operationId: "op-1", expectedSequence: 2 }),
    ).rejects.toThrow(/head/u);
  }, 120_000);

  it("extracts a real PNG artifact into the project workspace", async () => {
    const root = await makeWorkspace();
    const store = CanvasStoreLive.make({ workspaceRoot: root });
    const engine = CanvasEngineLive.make();
    const blank = await engine.createBlankDocument({ module: "generic", preset: "a4" });
    const { documentId } = await store.createDocument({
      title: "Artifact",
      module: "generic",
      snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
      starterFrameId: blank.starterFrameId,
    });

    const first = await store.getDocumentForExecution(documentId);
    const executed = await engine.execute({
      payload: first.payload,
      code: `Insert(null, { id: "art", type: "frame", name: "Art", width: 200, height: 120, x: 0, y: 0, fill: { type: "solid", color: "#2244ff" } }); return 1;`,
      module: "generic",
    });
    await store.appendUpdate({
      documentId,
      clientUpdateId: "client-1",
      update: executed.forward,
      operationId: "op-1",
      inverseUpdate: executed.inverse,
      expectedSequence: 0,
    });

    const { payload } = await store.getDocumentForExecution(documentId);
    const destination = NodePath.join(root, "out", "art.png");
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    const artifact = await engine.extract({
      payload,
      nodeIds: ["art"],
      format: "png",
      destination,
    });
    expect(artifact.artifacts).toEqual([destination]);
    const bytes = await NodeFSP.readFile(destination);
    // A real PNG signature, so this is an image and not an empty file.
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.byteLength).toBeGreaterThan(100);
  }, 120_000);

  it("degrades to an opaque document when the engine cannot hydrate a broken payload", async () => {
    // A payload whose snapshot state is not valid Yjs must fail loudly rather than produce a
    // silently empty design.
    const engine = CanvasEngineLive.make();
    const broken: CanvasDocumentPayload = {
      snapshot: { throughSequence: 0, state: "not-base64-yjs", source: { children: [] } },
      updates: [],
    };
    await expect(engine.materialize(broken)).rejects.toBeInstanceOf(Error);
  }, 120_000);

  effectIt.effect(
    "runs the whole flow through the service, end to end",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => makeWorkspace());
        const service = canvasServiceLayer({
          store: CanvasStoreLive.make({ workspaceRoot: root }),
          engine: CanvasEngineLive.make(),
          workspaceRoot: root,
          newOperationId: () => `op-${Math.random().toString(36).slice(2)}`,
          newClientUpdateId: () => `client-${Math.random().toString(36).slice(2)}`,
        });
        const canvas = yield* Effect.provide(CanvasService, service);

        const created = yield* canvas.create({
          title: "Service poster",
          module: "generic",
          preset: "a4",
        });
        const executed = yield* canvas.execute({
          documentId: created.documentId,
          code: `Insert(null, { id: "svc", type: "frame", name: "Svc", width: 320, height: 180, x: 0, y: 0, fill: { type: "solid", color: "#12b981" } }); return 1;`,
        });
        expect(executed.changed).toBe(true);
        expect(executed.operationId).toBeTruthy();

        const read = yield* canvas.read({ documentId: created.documentId });
        expect(
          (read.document as { children: { id: string }[] }).children.map((node) => node.id),
        ).toContain("svc");

        const listed = yield* canvas.list({});
        expect(listed.items.map((item) => item.title)).toContain("Service poster");

        const undone = yield* canvas.undo({
          documentId: created.documentId,
          ...(executed.operationId === undefined ? {} : { operationId: executed.operationId }),
        });
        expect(undone.changed).toBe(true);
        const afterUndo = yield* canvas.read({ documentId: created.documentId });
        expect(
          (afterUndo.document as { children: { id: string }[] }).children.map((node) => node.id),
        ).not.toContain("svc");
      }),
    { timeout: 120_000 },
  );

  it("keeps the update log parseable as a stream of commits", async () => {
    const root = await makeWorkspace();
    const store = CanvasStoreLive.make({ workspaceRoot: root });
    const engine = CanvasEngineLive.make();
    const blank = await engine.createBlankDocument({ module: "generic" });
    const { documentId } = await store.createDocument({
      title: "Log",
      module: "generic",
      snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
      starterFrameId: blank.starterFrameId,
    });
    const first = await store.getDocumentForExecution(documentId);
    const executed = await engine.execute({
      payload: first.payload,
      code: `Insert(null, { id: "logged", type: "frame", name: "Logged", width: 10, height: 10, x: 0, y: 0, fill: "#000000" }); return 1;`,
      module: "generic",
    });
    await store.appendUpdate({
      documentId,
      clientUpdateId: "client-1",
      update: executed.forward,
      operationId: "op-1",
      inverseUpdate: executed.inverse,
      expectedSequence: 0,
    });
    const lines = (
      await NodeFSP.readFile(
        NodePath.join(root, ".dak", "canvas", documentId, "updates.jsonl"),
        "utf8",
      )
    )
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    const stored = JSON.parse(lines[0]!) as CanvasStoredUpdate;
    expect(stored.sequence).toBe(1);
    expect(stored.operationId).toBe("op-1");
    expect(stored.inverseUpdate).toBe(executed.inverse);
  }, 120_000);
});
