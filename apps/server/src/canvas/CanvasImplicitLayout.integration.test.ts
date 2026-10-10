// @effect-diagnostics nodeBuiltinImport:off - This test reads the vendored engine off disk by path,
// because the guarantee it holds is about how that engine places a node.
// @effect-diagnostics globalRandom:off - It builds documents directly rather than through ids.
import { describe, expect, it } from "vite-plus/test";

import { make as makeEngine } from "./CanvasEngineLive.ts";
import { withImplicitAbsoluteLayout } from "./canvasInvariants.ts";
import type { CanvasDocumentPayload } from "./CanvasPorts.ts";

/**
 * The coordinates an author wrote must survive to the screen.
 *
 * The vendored renderer gives a frame with no `layout` key a horizontal auto-layout, and auto-layout
 * discards the `x`/`y` every child was authored at. A 390x5250 page came back as a 15630x5251 strip:
 * the sections of the page ran off to the right in one row, no reviewer could read it, and the
 * export refused it for exceeding the raster limit. Nothing reported the loss.
 *
 * These tests hold the two halves of that apart. A frame that says nothing and whose children carry
 * coordinates is read as absolute, because that is what the author wrote. A frame that says
 * `vertical` still stacks, because that is a choice, not an omission.
 */

const UPSTREAM = new URL("../../../../packages/canvas-engine/upstream/", import.meta.url);
const upstream = (path: string) => new URL(path, UPSTREAM).href;

interface Position {
  readonly x: number;
  readonly y: number;
}
interface GraphNode {
  readonly id: string;
  readonly size?: { readonly w?: number; readonly h?: number };
}
interface Graph {
  getPages: () => ReadonlyArray<{ id: string }>;
  getNode: (id: string) => GraphNode | undefined;
  getChildren: (id: string) => ReadonlyArray<GraphNode>;
  getAbsolutePosition: (id: string) => Position;
}

const ENGINE = (await import(upstream("vendor/open-pencil/engine.source.mjs"))) as {
  computeAllLayouts: (graph: Graph, scopeId: string) => void;
};
const { createOpenPencilGraph } = (await import(upstream("src/openpencil-engine.mjs"))) as {
  createOpenPencilGraph: (document: unknown, assets: Map<string, unknown>) => Graph;
};
const { createDocumentModel, encodeState } = (await import(upstream("src/document-model.mjs"))) as {
  createDocumentModel: (document: unknown) => { doc: { destroy: () => void } };
  /** Already base64: the snapshot carries a string, not bytes. */
  encodeState: (model: never) => string;
};

const documentOf = (children: ReadonlyArray<unknown>, module = "generic") => ({
  module,
  axes: {},
  variables: {},
  paragraphStyles: {},
  imports: {},
  flows: [],
  children,
});

const payloadOf = (document: unknown): CanvasDocumentPayload => {
  const model = createDocumentModel(document);
  try {
    return {
      snapshot: {
        throughSequence: 0,
        state: encodeState(model as never),
        source: document,
      },
      updates: [],
    };
  } finally {
    model.doc.destroy();
  }
};

/** Where the engine actually puts each child, which is what a user would see. */
const placedChildren = (document: unknown, frameId: string) => {
  const graph = createOpenPencilGraph(document, new Map());
  ENGINE.computeAllLayouts(graph, graph.getPages()[0]!.id);
  return (graph.getChildren(frameId) ?? []).map((node) => {
    const absolute = graph.getAbsolutePosition(node.id);
    return { id: node.id, x: absolute.x, y: absolute.y };
  });
};

/** The document as the adapter hands it to the renderer. */
const renderable = (document: unknown) => withImplicitAbsoluteLayout(document);

const rect = (id: string, x?: number, y?: number, width = 60, height = 30) => ({
  type: "rectangle",
  id,
  ...(x === undefined ? {} : { x }),
  ...(y === undefined ? {} : { y }),
  width,
  height,
});

describe("canvas implicit layout survives to the screen", () => {
  it("places children at their authored coordinates when the frame declares no layout", () => {
    const document = documentOf([
      {
        type: "frame",
        id: "page",
        role: "route",
        width: 390,
        height: 400,
        children: [rect("a", 16, 24), rect("b", 16, 96), rect("c", 16, 200)],
      },
    ]);
    expect(placedChildren(renderable(document), "page")).toEqual([
      { id: "a", x: 16, y: 24 },
      { id: "b", x: 16, y: 96 },
      { id: "c", x: 16, y: 200 },
    ]);
  });

  it("would have laid that page out as a row without the fix", () => {
    // The shape of the failure this guards, stated so the fix cannot be quietly dropped: an
    // unfixed renderer puts all three children on one line.
    const document = documentOf([
      {
        type: "frame",
        id: "page",
        width: 390,
        height: 400,
        children: [rect("a", 16, 24), rect("b", 16, 96), rect("c", 16, 200)],
      },
    ]);
    const children = placedChildren(document, "page");
    expect(children.map((child) => child.y)).toEqual([0, 0, 0]);
  });

  it("still auto-lays out a frame that declares vertical", () => {
    const document = documentOf([
      {
        type: "frame",
        id: "page",
        layout: "vertical",
        gap: 8,
        width: 390,
        height: 400,
        children: [rect("a"), rect("b"), rect("c")],
      },
    ]);
    const children = placedChildren(renderable(document), "page");
    expect(children.map((child) => child.x)).toEqual([0, 0, 0]);
    expect(children.map((child) => child.y)).toEqual([0, 38, 76]);
  });

  it("still auto-lays out a frame that declares horizontal", () => {
    const document = documentOf([
      {
        type: "frame",
        id: "page",
        layout: "horizontal",
        gap: 8,
        width: 390,
        height: 400,
        children: [rect("a"), rect("b"), rect("c")],
      },
    ]);
    const children = placedChildren(renderable(document), "page");
    expect(children.map((child) => child.x)).toEqual([0, 68, 136]);
    expect(children.map((child) => child.y)).toEqual([0, 0, 0]);
  });

  it("applies the implicit layout inside nested frames too", () => {
    // The root alone is not enough. A nested card with no layout mode re-flowed its own children
    // into a row, which is what left content running past the page's right edge after the root had
    // already been fixed.
    const document = documentOf([
      {
        type: "frame",
        id: "page",
        width: 390,
        height: 600,
        children: [
          {
            type: "frame",
            id: "card",
            x: 16,
            y: 16,
            width: 358,
            height: 200,
            children: [rect("i1", 8, 8), rect("i2", 8, 48)],
          },
          {
            type: "frame",
            id: "column",
            layout: "vertical",
            x: 16,
            y: 240,
            width: 358,
            height: 200,
            children: [rect("v1"), rect("v2")],
          },
        ],
      },
    ]);
    const rendered = renderable(document);

    expect(placedChildren(rendered, "page")).toEqual([
      { id: "card", x: 16, y: 16 },
      { id: "column", x: 16, y: 240 },
    ]);
    expect(placedChildren(rendered, "card")).toEqual([
      { id: "i1", x: 24, y: 24 },
      { id: "i2", x: 24, y: 64 },
    ]);
    // The declared column still stacks, and still contributes its own offset.
    expect(placedChildren(rendered, "column")).toEqual([
      { id: "v1", x: 16, y: 240 },
      { id: "v2", x: 16, y: 270 },
    ]);
  });

  it("rasterizes a tall page at its own proportions rather than as a strip", async () => {
    const engine = makeEngine();
    const document = documentOf([
      {
        type: "frame",
        id: "page",
        width: 390,
        height: 4800,
        fill: "#ffffff",
        children: Array.from({ length: 30 }, (_, index) =>
          rect(`s-${index}`, 16, index * 160, 358, 140),
        ),
      },
    ]);

    const shots = await engine.renderFrames({
      payload: payloadOf(document),
      nodeIds: ["page"],
      maxEdge: 2048,
    });
    // The page's long edge is what the raster takes, so the short edge comes out near its own 390.
    // Laid out as a row this would instead be 10740 wide and 84 tall.
    expect(shots[0]?.height).toBe(2048);
    expect(shots[0]?.width).toBeLessThan(300);
  });
});

describe("canvas structural issues reach the edit that caused them", () => {
  const engine = makeEngine();

  const rowedPage = (module: "generic" | "web") =>
    documentOf(
      [
        {
          type: "frame",
          id: "page",
          // A role is what makes a frame the module's deliverable, and the schema only accepts
          // `route` on a web design.
          ...(module === "web" ? { role: "route" } : {}),
          width: 390,
          height: 5250,
          fill: "#ffffff",
          children: Array.from({ length: 40 }, (_, index) =>
            rect(`s-${index}`, index * 358, 0, 358, 440),
          ),
        },
      ],
      module,
    );

  it("reports content that overflows its frame, which the engine's own review does not", async () => {
    const result = await engine.execute({
      payload: payloadOf(rowedPage("generic")),
      code: `Insert("page", { id: "extra", type: "rectangle", x: 16, y: 5000, width: 100, height: 20 });`,
      module: "generic",
    });
    expect(result.changed).toBe(true);
    const overflow = result.issues.filter((issue) => issue.kind === "bounds_overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.severity).toBe("critical");
    expect(overflow[0]?.nodeId).toBe("page");
  });

  it("warns that a web design is drawn at a phone width", async () => {
    const result = await engine.execute({
      payload: payloadOf(rowedPage("web")),
      code: `Insert("page", { id: "extra", type: "rectangle", x: 16, y: 5000, width: 100, height: 20 });`,
      module: "web",
    });
    const mismatch = result.issues.filter((issue) => issue.kind === "viewport_mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.severity).toBe("major");
  });

  it("leaves a design that fits alone", async () => {
    const document = documentOf([
      {
        type: "frame",
        id: "page",
        width: 390,
        height: 2000,
        fill: "#ffffff",
        children: [rect("a", 16, 16, 358, 900), rect("b", 16, 960, 358, 900)],
      },
    ]);
    const result = await engine.execute({
      payload: payloadOf(document),
      code: `Insert("page", { id: "extra", type: "rectangle", x: 16, y: 1900, width: 100, height: 20 });`,
      module: "generic",
    });
    expect(result.changed).toBe(true);
    expect(result.issues.filter((issue) => issue.kind === "bounds_overflow")).toEqual([]);
    expect(result.issues.filter((issue) => issue.kind === "viewport_mismatch")).toEqual([]);
  });
});
