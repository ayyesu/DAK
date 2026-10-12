// @effect-diagnostics globalDate:off - Wall-clock rasterization time is the thing being measured.
// @effect-diagnostics globalConsole:off - The measured numbers are this test's output.
// @effect-diagnostics globalRandom:off - Its dummy ids are not the behaviour under test.
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import { make as makeEngine } from "./CanvasEngineLive.ts";
import type { CanvasDocumentPayload } from "./CanvasPorts.ts";

/**
 * What a design view actually costs to rasterize and to send.
 *
 * These numbers decide the render budget, so they are measured rather than assumed: the real
 * vendored engine rasterizes real multi-frame designs and every figure below is read off that run.
 * The fixtures are chosen to bracket the expensive end — anti-aliased text and noisy detail compress
 * far worse than flat fills, and a budget set from a flat-color mock would not hold.
 */

interface SlideShape {
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  /**
   * Rectangles of unrelated color, which is what makes a PNG large, as a photo would. Left at zero
   * by the cases below: painting enough of it to matter exceeds the sandbox's own script and time
   * budgets, so the enforcement path is proved against a double instead of a fixture.
   */
  readonly noisePerFrame: number;
  /** False renders the same slides with no glyphs, which is how the fixture proves text paints. */
  readonly withText?: boolean;
}

/**
 * A text node, authored the way the schema actually requires.
 *
 * Rich text is validated as a partition of the content: a node with content must carry
 * `paragraphs` covering `[0, length)`, and this is the shape every fixture here uses. A node written
 * with a bare string and no partition is refused before it can paint anything.
 */
const textNode = (input: {
  readonly parent: string | null;
  readonly id: string;
  readonly content: string;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  readonly color: string;
}): string =>
  `Insert(${JSON.stringify(input.parent)}, ${JSON.stringify({
    id: input.id,
    type: "text",
    name: "Text",
    width: input.width,
    height: input.height,
    x: input.x,
    y: input.y,
    content: input.content,
    fontSize: input.fontSize,
    color: input.color,
    paragraphs: [{ from: 0, to: input.content.length }],
  })});`;

/** One slide: a background, two panels, and three lines of text, which is a realistic deck page. */
const deckScript = (shape: SlideShape, firstIndex = 0): string => {
  const lines: string[] = [];
  for (let offset = 0; offset < shape.frames; offset++) {
    const index = firstIndex + offset;
    const frame = `slide-${index}`;
    const rect = (id: string, node: Record<string, unknown>) =>
      `Insert(${JSON.stringify(frame)}, ${JSON.stringify({ id, name: "Panel", ...node })});`;
    lines.push(
      `Insert(null, ${JSON.stringify({
        id: frame,
        type: "frame",
        name: `Slide ${index + 1}`,
        width: shape.width,
        height: shape.height,
        x: 0,
        y: index * shape.height,
        fill: { type: "solid", color: "#0b0b10" },
        children: [],
      })});`,
      rect(`${frame}-panel-a`, {
        type: "frame",
        width: 520,
        height: 300,
        x: 80,
        y: 120,
        fill: { type: "solid", color: "#1d2333" },
        children: [],
      }),
      rect(`${frame}-panel-b`, {
        type: "frame",
        width: 520,
        height: 300,
        x: 680,
        y: 120,
        fill: { type: "solid", color: "#243049" },
        children: [],
      }),
    );
    if (shape.withText !== false) {
      lines.push(
        textNode({
          parent: frame,
          id: `${frame}-title`,
          content: `Quarterly review ${index + 1}`,
          width: 1100,
          height: 90,
          x: 80,
          y: 40,
          fontSize: 56,
          color: "#ffffff",
        }),
        textNode({
          parent: frame,
          id: `${frame}-body-a`,
          content:
            "Revenue grew 18% against the same quarter last year, led by the self-serve tier.",
          width: 460,
          height: 220,
          x: 100,
          y: 160,
          fontSize: 22,
          color: "#c8d2e8",
        }),
        textNode({
          parent: frame,
          id: `${frame}-body-b`,
          content:
            "Churn held flat while support volume fell 27%, which is the first time both moved together.",
          width: 460,
          height: 220,
          x: 700,
          y: 160,
          fontSize: 22,
          color: "#c8d2e8",
        }),
      );
    }
    // Deterministic pseudo-noise: a photo is the same shape of cost and this stays reproducible.
    for (let grain = 0; grain < shape.noisePerFrame; grain++) {
      const seed = (index + 1) * 7919 + grain * 104729;
      const color = `#${((seed * 2654435761) % 0xffffff).toString(16).padStart(6, "0")}`;
      lines.push(
        rect(`${frame}-grain-${grain}`, {
          type: "rectangle",
          width: 6,
          height: 6,
          x: (seed % 300) * 6,
          y: (seed % 300) * 6,
          fill: { type: "solid", color },
        }),
      );
    }
  }
  return lines.join("\n");
};

interface Measurement {
  readonly label: string;
  readonly edge: number;
  readonly frames: number;
  readonly longestEdge: number;
  readonly totalBase64Chars: number;
  readonly largestFrameChars: number;
  readonly jsonChars: number;
  readonly deflatedBytes: number;
  readonly rasterMs: number;
}

const measure = async (
  label: string,
  shape: SlideShape,
  maxEdge: number,
  /**
   * The design is authored as several executions rather than one. That is how an agent actually
   * works — the sandbox caps one script at 100 KB — and it also means the measurement covers a
   * document whose state arrives incrementally.
   */
  chunked = false,
): Promise<Measurement> => {
  const engine = makeEngine();
  const blank = await engine.createBlankDocument({ module: "deck" });
  let authored: CanvasDocumentPayload = {
    snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
    updates: [],
  };
  const scripts = chunked
    ? Array.from({ length: shape.frames }, (_entry, index) =>
        deckScript({ ...shape, frames: 1 }, index),
      )
    : [deckScript(shape)];
  for (const code of scripts) {
    const executed = await engine.execute({ payload: authored, code, module: "deck" });
    authored = {
      snapshot: {
        throughSequence: authored.snapshot.throughSequence + 1,
        state: executed.state,
        source: executed.document,
      },
      updates: [],
    };
  }
  const nodeIds = Array.from({ length: shape.frames }, (_entry, index) => `slide-${index}`);

  const at = Date.now();
  const shots = await engine.renderFrames({ payload: authored, nodeIds, maxEdge });
  const rasterMs = Date.now() - at;

  const base64 = shots.map((shot) => shot.data);
  const json = JSON.stringify(shots);
  return {
    label,
    edge: maxEdge,
    frames: shots.length,
    longestEdge: Math.max(...shots.map((shot) => Math.max(shot.width, shot.height))),
    totalBase64Chars: base64.reduce((sum, data) => sum + data.length, 0),
    largestFrameChars: Math.max(...base64.map((data) => data.length)),
    jsonChars: json.length,
    deflatedBytes: NodeZlib.gzipSync(json).byteLength,
    rasterMs,
  };
};

describe("canvas render cost", () => {
  it("measures what the expensive designs cost to rasterize and send", async () => {
    const cases: Array<{ label: string; shape: SlideShape; edge: number }> = [
      {
        label: "deck-6",
        shape: { frames: 6, width: 1280, height: 720, noisePerFrame: 0 },
        edge: 2048,
      },
      {
        // The frame limit the view is allowed to ask for, at the edge it asks for.
        label: "deck-24",
        shape: { frames: 24, width: 1280, height: 720, noisePerFrame: 0 },
        edge: 2048,
      },
      {
        // The same design asked for at a quarter of the edge, which is what a side panel actually
        // displays. Bytes and raster time should both fall with the rendered area.
        label: "deck-6@512",
        shape: { frames: 6, width: 1280, height: 720, noisePerFrame: 0 },
        edge: 512,
      },
      {
        // The same slides with no glyphs. It exists to prove the fixture above actually paints text:
        // if the two came out the same size, every number here would be from a flat mock.
        label: "deck-6-notext",
        shape: { frames: 6, width: 1280, height: 720, noisePerFrame: 0, withText: false },
        edge: 2048,
      },
    ];

    const measurements: Measurement[] = [];
    for (const entry of cases)
      measurements.push(await measure(entry.label, entry.shape, entry.edge));

    for (const entry of measurements) {
      console.log(
        `[canvas-render] ${entry.label} edge=${entry.edge} frames=${entry.frames} longest=${entry.longestEdge}px ` +
          `base64=${entry.totalBase64Chars}chars largest-frame=${entry.largestFrameChars}chars ` +
          `json=${entry.jsonChars}chars deflated=${entry.deflatedBytes}bytes ` +
          `(${(entry.jsonChars / entry.deflatedBytes).toFixed(2)}x) rasters=${entry.rasterMs}ms`,
      );
    }

    for (const entry of measurements) {
      expect(entry.frames).toBeGreaterThan(0);
      expect(entry.totalBase64Chars).toBeGreaterThan(0);
    }

    const withText = measurements.find((entry) => entry.label === "deck-6")!;
    const withoutText = measurements.find((entry) => entry.label === "deck-6-notext")!;
    // Glyphs are anti-aliased, so they cost bytes a flat rectangle does not. A small gap would mean
    // the text never painted and every figure above understates the real cost.
    expect(withText.totalBase64Chars).toBeGreaterThan(withoutText.totalBase64Chars * 1.2);
  }, 900_000);
});
