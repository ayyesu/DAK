import {
  CANVAS_RENDER_FRAME_LIMIT,
  CANVAS_RENDER_MAX_EDGE,
  CANVAS_RENDER_MIN_EDGE,
  CANVAS_RENDER_MIN_SCALE,
  CANVAS_RENDER_PAYLOAD_BUDGET_CHARS,
} from "@dak/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

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

/** The frame the test's design holds, in design units. Long edge first: the cap applies to it. */
const FRAME_LONG_EDGE = 1200;
const FRAME_SHORT_EDGE = 800;

/** Frames whose base64 length the test decides, so the budget arithmetic is exact. */
const engineDouble = (options: {
  readonly projection: CanvasDocument;
  readonly charsPerFrameAtFullSize: number;
  /** True models a payload that does not shrink when the raster does, such as photographic noise. */
  readonly payloadIgnoresResolution?: boolean;
  readonly onRender?: () => void;
}) => {
  const edges: number[] = [];
  const scales: (number | undefined)[] = [];
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
    renderFrames: async ({ nodeIds, maxEdge, scale }) => {
      options.onRender?.();
      const edge = maxEdge ?? CANVAS_RENDER_MAX_EDGE;
      edges.push(edge);
      scales.push(scale);
      // The two steps the engine takes: the caller's scale, then the cap on the frame's long edge.
      // PNG weight follows the raster's area, which is why the cap has to come down with the scale
      // for a design whose frames are already at it.
      const resolution = Math.min(scale ?? edge / CANVAS_RENDER_MAX_EDGE, edge / FRAME_LONG_EDGE);
      const width = Math.max(1, Math.floor(FRAME_LONG_EDGE * resolution));
      const height = Math.max(1, Math.floor(FRAME_SHORT_EDGE * resolution));
      const weight =
        options.payloadIgnoresResolution === true
          ? 1
          : (width * height) / (FRAME_LONG_EDGE * FRAME_SHORT_EDGE);
      return nodeIds.map((nodeId) => ({
        nodeIds: [nodeId],
        width,
        height,
        mimeType: "image/png" as const,
        data: "A".repeat(Math.round(options.charsPerFrameAtFullSize * weight)),
      }));
    },
  };
  return { engine, edges, scales };
};

const harness = (options: {
  readonly charsPerFrameAtFullSize: number;
  readonly payloadIgnoresResolution?: boolean;
  readonly file?: Partial<CanvasStoredDocument>;
  /** The design's top-level nodes. Defaults to six slides. */
  readonly frames?: ReadonlyArray<{ readonly id: string; readonly role?: string }>;
  readonly onRender?: () => void;
}) => {
  const document = stored(options.file);
  const frames = options.frames ?? frameIds.map((id) => ({ id, role: "slide" }));
  const { engine, edges, scales } = engineDouble({ ...options, projection: { children: frames } });
  const view = makeCanvasView({ store: storeDouble(document, { children: frames }), engine });
  return { view, edges, scales };
};

const payloadChars = (frames: ReadonlyArray<{ readonly data: string }>) =>
  frames.reduce((total, frame) => total + frame.data.length, 0);

describe("canvas render budget", () => {
  it.effect("renders once at the requested edge when the payload fits", () =>
    Effect.gen(function* () {
      const { view, edges } = harness({ charsPerFrameAtFullSize: 10_000 });
      const rendered = yield* view.render({ documentId: "doc-1", maxEdge: 1024 });

      expect(edges).toEqual([1024]);
      expect(rendered.frames.map((frame) => frame.nodeId)).toEqual(frameIds);
      expect(rendered.maxEdge).toBe(1024);
      expect(rendered.omittedFrames).toBe(0);
    }),
  );

  it.effect("re-renders once at a smaller edge when the payload does not fit", () =>
    Effect.gen(function* () {
      const { view, edges } = harness({ charsPerFrameAtFullSize: 400_000 });
      const rendered = yield* view.render({ documentId: "doc-1" });

      expect(edges).toHaveLength(2);
      expect(edges[1]!).toBeLessThan(edges[0]!);
      expect(rendered.maxEdge).toBe(edges[1]!);
      // The retry aims at the budget; assert real progress rather than exact rounding.
      expect(payloadChars(rendered.frames)).toBeLessThanOrEqual(CANVAS_RENDER_PAYLOAD_BUDGET_CHARS);
      expect(rendered.omittedFrames).toBe(0);
    }),
  );

  it.effect("re-renders smaller when a view's own scale does not fit its budget", () =>
    Effect.gen(function* () {
      const { view, edges, scales } = harness({ charsPerFrameAtFullSize: 100_000 });
      const rendered = yield* view.render({ documentId: "doc-1", scale: 3 });

      expect(scales[0]).toBe(3);
      expect(scales[1]!).toBeLessThan(3);
      expect(scales[1]!).toBeGreaterThanOrEqual(CANVAS_RENDER_MIN_SCALE);
      // The cap comes down with the scale. A frame tall enough to be at the cap does not shrink when
      // only the scale does, and a tall design's payload is mostly made of those frames — which is
      // how a retry that left the cap alone still cost a frame to the fit.
      expect(edges[1]!).toBeLessThan(edges[0]!);
      expect(edges[1]!).toBeGreaterThanOrEqual(CANVAS_RENDER_MIN_EDGE);
      expect(rendered.maxEdge).toBe(edges[1]!);
      expect(payloadChars(rendered.frames)).toBeLessThanOrEqual(CANVAS_RENDER_PAYLOAD_BUDGET_CHARS);
      expect(rendered.omittedFrames).toBe(0);
    }),
  );

  it.effect("passes a view's scale to the engine and leaves it unset for an edge-only caller", () =>
    Effect.gen(function* () {
      const { view, scales } = harness({ charsPerFrameAtFullSize: 10_000 });
      yield* view.render({ documentId: "doc-1", scale: 2 });
      yield* view.render({ documentId: "doc-1", maxEdge: 1024 });
      expect(scales).toEqual([2, undefined]);
    }),
  );

  it.effect(
    "drops trailing frames rather than shrinking below readability when reducing cannot help",
    () =>
      Effect.gen(function* () {
        const { view } = harness({
          charsPerFrameAtFullSize: 2_000_000,
          payloadIgnoresResolution: true,
        });
        const rendered = yield* view.render({ documentId: "doc-1" });

        // A design that cannot be made smaller is bounded by showing less of it, never silently.
        expect(rendered.frames.map((frame) => frame.nodeId)).toEqual([frameIds[0]]);
        expect(rendered.omittedFrames).toBe(frameIds.length - 1);
        expect(rendered.maxEdge).toBeGreaterThanOrEqual(CANVAS_RENDER_MIN_EDGE);
      }),
  );

  it.effect("never asks for an edge a design could not be read at", () =>
    Effect.gen(function* () {
      const { view, edges } = harness({ charsPerFrameAtFullSize: 400_000 });
      yield* view.render({ documentId: "doc-1" });
      expect(edges.every((edge) => edge >= CANVAS_RENDER_MIN_EDGE)).toBe(true);
    }),
  );

  it.effect(
    "counts the frames the frame limit left out alongside the ones the budget dropped",
    () =>
      Effect.gen(function* () {
        const many = Array.from({ length: CANVAS_RENDER_FRAME_LIMIT + 6 }, (_entry, index) => ({
          id: `slide-${index}`,
          role: "slide",
        }));
        const { view } = harness({
          charsPerFrameAtFullSize: 2_000_000,
          payloadIgnoresResolution: true,
          frames: many,
        });
        const rendered = yield* view.render({ documentId: "doc-1" });
        // 30 slides in the document, 24 renderable, and only the first survives a payload that cannot
        // shrink at all. Everything left out is reported, from both bounds.
        expect(rendered.omittedFrames).toBe(29);
      }),
  );

  it.effect("does not rasterize a design that has no frames", () =>
    Effect.gen(function* () {
      let renders = 0;
      const { view } = harness({
        charsPerFrameAtFullSize: 10_000,
        frames: [],
        onRender: () => {
          renders += 1;
        },
      });
      const rendered = yield* view.render({ documentId: "doc-1", maxEdge: 512 });

      expect(renders).toBe(0);
      expect(rendered.frames).toEqual([]);
      expect(rendered.omittedFrames).toBe(0);
      expect(rendered.maxEdge).toBe(512);
    }),
  );

  it.effect("refuses to render a design that is in the trash", () =>
    Effect.gen(function* () {
      const { view } = harness({ charsPerFrameAtFullSize: 10_000, file: { trashed: true } });
      const failure = yield* Effect.flip(view.render({ documentId: "doc-1" }));
      expect(String(failure)).toMatch(/trash/u);
    }),
  );

  it.effect("reports the sequence and whether the projection can be trusted", () =>
    Effect.gen(function* () {
      const { view } = harness({
        charsPerFrameAtFullSize: 10_000,
        file: { sequence: 9, projectionCurrent: false },
      });
      const rendered = yield* view.render({ documentId: "doc-1" });
      expect(rendered.sequence).toBe(9);
      expect(rendered.projectionCurrent).toBe(false);
      expect(rendered.frames.every((frame) => frame.sequence === 9)).toBe(true);
    }),
  );
});

describe("canvas view frame selection", () => {
  it("keeps document order and reports the roles it recognizes", () => {
    const selection = selectViewFrames(
      {
        children: [
          { id: "a", role: "slide", width: 390, height: 844 },
          { id: "b", role: "route", width: 1440, height: 900 },
          { id: "c", role: "not-a-role", width: 800, height: 600 },
        ],
      },
      CANVAS_RENDER_FRAME_LIMIT,
    );
    expect(selection.frames).toEqual([
      { nodeId: "a", role: "slide", designWidth: 390, designHeight: 844 },
      { nodeId: "b", role: "route", designWidth: 1440, designHeight: 900 },
      { nodeId: "c", role: undefined, designWidth: 800, designHeight: 600 },
    ]);
    expect(selection.omitted).toBe(0);
  });

  /**
   * The size a viewer lays a frame out at, as opposed to the size it was rasterized at.
   *
   * A frame taller than the render edge is delivered scaled down, so the bitmap's dimensions cannot
   * be the frame's size. Carrying the real one is what stops a design resizing itself when the panel
   * is dragged wider.
   */
  it("reports a frame's own size, not the size of the bitmap it was rasterized at", () => {
    const selection = selectViewFrames(
      { children: [{ id: "tall", width: 390, height: 1550 }] },
      24,
    );
    // Rendered at a 1024 edge this arrives as 258x1024; the frame is still 390x1550.
    expect(selection.frames[0]?.designWidth).toBe(390);
    expect(selection.frames[0]?.designHeight).toBe(1550);
  });

  it("gives a frame that declares no size a usable one rather than zero", () => {
    const selection = selectViewFrames({ children: [{ id: "bare" }] }, 24);
    expect(selection.frames[0]?.designWidth).toBeGreaterThan(0);
    expect(selection.frames[0]?.designHeight).toBeGreaterThan(0);
  });

  /**
   * The name is what identifies a frame to a person.
   *
   * `role` says only what shape a frame is, and every screen in a design has the same one. Without
   * the name two designs in one project are both "Portfolio Landing Page" and their frames are
   * indistinguishable, which is what the viewer falls back to "Frame 3" for.
   */
  it("carries each frame's name, which is the only thing that identifies it", () => {
    const selection = selectViewFrames(
      {
        children: [
          { id: "a", name: "Home", width: 390, height: 844 },
          { id: "b", name: "Projects", width: 390, height: 1550 },
        ],
      },
      24,
    );
    expect(selection.frames.map((frame) => frame.name)).toEqual(["Home", "Projects"]);
  });

  it("sends no name for an unnamed frame, so the viewer falls back rather than showing a blank", () => {
    const selection = selectViewFrames(
      { children: [{ id: "blank", name: "   ", width: 390, height: 844 }] },
      24,
    );
    // A whitespace-only name is not a name; rendering one would put an empty caption on the frame.
    expect(selection.frames[0]?.name).toBeUndefined();
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
