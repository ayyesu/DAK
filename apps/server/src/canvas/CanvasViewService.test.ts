import {
  CANVAS_RENDER_FRAME_LIMIT,
  CANVAS_RENDER_MAX_EDGE,
  CANVAS_RENDER_MIN_EDGE,
  CANVAS_RENDER_PAYLOAD_BUDGET_CHARS,
} from "@dak/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { make as makeCanvasView, selectViewFrames } from "./CanvasViewService.ts";
import type {
  CanvasDocument,
  CanvasDocumentPayload,
  CanvasEngine,
  CanvasStoredDocument,
  CanvasStore,
} from "./CanvasPorts.ts";

/**
 * The render budget, as the view service enforces it.
 *
 * Every frame here is synthetic, and that is the point: no fixture can paint a design large enough
 * to overflow the budget without exceeding the sandbox's own script and time limits, so the bound is
 * proved against frame sizes the test controls exactly. What the real engine costs is measured
 * separately, in `CanvasRenderBudget.test.ts`.
 */

const frameIds = ["slide-1", "slide-2", "slide-3", "slide-4", "slide-5", "slide-6"];

const stored = (overrides: Partial<CanvasStoredDocument> = {}): CanvasStoredDocument => ({
  id: "doc-1",
  title: "Launch deck",
  module: "deck",
  sequence: 3,
  projectionCurrent: true,
  trashed: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const storeDouble = (document: CanvasStoredDocument, projection: CanvasDocument): CanvasStore => {
  const payload: CanvasDocumentPayload = {
    snapshot: { throughSequence: document.sequence, state: "state", source: projection },
    updates: [],
  };
  return {
    listDocuments: async () => [document],
    getDocument: async () => document,
    getDocumentForExecution: async () => ({ summary: document, payload }),
    createDocument: async () => ({ documentId: "doc-new" }),
    appendUpdate: async () => ({ sequence: 1, duplicate: false }),
    undoOperation: async () => ({
      operationId: "op-1",
      sequence: 1,
      update: "forward",
      inverseUpdate: "inverse",
    }),
    createSnapshot: async () => undefined,
    trashDocument: async () => undefined,
    restoreDocument: async () => undefined,
    pathExists: async () => false,
  };
};

/** Frames whose base64 length the test decides, so the budget arithmetic is exact. */
const engineDouble = (options: {
  readonly projection: CanvasDocument;
  readonly charsPerFrameAtMaxEdge: number;
  /** False models a frame that does not get smaller when the edge does. */
  readonly scalesWithEdge?: boolean;
  readonly onRender?: () => void;
}) => {
  const edges: number[] = [];
  const engine: CanvasEngine = {
    createBlankDocument: async () => ({
      document: options.projection,
      state: "state",
      starterFrameId: "frame-1",
    }),
    execute: async () => {
      throw new Error("not used by the view service");
    },
    materialize: async () => options.projection,
    extract: async () => ({ artifacts: [], consequences: [], rasterized: [] }),
    renderRegion: () => Promise.reject(new Error("not used in this test")),
    renderFrames: async ({ nodeIds, maxEdge }) => {
      options.onRender?.();
      const edge = maxEdge ?? CANVAS_RENDER_MAX_EDGE;
      edges.push(edge);
      const scale =
        options.scalesWithEdge === false ? 1 : Math.max(0.01, (edge / CANVAS_RENDER_MAX_EDGE) ** 2);
      return nodeIds.map((nodeId) => ({
        nodeIds: [nodeId],
        width: Math.min(edge, 1200),
        height: Math.min(edge, 800),
        mimeType: "image/png" as const,
        data: "A".repeat(Math.round(options.charsPerFrameAtMaxEdge * scale)),
      }));
    },
  };
  return { engine, edges };
};

const harness = (options: {
  readonly charsPerFrameAtMaxEdge: number;
  readonly scalesWithEdge?: boolean;
  readonly file?: Partial<CanvasStoredDocument>;
  /** The design's top-level nodes. Defaults to six slides. */
  readonly frames?: ReadonlyArray<{ readonly id: string; readonly role?: string }>;
  readonly onRender?: () => void;
}) => {
  const document = stored(options.file);
  const frames = options.frames ?? frameIds.map((id) => ({ id, role: "slide" }));
  const { engine, edges } = engineDouble({ ...options, projection: { children: frames } });
  const view = makeCanvasView({ store: storeDouble(document, { children: frames }), engine });
  return { view, edges };
};

const payloadChars = (frames: ReadonlyArray<{ readonly data: string }>) =>
  frames.reduce((total, frame) => total + frame.data.length, 0);

describe("canvas render budget", () => {
  it("renders once at the requested edge when the payload fits", async () => {
    const { view, edges } = harness({ charsPerFrameAtMaxEdge: 10_000 });
    const rendered = await Effect.runPromise(view.render({ documentId: "doc-1", maxEdge: 1024 }));

    expect(edges).toEqual([1024]);
    expect(rendered.frames.map((frame) => frame.nodeId)).toEqual(frameIds);
    expect(rendered.maxEdge).toBe(1024);
    expect(rendered.omittedFrames).toBe(0);
  });

  it("re-renders once at a smaller edge when the payload does not fit", async () => {
    const { view, edges } = harness({ charsPerFrameAtMaxEdge: 400_000 });
    const rendered = await Effect.runPromise(view.render({ documentId: "doc-1" }));

    expect(edges).toHaveLength(2);
    expect(edges[1]!).toBeLessThan(edges[0]!);
    expect(rendered.maxEdge).toBe(edges[1]!);
    // The retry aims at the budget; assert real progress rather than exact rounding.
    expect(payloadChars(rendered.frames)).toBeLessThanOrEqual(CANVAS_RENDER_PAYLOAD_BUDGET_CHARS);
    expect(rendered.omittedFrames).toBe(0);
  });

  it("drops trailing frames rather than shrinking below readability when reducing cannot help", async () => {
    const { view } = harness({ charsPerFrameAtMaxEdge: 2_000_000, scalesWithEdge: false });
    const rendered = await Effect.runPromise(view.render({ documentId: "doc-1" }));

    // A design that cannot be made smaller is bounded by showing less of it, never silently.
    expect(rendered.frames.map((frame) => frame.nodeId)).toEqual([frameIds[0]]);
    expect(rendered.omittedFrames).toBe(frameIds.length - 1);
    expect(rendered.maxEdge).toBeGreaterThanOrEqual(CANVAS_RENDER_MIN_EDGE);
  });

  it("never asks for an edge a design could not be read at", async () => {
    const { view, edges } = harness({ charsPerFrameAtMaxEdge: 400_000 });
    await Effect.runPromise(view.render({ documentId: "doc-1" }));
    expect(edges.every((edge) => edge >= CANVAS_RENDER_MIN_EDGE)).toBe(true);
  });

  it("counts the frames the frame limit left out alongside the ones the budget dropped", async () => {
    const many = Array.from({ length: CANVAS_RENDER_FRAME_LIMIT + 6 }, (_entry, index) => ({
      id: `slide-${index}`,
      role: "slide",
    }));
    const { view } = harness({
      charsPerFrameAtMaxEdge: 2_000_000,
      scalesWithEdge: false,
      frames: many,
    });
    const rendered = await Effect.runPromise(view.render({ documentId: "doc-1" }));
    // 30 slides in the document, 24 renderable, and only the first survives a payload that cannot
    // shrink at all. Everything left out is reported, from both bounds.
    expect(rendered.omittedFrames).toBe(29);
  });

  it("does not rasterize a design that has no frames", async () => {
    let renders = 0;
    const { view } = harness({
      charsPerFrameAtMaxEdge: 10_000,
      frames: [],
      onRender: () => {
        renders += 1;
      },
    });
    const rendered = await Effect.runPromise(view.render({ documentId: "doc-1", maxEdge: 512 }));

    expect(renders).toBe(0);
    expect(rendered.frames).toEqual([]);
    expect(rendered.omittedFrames).toBe(0);
    expect(rendered.maxEdge).toBe(512);
  });

  it("refuses to render a design that is in the trash", async () => {
    const { view } = harness({ charsPerFrameAtMaxEdge: 10_000, file: { trashed: true } });
    await expect(Effect.runPromise(view.render({ documentId: "doc-1" }))).rejects.toThrow(/trash/u);
  });

  it("reports the sequence and whether the projection can be trusted", async () => {
    const { view } = harness({
      charsPerFrameAtMaxEdge: 10_000,
      file: { sequence: 9, projectionCurrent: false },
    });
    const rendered = await Effect.runPromise(view.render({ documentId: "doc-1" }));
    expect(rendered.sequence).toBe(9);
    expect(rendered.projectionCurrent).toBe(false);
    expect(rendered.frames.every((frame) => frame.sequence === 9)).toBe(true);
  });
});

describe("canvas view frame selection", () => {
  it("keeps document order and reports the roles it recognizes", () => {
    const selection = selectViewFrames(
      {
        children: [
          { id: "a", role: "slide" },
          { id: "b", role: "route" },
          { id: "c", role: "not-a-role" },
        ],
      },
      CANVAS_RENDER_FRAME_LIMIT,
    );
    expect(selection.frames).toEqual([
      { nodeId: "a", role: "slide" },
      { nodeId: "b", role: "route" },
      { nodeId: "c", role: undefined },
    ]);
    expect(selection.omitted).toBe(0);
  });

  it("bounds a document with more frames than the limit and counts the rest", () => {
    const children = Array.from({ length: CANVAS_RENDER_FRAME_LIMIT + 3 }, (_entry, index) => ({
      id: `frame-${index}`,
      role: "slide",
    }));
    const selection = selectViewFrames({ children }, CANVAS_RENDER_FRAME_LIMIT);
    expect(selection.frames).toHaveLength(CANVAS_RENDER_FRAME_LIMIT);
    expect(selection.omitted).toBe(3);
  });

  it("ignores children that are not frames", () => {
    const selection = selectViewFrames({ children: [{ role: "slide" }, { id: "" }] }, 24);
    expect(selection.frames).toEqual([]);
  });
});
