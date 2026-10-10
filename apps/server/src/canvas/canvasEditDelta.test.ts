// @effect-diagnostics globalRandom:off - The id factories are not the behaviour under test.
// @effect-diagnostics nodeBuiltinImport:off - This creates real temporary directories and rasterizes
// with the real CanvasKit runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, describe, expect } from "vite-plus/test";

import {
  createDocumentModel,
  encodeState,
} from "@dak/canvas-engine/upstream/src/document-model.mjs";

import { make as makeEngine } from "./CanvasEngineLive.ts";
import { make as makeStore } from "./CanvasStoreLive.ts";
import { make as makeService } from "./CanvasService.ts";

/**
 * What an edit does to the design's problems.
 *
 * The case that earns the whole feature: an edit that breaks a layout says so on that edit, and the
 * edit that fixes it says so too. Without the split an agent meets a broken design in a later
 * inspect with no way to know which of twenty edits was responsible.
 */

const roots: string[] = [];
const makeWorkspace = async (): Promise<string> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dak-canvas-delta-"));
  roots.push(root);
  return root;
};
afterAll(async () => {
  await Promise.all(
    roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true }).catch(() => undefined)),
  );
});

const engine = makeEngine();

/** A clean two-column page: two side-by-side frames, each with a heading and a paragraph. */
const cleanDocument = {
  module: "web",
  axes: {},
  variables: {},
  paragraphStyles: {},
  imports: {},
  flows: [],
  children: [
    {
      type: "frame",
      id: "left",
      name: "Left",
      role: "route",
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
      fill: "#ffffff",
      children: [
        {
          type: "text",
          id: "left-heading",
          content: "A heading that fits",
          paragraphs: [{ from: 0, to: 19 }],
          x: 40,
          y: 40,
          width: 600,
          fontSize: 32,
          fill: "#0f172a",
        },
      ],
    },
    {
      type: "frame",
      id: "right",
      name: "Right",
      role: "route",
      x: 1520,
      y: 0,
      width: 1440,
      height: 900,
      fill: "#ffffff",
      children: [
        {
          type: "text",
          id: "right-heading",
          content: "Another heading",
          paragraphs: [{ from: 0, to: 15 }],
          x: 40,
          y: 40,
          width: 600,
          fontSize: 32,
          fill: "#0f172a",
        },
      ],
    },
  ],
};

/**
 * Puts a document straight into the store at sequence 0.
 *
 * Seeding through an edit would mean writing a script whose only purpose is to reproduce the fixture,
 * and an edit that changes nothing produces an empty update the store rightly refuses.
 */
const seedDocument = async (workspaceRoot: string, document: unknown, title: string) => {
  const store = makeStore({ workspaceRoot });
  const model = createDocumentModel(document);
  const state = encodeState(model);
  model.doc.destroy();
  return store.createDocument({
    title,
    module: "generic",
    snapshot: { throughSequence: 0, state, source: document },
    starterFrameId: (document as { children: ReadonlyArray<{ id: string }> }).children[0]!.id,
  });
};

describe("the issue delta an edit reports", () => {
  effectIt.effect("shows an edit that introduces an overlap, then the edit that resolves it", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeWorkspace);
      const { documentId } = yield* Effect.promise(() =>
        seedDocument(root, cleanDocument, "Delta"),
      );
      const store = makeStore({ workspaceRoot: root });
      const service = makeService({
        store,
        engine,
        workspaceRoot: root,
        newOperationId: () => `op-${Math.random()}`,
        newClientUpdateId: () => `cu-${Math.random()}`,
      });

      // The starting point is clean, so anything later is attributable.
      const baseline = yield* service.inspect({ documentId });
      expect(baseline.issues).toEqual([]);

      // --- The breaking edit: drag the right column onto the left one.
      const breaking = yield* service.execute({
        documentId,
        code: `Update("right", { x: 0 }); return 1;`,
      });
      expect(breaking.changed).toBe(true);
      const brokeFeedback = breaking.feedback;
      expect(brokeFeedback).toBeDefined();
      expect(brokeFeedback!.delta.introduced.map((issue) => issue.code)).toContain(
        "frames_overlap",
      );
      expect(brokeFeedback!.delta.resolved).toEqual([]);
      expect(brokeFeedback!.delta.preExisting).toEqual([]);

      // The touched node carries a measured box, so the next edit can place against it.
      const touchedRight = brokeFeedback!.touched.find((node) => node.id === "right");
      expect(touchedRight).toBeDefined();
      expect(touchedRight?.x).toBe(0);
      expect(touchedRight?.width).toBe(1440);

      // --- The fixing edit.
      const fixing = yield* service.execute({
        documentId,
        code: `Update("right", { x: 1520 }); return 1;`,
      });
      expect(fixing.changed).toBe(true);
      expect(fixing.feedback!.delta.resolved.map((issue) => issue.code)).toContain(
        "frames_overlap",
      );
      expect(fixing.feedback!.delta.introduced).toEqual([]);

      // --- An edit that changed nothing reports no delta rather than an empty one that reads as
      // a clean bill of health.
      const noop = yield* service.execute({ documentId, code: `return 1;` });
      expect(noop.changed).toBe(false);
      expect(noop.feedback).toBeUndefined();

      // And measure answers with real boxes for the same design.
      const measured = yield* service.measure({ documentId, selectors: ["left", "right"] });
      expect(measured.nodes.map((node) => node.id)).toEqual(["left", "right"]);
      expect(measured.nodes[0]?.width).toBe(1440);
      expect(measured.unmatchedSelectors).toEqual([]);

      const missing = yield* service.measure({ documentId, selectors: ["nope"] });
      expect(missing.nodes).toEqual([]);
      expect(missing.unmatchedSelectors).toEqual(["nope"]);
    }).pipe(Effect.timeout("180 seconds")),
  );

  effectIt.effect(
    "measures a wrapped text node at the height it will occupy, not the height written",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeWorkspace);
        const { documentId } = yield* Effect.promise(() =>
          seedDocument(root, cleanDocument, "Measure"),
        );
        const store = makeStore({ workspaceRoot: root });
        const service = makeService({
          store,
          engine,
          workspaceRoot: root,
          newOperationId: () => "op",
          newClientUpdateId: () => "cu",
        });
        const measured = yield* service
          .measure({ documentId, selectors: ["left-heading"] })
          .pipe(Effect.orDie);
        // The node declares no height, so the answer comes from the shaper rather than the document.
        expect(measured.nodes).toHaveLength(1);
        expect(measured.measuredTextNodes).toBeGreaterThan(0);
        expect(measured.nodes[0]?.height).toBeGreaterThan(32);
      }).pipe(Effect.timeout("180 seconds")),
  );
});
