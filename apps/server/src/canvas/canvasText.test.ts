// @effect-diagnostics nodeBuiltinImport:off - This test loads a JSON fixture from disk and rasterizes
// with the real CanvasKit runtime.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { make as makeEngine } from "./CanvasEngineLive.ts";
import {
  absoluteBoxes,
  findEmptyButtonShapes,
  measureTextNodes,
  shouldWrap,
  textNodeIds,
  withMeasuredWrap,
} from "./canvasText.ts";
import { detectFrameOverflow, detectModuleViewportMismatch } from "./canvasInvariants.ts";
import {
  createDocumentModel,
  encodeState,
} from "@dak/canvas-engine/upstream/src/document-model.mjs";

/**
 * The real portfolio landing page, measured rather than estimated.
 *
 * This is the design whose headline used to arrive sliced through the middle of a word and whose
 * navigation button was a dark blob with no label. It is committed as a fixture so the suite never
 * depends on a developer's disk, and rebuilt by `scripts/canvas-portfolio-fixture.ts`.
 */

interface Fixture {
  readonly title: string;
  readonly module: string;
  readonly sequence: number;
  readonly nodeCount: number;
  readonly textCount: number;
  readonly document: unknown;
}

const fixture = JSON.parse(
  NodeFS.readFileSync(new URL("./fixtures/portfolio-landing-page.json", import.meta.url), "utf8"),
) as Fixture;

const engine = makeEngine();

const payloadOf = (document: unknown) => {
  const model = createDocumentModel(document);
  try {
    return {
      snapshot: { throughSequence: 0, state: encodeState(model), source: document },
      updates: [],
    };
  } finally {
    model.doc.destroy();
  }
};

const findNode = (root: any, id: string): any =>
  root?.id === id
    ? root
    : (root?.children ?? []).map((child: any) => findNode(child, id)).find(Boolean);

describe("the portfolio fixture", () => {
  it("is the design it claims to be", () => {
    expect(fixture.title).toBe("Portfolio Landing Page");
    expect(fixture.module).toBe("web");
    expect(fixture.document).toBeTruthy();
    expect(textNodeIds(fixture.document).length).toBe(fixture.textCount);
  });

  it("has no frame with content laid out in a row", () => {
    expect(detectFrameOverflow(fixture.document)).toEqual([]);
  });

  it("reports the phone-width frames in a web design once per deliverable", () => {
    const issues = detectModuleViewportMismatch(fixture.document);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.kind).toBe("viewport_mismatch");
  });
});

describe("measured text wraps by default", () => {
  it("wraps a text node that declares a width and says nothing about growth", async () => {
    const document = {
      module: "generic",
      axes: {},
      variables: {},
      paragraphStyles: {},
      imports: {},
      flows: [],
      children: [
        {
          type: "frame",
          id: "f",
          x: 0,
          y: 0,
          width: 390,
          height: 900,
          children: [
            {
              type: "text",
              id: "h1",
              content: "A headline long enough that it cannot possibly stay on one line",
              x: 16,
              y: 40,
              width: 358,
              fontSize: 38,
              fill: "#0f172a",
            },
          ],
        },
      ],
    };
    const node = findNode(document, "h1");
    expect(shouldWrap(node)).toBe(true);

    const normalized = (await withMeasuredWrap(document)) as any;
    const wrapped = findNode(normalized, "h1");
    expect(wrapped.textGrowth).toBe("fixed-width-height");
    expect(typeof wrapped.height).toBe("number");
    expect(wrapped.height).toBeGreaterThan(46);
  });

  it("leaves an explicit auto alone, because that is a decision not an omission", () => {
    const node = { type: "text", id: "t", width: 100, textGrowth: "auto" };
    expect(shouldWrap(node)).toBe(false);
  });

  it("leaves text with no declared width alone", () => {
    expect(shouldWrap({ type: "text", id: "t", textGrowth: undefined })).toBe(false);
  });

  it("wraps inside a nested frame", async () => {
    const document = {
      module: "generic",
      axes: {},
      variables: {},
      paragraphStyles: {},
      imports: {},
      flows: [],
      children: [
        {
          type: "frame",
          id: "page",
          x: 0,
          y: 0,
          width: 390,
          height: 900,
          children: [
            {
              type: "frame",
              id: "card",
              x: 16,
              y: 16,
              width: 358,
              height: 200,
              children: [
                {
                  type: "text",
                  id: "card-title",
                  content: "A title that is far too long for the card it sits in",
                  x: 16,
                  y: 16,
                  width: 326,
                  fontSize: 20,
                  fill: "#0f172a",
                },
              ],
            },
          ],
        },
      ],
    };
    const normalized = (await withMeasuredWrap(document)) as any;
    expect(findNode(normalized, "card-title").textGrowth).toBe("fixed-width-height");
    expect(findNode(normalized, "card-title").height).toBeGreaterThan(20);
  });

  it("wraps under an auto-layout parent that has to hug the taller text", async () => {
    // The parent declares vertical auto-layout and hugs its content, so a wrapped child makes the
    // parent taller. If the wrap were applied after layout the parent would keep the old height and
    // the second line would fall outside it.
    const document = {
      module: "generic",
      axes: {},
      variables: {},
      paragraphStyles: {},
      imports: {},
      flows: [],
      children: [
        {
          type: "frame",
          id: "stack",
          layout: "vertical",
          gap: 8,
          x: 0,
          y: 0,
          width: 390,
          height: 120,
          children: [
            {
              type: "text",
              id: "body",
              content:
                "A paragraph of copy that will certainly wrap across several lines once it is given a sensible measure",
              x: 16,
              y: 16,
              width: 358,
              fontSize: 16,
              fill: "#334155",
            },
          ],
        },
      ],
    };
    const normalized = (await withMeasuredWrap(document)) as any;
    const body = findNode(normalized, "body");
    expect(body.height).toBeGreaterThan(16);

    // The parent has to be at least as tall as the wrapped text plus its own padding.
    const shots = await engine.renderFrames({
      payload: payloadOf(normalized),
      nodeIds: ["stack"],
      maxEdge: 2048,
    });
    expect(shots[0]?.width).toBe(390);
  });
});

describe("the portfolio page has no clipped text after the wrap default", () => {
  it("leaves every text node tall enough for the lines the shaper produced", async () => {
    const normalized = (await withMeasuredWrap(
      JSON.parse(JSON.stringify(fixture.document)),
    )) as any;
    const ids = textNodeIds(normalized);
    const measured = await measureTextNodes(normalized, ids);
    const clipped: string[] = [];
    for (const [id, entry] of measured) {
      const node = findNode(normalized, id);
      if (typeof node?.height === "number" && entry.derivedHeight > node.height + 1)
        clipped.push(id);
    }
    expect(clipped).toEqual([]);
  });
});

describe("the portfolio page's unlabelled controls", () => {
  it("finds the navigation button, which was a dark blob with no label", async () => {
    const normalized = (await withMeasuredWrap(
      JSON.parse(JSON.stringify(fixture.document)),
    )) as any;
    const measured = await measureTextNodes(normalized, textNodeIds(normalized));
    const empty = findEmptyButtonShapes(normalized, absoluteBoxes(normalized, measured));
    expect(empty.map((shape) => shape.id)).toContain("nav-cta");
  });

  it("does not report a progress track, which is short and wide and has no label either", async () => {
    const normalized = (await withMeasuredWrap(
      JSON.parse(JSON.stringify(fixture.document)),
    )) as any;
    const measured = await measureTextNodes(normalized, textNodeIds(normalized));
    const empty = findEmptyButtonShapes(normalized, absoluteBoxes(normalized, measured));
    expect(empty.map((shape) => shape.id)).not.toContain("skill-bar-2");
  });

  it("stops reporting a shape once a label is placed on it", async () => {
    const document = JSON.parse(JSON.stringify(fixture.document));
    const cta = findNode(document, "nav-cta");
    cta.children = [
      {
        type: "text",
        id: "nav-cta-label",
        content: "Hire me",
        x: 8,
        y: 10,
        width: 28,
        fontSize: 12,
        fill: "#ffffff",
      },
    ];

    // The label needs a measured box before overlap means anything, so the document is normalized
    // first: that is what gives a text node the height its box is computed from.
    const normalized = (await withMeasuredWrap(document)) as any;
    const measured = await measureTextNodes(normalized, textNodeIds(normalized));
    const empty = findEmptyButtonShapes(normalized, absoluteBoxes(normalized, measured));
    expect(empty.map((shape) => shape.id)).not.toContain("nav-cta");
  });
});
