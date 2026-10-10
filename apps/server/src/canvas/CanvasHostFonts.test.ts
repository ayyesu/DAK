// @effect-diagnostics nodeBuiltinImport:off - The test asserts on real font bytes read from the
// vendored tree, which is the whole point: it reads the filesystem the engine will read.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  CANVAS_FONT_FILE_ALIASES,
  CANVAS_HOST_FONT_FILES,
  readCanvasFace,
} from "./CanvasHostFonts.ts";

// `apps/server/src/canvas` -> repo root is four levels up.
const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);

/**
 * The directories a real render searches, in the same order `CanvasEngineLive` registers them.
 *
 * Duplicated here rather than imported so the test would notice if the engine's order stopped
 * matching what the shipped layout can satisfy — which is how a face ends up "present" and unfound.
 */
const directories = [
  NodePath.join(repoRoot, "packages/canvas-engine/upstream/src"),
  NodePath.join(repoRoot, "packages/canvas-engine/upstream/vendor/open-pencil/fonts"),
  NodePath.join(repoRoot, "packages/canvas-engine/fonts"),
];

const isTrueType = (bytes: ArrayBuffer): boolean => {
  // A TTF starts 0x00010000 or "true"; a woff2 starts "wOF2". CanvasKit accepts the former only, so
  // this is the assertion that keeps a renamed woff2 from being staged as though it were a font.
  const tag = String.fromCharCode(...new Uint8Array(bytes.slice(0, 4)));
  return tag === "OTTO" || new DataView(bytes).getUint32(0) === 0x00010000 || tag === "true";
};

describe("canvas host fonts", () => {
  it("loads every Inter weight DAK ships, including the one that was missing", async () => {
    // The style is part of the key, so each weight is asked for by its own style rather than all
    // through "Regular" — which is why this lists them as full "Family|Style" keys.
    for (const [key, style] of [
      ["Inter|Regular", "Regular"],
      ["Inter|Medium", "Medium"],
      ["Inter|SemiBold", "SemiBold"],
      ["Inter|Bold", "Bold"],
      ["Inter|ExtraBold", "ExtraBold"],
    ] as const) {
      const [family, keyStyle] = key.split("|") as [string, string];
      expect(keyStyle).toBe(style);
      const bytes = await readCanvasFace(family, style, { directories });
      expect(bytes, `${key} must resolve`).not.toBeNull();
      expect(isTrueType(bytes!), `${CANVAS_HOST_FONT_FILES[key]} must be a real TTF`).toBe(true);
    }
  });

  // The woff2 the engine names cannot work: bytes reach CanvasKit unmodified, so the substitute has
  // to be a real TTF. Shipping the woff2 under the requested name would fail at render time.
  it("serves JetBrains Mono as a real TTF despite the engine naming a woff2", async () => {
    expect(CANVAS_HOST_FONT_FILES["JetBrains Mono|Regular"]).toBe("jetbrains-mono-400.woff2");
    const bytes = await readCanvasFace("JetBrains Mono", "Regular", { directories });
    expect(bytes).not.toBeNull();
    expect(isTrueType(bytes!)).toBe(true);
    expect(CANVAS_FONT_FILE_ALIASES["jetbrains-mono-400.woff2"]).toBe("jetbrains-mono-400.ttf");
  });

  it("serves JetBrains Mono Medium too", async () => {
    const bytes = await readCanvasFace("JetBrains Mono", "Medium", { directories });
    expect(bytes).not.toBeNull();
    expect(isTrueType(bytes!)).toBe(true);
  });

  // Deliberate exclusions. These must answer null so the engine can report `unknown_font`, not throw
  // and not substitute another face, which would put the wrong glyphs on a design silently.
  it("answers null for the deliberately excluded faces rather than substituting", async () => {
    for (const [face, style] of [
      ["Noto Color Emoji", "Regular"],
      ["Material Symbols Outlined", "Regular"],
      ["Material Symbols Rounded", "Regular"],
      ["Material Symbols Sharp", "Regular"],
      ["Noto Naskh Arabic", "Regular"],
    ] as const) {
      expect(
        await readCanvasFace(face, style, { directories }),
        `${face} must be absent`,
      ).toBeNull();
    }
  });

  // An icon font falling back to a text face would print literal ligature words like
  // "arrow_forward" across a design, which is worse than an error.
  it("never substitutes a text face for a missing icon font", async () => {
    const files = { "Material Symbols Rounded|Regular": "missing.woff2" };
    expect(
      await readCanvasFace("Material Symbols Rounded", "Regular", { directories, files }),
    ).toBeNull();
  });

  it("returns null for a face no map names, rather than guessing a filename", async () => {
    expect(await readCanvasFace("Nonexistent Face", "Regular", { directories })).toBeNull();
  });

  it("returns null for an unknown style of a known family", async () => {
    expect(await readCanvasFace("Inter", "Black", { directories })).toBeNull();
  });

  it("prefers the earlier directory when a face exists in both", async () => {
    const shadow = NodeFS.mkdtempSync(
      NodePath.join(NodePath.dirname(repoRoot), "dak-font-shadow-"),
    );
    try {
      NodeFS.writeFileSync(NodePath.join(shadow, "Inter-Regular.ttf"), "shadowed");
      const bytes = await readCanvasFace("Inter", "Regular", {
        directories: [shadow, ...directories],
      });
      expect(bytes).not.toBeNull();
      expect(new TextDecoder().decode(new Uint8Array(bytes!))).toBe("shadowed");
    } finally {
      NodeFS.rmSync(shadow, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  // The two engine maps disagree; this asserts the union is covered so the editor path and the
  // screenshot path cannot resolve different sets of faces again.
  it("covers the union of both engine font maps", () => {
    const faces = Object.keys(CANVAS_HOST_FONT_FILES);
    expect(faces).toContain("Inter|ExtraBold");
    expect(faces).toContain("Noto Naskh Arabic|Regular");
    expect(faces).toContain("JetBrains Mono|Regular");
    expect(faces.length).toBeGreaterThanOrEqual(11);
  });
});
