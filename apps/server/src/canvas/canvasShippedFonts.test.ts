// @effect-diagnostics nodeBuiltinImport:off - This test reads real font bytes off disk and
// rasterizes with the real CanvasKit runtime; that is the whole proof.
// @effect-diagnostics globalConsole:off - The proof-image paths are the test's output log.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  createDocumentModel,
  encodeState,
} from "@dak/canvas-engine/upstream/src/document-model.mjs";
import { make as makeEngine } from "./CanvasEngineLive.ts";
import {
  CANVAS_FONT_FILE_ALIASES,
  CANVAS_HOST_FONT_FILES,
  readCanvasFace,
  shippedFontDescription,
  shippedFontFaces,
} from "./CanvasHostFonts.ts";
import {
  CanvasUnknownFontError,
  loadedFamilies,
  measureTextNodes,
  nearestFamily,
  textNodeIds,
} from "./canvasText.ts";
import { normalizeForRender } from "./canvasNormalize.ts";
import { base64ToBytes } from "./bytes.ts";

// `apps/server/src/canvas` -> repo root is four levels up.
const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);

/** The directories a real render searches, in the same order `CanvasEngineLive` registers them. */
const directories = [
  NodePath.join(repoRoot, "apps", "server", "src", "canvas"),
  NodePath.join(repoRoot, "packages", "canvas-engine", "upstream", "src"),
  NodePath.join(
    repoRoot,
    "packages",
    "canvas-engine",
    "upstream",
    "vendor",
    "open-pencil",
    "fonts",
  ),
  NodePath.join(repoRoot, "packages", "canvas-engine", "fonts"),
];

const engine = makeEngine();

const textDoc = (id: string, family: string, weight: number, content = "Hamburgefonstiv") => ({
  module: "generic",
  axes: {},
  variables: {},
  paragraphStyles: {},
  imports: {},
  flows: [],
  children: [
    {
      type: "frame",
      id: "f1",
      x: 0,
      y: 0,
      width: 500,
      height: 300,
      children: [
        {
          type: "text",
          id,
          content,
          x: 0,
          y: 0,
          width: 480,
          fontSize: 24,
          fontFamily: family,
          fontWeight: weight,
          fill: "#000000",
        },
      ],
    },
  ],
});

/** True for a TTF or OTF; a woff2 starts "wOF2" and CanvasKit cannot use it. */
const isTrueType = (bytes: ArrayBuffer): boolean => {
  const tag = String.fromCharCode(...new Uint8Array(bytes.slice(0, 4)));
  return tag === "OTTO" || new DataView(bytes).getUint32(0) === 0x00010000 || tag === "true";
};

/** A variable font carries an `fvar` table; a static instance must not. */
const hasVariableTable = (bytes: ArrayBuffer): boolean => {
  const view = new DataView(bytes);
  const tables = view.getUint16(4);
  for (let index = 0; index < tables; index += 1) {
    const offset = 12 + index * 16;
    const tag = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    if (tag === "fvar") return true;
  }
  return false;
};

describe("shipped font palette", () => {
  it("keeps the manifest and the host loader table as the same set of faces", () => {
    const manifestKeys = shippedFontFaces().map((face) => `${face.family}|${face.style}`);
    const loaderKeys = Object.keys(CANVAS_HOST_FONT_FILES).filter(
      (key) =>
        !key.startsWith("Material Symbols") &&
        key !== "Noto Color Emoji|Regular" &&
        key !== "Noto Naskh Arabic|Regular",
    );
    // Either direction failing means a face the description promises but the renderer cannot
    // load, or a face the renderer loads that the description never names.
    expect([...manifestKeys].sort()).toEqual([...loaderKeys].sort());
    expect(manifestKeys).toContain("Playfair Display|Bold");
    expect(manifestKeys).toContain("Space Grotesk|Medium");
    expect(manifestKeys).toContain("Anton|Regular");
  });

  it("loads every shipped face as a real static TTF", async () => {
    for (const face of shippedFontFaces()) {
      const bytes = await readCanvasFace(face.family, face.style, { directories });
      expect(bytes, `${face.family} (${face.style}) must resolve`).not.toBeNull();
      expect(isTrueType(bytes!), `${face.file} must be a real TTF/OTF`).toBe(true);
      expect(hasVariableTable(bytes!), `${face.file} must be a static instance`).toBe(false);
    }
  });

  it("ships bytes the manifest describes exactly", () => {
    for (const face of shippedFontFaces()) {
      const found = directories
        .map((directory) => NodePath.join(directory, face.file))
        .find((candidate) => NodeFS.existsSync(candidate));
      expect(found, `${face.file} must exist`).toBeDefined();
      expect(NodeFS.statSync(found!).size).toBe(face.bytes);
    }
  });

  it("measures every new family with its own metrics, not Inter's", async () => {
    // One document carrying all five families: a single measure that passes the unknown_font
    // guard proves every one of them loaded, because the guard throws on the first family that
    // did not. The string is long enough to wrap, so each family's own advances break the
    // lines differently — a fallback to Inter would break them identically, which is exactly
    // the M0 bug.
    const content =
      "Pack my box with five dozen liquor jugs and see how the headline breaks across the frame";
    const rows = [
      { id: "inter", family: "Inter", weight: 400 },
      { id: "grotesk", family: "Space Grotesk", weight: 400 },
      { id: "serif", family: "Playfair Display", weight: 400 },
      { id: "condensed", family: "Anton", weight: 400 },
      { id: "mono", family: "JetBrains Mono", weight: 400 },
    ];
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
          id: "f1",
          x: 0,
          y: 0,
          width: 500,
          height: 300,
          children: rows.map((row, index) => ({
            type: "text",
            id: row.id,
            content,
            x: 0,
            y: index * 120,
            width: 200,
            fontSize: 24,
            fontFamily: row.family,
            fontWeight: row.weight,
            fill: "#000000",
          })),
        },
      ],
    };
    const rendered = await normalizeForRender(document);
    const measured = await measureTextNodes(rendered, textNodeIds(rendered));
    expect([...loadedFamilies(measured)].sort()).toEqual(
      ["Anton", "Inter", "JetBrains Mono", "Playfair Display", "Space Grotesk"].sort(),
    );
    const summary = rows.map((row) => {
      const entry = measured.get(row.id);
      return { id: row.id, lines: entry?.lines, height: entry?.derivedHeight };
    });
    console.log("family metrics " + JSON.stringify(summary));
    // Five visibly different typefaces cannot break the same paragraph into the same lines.
    const breaks = new Set(summary.map((row) => `${row.lines}x${row.height}`));
    expect(breaks.size).toBe(rows.length);
  });

  it("lists every shipped family in unknown_font and suggests the nearest match", async () => {
    let thrown: unknown;
    try {
      await normalizeForRender(textDoc("t", "Playfair", 400));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CanvasUnknownFontError);
    const error = thrown as CanvasUnknownFontError;
    expect([...error.available].sort()).toEqual(
      ["Anton", "Inter", "JetBrains Mono", "Playfair Display", "Space Grotesk"].sort(),
    );
    expect(error.nearest).toBe("Playfair Display");
    expect(nearestFamily("Space", error.available)).toBe("Space Grotesk");
    expect(nearestFamily("Inter Display", error.available)).toBe("Inter");
    expect(nearestFamily("Totally Made Up", error.available)).toBeUndefined();
  });

  it("describes the shipped families from the manifest, not from a copied list", () => {
    const description = shippedFontDescription();
    for (const face of shippedFontFaces()) {
      expect(description).toContain(face.family);
      expect(description).toContain(face.style);
    }
    // The guarantee is structural: the tool text calls this function rather than restating it.
    // If someone copies the list into the description by hand, this is the test that notices.
    const toolsSource = NodeFS.readFileSync(
      new URL("../mcp/toolkits/canvas/tools.ts", import.meta.url),
      "utf8",
    );
    expect(toolsSource).toContain("shippedFontDescription()");
  });

  it("keeps the woff2 aliases resolving to real TTFs", () => {
    expect(CANVAS_FONT_FILE_ALIASES["jetbrains-mono-400.woff2"]).toBe("jetbrains-mono-400.ttf");
    expect(CANVAS_HOST_FONT_FILES["JetBrains Mono|Regular"]).toBe("jetbrains-mono-400.woff2");
  });
});

describe("type specimen", () => {
  it("renders the same headline in each family in a single frame", async () => {
    const headline = "Design in a new voice";
    const rows = [
      { id: "row-inter", family: "Inter", weight: 700 },
      { id: "row-playfair", family: "Playfair Display", weight: 700 },
      { id: "row-grotesk", family: "Space Grotesk", weight: 700 },
      { id: "row-anton", family: "Anton", weight: 400 },
      { id: "row-mono", family: "JetBrains Mono", weight: 500 },
    ];
    const frameWidth = 1000;
    const rowHeight = 110;
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
          id: "specimen",
          x: 0,
          y: 0,
          width: frameWidth,
          height: rowHeight * rows.length + 20,
          fill: "#FFFFFF",
          children: rows.map((row, index) => ({
            type: "text",
            id: row.id,
            content: headline,
            x: 20,
            y: 10 + index * rowHeight,
            width: frameWidth - 40,
            fontSize: 44,
            fontFamily: row.family,
            fontWeight: row.weight,
            fill: "#111111",
          })),
        },
      ],
    };
    const rendered = await normalizeForRender(document);
    const model = createDocumentModel(rendered);
    let payload: {
      snapshot: { throughSequence: number; state: string; source: unknown };
      updates: never[];
    };
    try {
      payload = {
        snapshot: { throughSequence: 0, state: encodeState(model), source: rendered },
        updates: [],
      };
    } finally {
      model.doc.destroy();
    }
    const region = await engine.renderRegion({
      payload,
      nodeId: "specimen",
      bounds: { x: 0, y: 0, width: frameWidth, height: rowHeight * rows.length + 20 },
      scale: 2,
    });
    expect(region.width).toBe(frameWidth * 2);
    const proofDir = NodePath.join(process.env.TEMP ?? ".", "dak-canvas-proof");
    await NodeFSP.mkdir(proofDir, { recursive: true });
    const path = NodePath.join(proofDir, "specimen-type-palette.png");
    await NodeFSP.writeFile(path, base64ToBytes(region.data));
    console.log(`specimen: ${path} ${region.width}x${region.height}`);
  }, 180_000);
});
