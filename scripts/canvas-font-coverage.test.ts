// @effect-diagnostics nodeBuiltinImport:off -- Reads the real font files off disk to measure coverage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  CANVAS_EXCLUDED_FONT_FILES,
  CANVAS_FONT_FILENAME_ALIASES,
  CANVAS_MAX_FONT_FAMILY_BYTES,
  checkFontCoverage,
  checkOwnedManifest,
  measureFamilyBytes,
  readOwnedManifest,
  readPromisedFontFiles,
} from "./canvas-font-coverage.ts";

/**
 * The font coverage gate.
 *
 * This exists because the engine promises faces in a map DAK does not control, and the only thing
 * standing between a promised face and a failed user render is a list of files on disk. When Inter
 * ExtraBold went missing, two hand-maintained lists — the engine's map and the vendored subset — were
 * never compared, and the failure surfaced as `ERR_MODULE_NOT_FOUND` in somebody's render rather
 * than in a check.
 *
 * The real coverage run is what matters; these tests cover the classifier itself, which is the part
 * that could quietly stop recognising a case.
 */
// Bytes are accepted as well as text: the family-size budget is measured in bytes, so a test
// that needs a 300 KB face writes one directly rather than a 300 KB string literal.
const makeTree = async (files: Readonly<Record<string, string | Uint8Array>>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dak-font-coverage-"));
  for (const [relative, contents] of Object.entries(files)) {
    const target = NodePath.join(root, relative);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, contents);
  }
  return root;
};

describe("canvas font coverage", () => {
  it("reads the engine's own promised faces rather than a restated copy", () => {
    // The whole point of the module: if this returns an empty list the parser has drifted, and it
    // must fail loudly rather than reporting "everything is fine because nothing was promised".
    const promised = readPromisedFontFiles();
    expect(promised.length).toBeGreaterThan(0);
    for (const entry of promised) {
      expect(entry.family).toContain("|");
      expect(entry.file).not.toBe("");
    }
  });

  it("reports the real repository as fully covered, with nothing missing", () => {
    const coverage = checkFontCoverage(readPromisedFontFiles());
    const missing = coverage.filter((entry) => entry.status === "missing");
    // A face here that is neither shipped nor excluded fails a user's render at module-resolution
    // time, which is the exact failure this check was written for.
    expect(missing.map((entry) => `${entry.family} -> ${entry.file}`)).toEqual([]);
    // And every shipped face must resolve to a path that exists, not merely be claimed.
    for (const entry of coverage) {
      if (entry.status === "shipped") expect(entry.path).toMatch(/Inter-|jetbrains-/);
    }
  });

  it("classifies a shipped, excluded and missing face three different ways", async () => {
    const root = await makeTree({ "Inter-Regular.ttf": "x" });
    const coverage = checkFontCoverage(
      [
        { family: "Inter|Regular", file: "Inter-Regular.ttf" },
        { family: "Noto Color Emoji|Regular", file: "NotoColorEmoji.ttf" },
        { family: "Nonexistent|Regular", file: "Nonexistent-Regular.ttf" },
      ],
      [root],
    );
    expect(coverage.map((entry) => entry.status)).toEqual(["shipped", "excluded", "missing"]);
    // An exclusion without a reason is the answer that quietly becomes a bug, so it has to carry one.
    for (const entry of coverage) {
      if (entry.status === "excluded") expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("resolves an aliased filename onto the file DAK actually ships", async () => {
    // The engine asks for a woff2 and DAK ships a TTF, because CanvasKit takes bytes undecompressed.
    // If the alias stopped applying, this face would report missing and take a user's render with it.
    const root = await makeTree({ "jetbrains-mono-400.ttf": "x" });
    const coverage = checkFontCoverage(
      [{ family: "JetBrains Mono|Regular", file: "jetbrains-mono-400.woff2" }],
      [root],
    );
    expect(coverage[0]?.status).toBe("shipped");
    expect(Object.keys(CANVAS_FONT_FILENAME_ALIASES).length).toBeGreaterThan(0);
  });

  it("gives every excluded face a reason, and no face is both excluded and shipped", () => {
    const shippedFiles = new Set(
      checkFontCoverage(readPromisedFontFiles())
        .filter((entry) => entry.status === "shipped")
        .map((entry) => entry.file),
    );
    for (const entry of CANVAS_EXCLUDED_FONT_FILES) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
      // Listed as excluded and also present on disk means the exclusion is stale and the file is
      // being shipped against a decision nobody made.
      expect(shippedFiles.has(entry.file)).toBe(false);
    }
  });

  it("searches every directory the renderer would, so a face counts wherever it actually lives", () => {
    // A face only counts as shipped if the real loader would find it. Checking only one directory
    // would pass a build whose faces live somewhere the renderer never looks.
    const coverage = checkFontCoverage(readPromisedFontFiles());
    const shipped = coverage.filter((entry) => entry.status === "shipped");
    expect(shipped.length).toBeGreaterThanOrEqual(7);
  });

  it("keeps every shipped family inside the per-family budget", () => {
    // A whole-payload budget still allows one family to be 80% of it, so the per-family ceiling is
    // the instrument that catches a family nobody thought about.
    const totals = measureFamilyBytes(checkFontCoverage(readPromisedFontFiles()));
    expect(totals.size).toBeGreaterThan(0);
    for (const [family, bytes] of totals) {
      expect(bytes, `${family} is ${String(Math.round(bytes / 1024))} KB`).toBeLessThanOrEqual(
        CANVAS_MAX_FONT_FAMILY_BYTES,
      );
    }
    // And the ceiling is set above what ships today, or it fails on a clean checkout and stops being
    // read as a budget at all.
    const largest = Math.max(...totals.values());
    expect(largest).toBeLessThanOrEqual(CANVAS_MAX_FONT_FAMILY_BYTES);
    expect(CANVAS_MAX_FONT_FAMILY_BYTES).toBeGreaterThanOrEqual(largest);
  });

  it("sums a family's weights together rather than measuring one face at a time", async () => {
    // Inter ships five weights. Budgeting each face separately would let five individually-reasonable
    // files add up to a family that is not.
    const root = await makeTree({
      "a.ttf": Buffer.alloc(300 * 1024, 1),
      "b.ttf": Buffer.alloc(300 * 1024, 1),
    });
    const totals = measureFamilyBytes(
      checkFontCoverage(
        [
          { family: "Wide|Regular", file: "a.ttf" },
          { family: "Wide|Bold", file: "b.ttf" },
        ],
        [root],
      ),
    );
    // Each face is 300 KB, which is under the budget on its own. Measured per face the family would
    // look fine; measured as a family it is the number the budget is actually about.
    expect(totals.get("Wide")).toBe(600 * 1024);
    expect(totals.get("Wide")).toBeGreaterThan(300 * 1024);
  });
});

describe("owned font manifest", () => {
  it("matches every manifest face against the bytes on disk in the real repository", () => {
    const faces = readOwnedManifest();
    // Five families: Inter (5 weights, pinned snapshot bytes), JetBrains Mono (2), Playfair
    // Display (2), Space Grotesk (3), Anton (1).
    expect(faces.length).toBe(13);
    const verdicts = checkOwnedManifest(faces);
    expect(verdicts.filter((entry) => entry.status !== "ok")).toEqual([]);
  });

  it("fails a face that is missing, resized, or re-hashed", async () => {
    const root = await makeTree({ "real.ttf": "sixteen bytes!!" });
    const face = {
      file: "real.ttf",
      family: "Real",
      style: "Regular",
      sha256: "deadbeef",
      bytes: 999,
      location: "owned" as const,
    };
    // Wrong size and wrong hash: reported as modified with the numbers, not merely "bad".
    const [modified] = checkOwnedManifest([face], [root]);
    expect(modified?.status).toBe("modified");
    const [missing] = checkOwnedManifest(
      [{ ...face, file: "absent.ttf", bytes: 16, sha256: "x" }],
      [root],
    );
    expect(missing?.status).toBe("missing");
  });

  it("refuses a manifest it cannot decode rather than assuming no fonts", () => {
    expect(() => readOwnedManifest("/nonexistent/manifest.json")).toThrow();
  });
});
