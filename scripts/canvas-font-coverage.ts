#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - A build-verification script, not service code.
// @effect-diagnostics globalConsole:off - Its output is the build log for a step that gates `check`.
/**
 * Reconciles the faces the vendored engine promises against the files DAK actually ships.
 *
 * The renderer loads a font by looking it up in `BUNDLED_FONT_FILES` and, when it is not found,
 * reaching for a bare `@open-pencil/core` import that no package depends on. The result is that a
 * design using a missing face fails with `ERR_MODULE_NOT_FOUND` — a module-resolution error raised
 * long after the vendoring step that dropped it, aimed at nobody. That is how Inter ExtraBold came
 * to be absent for so long: the subset list in `canvas-vendor.ts` and the engine's font map were two
 * independent hand-maintained lists that were never compared.
 *
 * So the two are compared here, and every face must resolve to one of exactly three answers:
 * shipped, deliberately excluded with a reason, or an error. Adding a face upstream without shipping
 * it now fails `canvas-vendor.ts check` instead of failing a user's render.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const snapshotDir = NodePath.join(repoRoot, "packages", "canvas-engine", "upstream");
const ownedFontsDir = NodePath.join(repoRoot, "packages", "canvas-engine", "fonts");
const screenshotModule = NodePath.join(snapshotDir, "src", "document-screenshot.mjs");

/**
 * Where a face may live, in the order the editor-path loader tries them.
 *
 * The screenshot/measure path is stricter than this: `document-screenshot.mjs` installs its own
 * loader that tries only the snapshot's `src` and `vendor/open-pencil/fonts` directories, keyed
 * by its own pinned map. A DAK-owned face is therefore found here but not there, which is why
 * the engine preloads the shipped bytes into the font cache at startup instead of relying on
 * either loader alone. Keeping the owned directory in this search means a face counts as shipped
 * wherever the editor path would actually find it.
 */
const FONT_SEARCH_DIRECTORIES = [
  NodePath.join(snapshotDir, "src"),
  NodePath.join(snapshotDir, "vendor", "open-pencil", "fonts"),
  // Faces DAK owns rather than vendored, resolved by the editor-path host loader and staged
  // beside the bundle for packaged builds.
  ownedFontsDir,
] as const;

/**
 * Faces DAK ships under a different filename than the engine asks for.
 *
 * The vendored map names `.woff2` for these, and the answer is not to ship a woff2: bytes go
 * straight from the loader to `provider.registerFont` with no decompression, and CanvasKit accepts
 * only TTF/OTF. So the file is shipped as the official TTF under its own weight-based name and the
 * engine's request is mapped onto it. Renaming is recorded here rather than left implicit, because a
 * reader comparing the engine's font map against the shipped directory would otherwise see a mismatch
 * with no explanation.
 */
export const CANVAS_FONT_FILENAME_ALIASES: Readonly<Record<string, string>> = {
  "jetbrains-mono-400.woff2": "jetbrains-mono-400.ttf",
  "jetbrains-mono-500.woff2": "jetbrains-mono-500.ttf",
};

/**
 * Faces the engine lists that DAK deliberately does not ship.
 *
 * Each needs a reason next to it, because "excluded" is the answer that silently becomes a bug: the
 * whole point of writing this list is that a reader can tell an intentional gap from an accident.
 */
export const CANVAS_EXCLUDED_FONT_FILES: ReadonlyArray<{
  readonly file: string;
  readonly reason: string;
}> = [
  {
    file: "NotoColorEmoji.ttf",
    reason:
      "10.5 MB for glyphs almost no design uses, and 87% of the font payload. Fetched on demand " +
      "for a document that references it, which is why `unknown_font` is a Canvas failure code " +
      "rather than a silent substitution.",
  },
  {
    file: "material-symbols-outlined.woff2",
    reason:
      'Unused. Material Symbols reach a document only as a `type: "icon"` node whose geometry ' +
      "comes from `icon-chunks/*.json`; no operation, skill, or exporter sets it as a font family. " +
      "The engine's own map lists it as a last-resort fallback that never runs once the host font " +
      "provider answers. Shipping it would add a variable font for no reachable code path.",
  },
  {
    file: "material-symbols-rounded.woff2",
    reason: "Same as material-symbols-outlined.woff2: icons resolve as vector paths, not glyphs.",
  },
  {
    file: "material-symbols-sharp.woff2",
    reason: "Same as material-symbols-outlined.woff2: icons resolve as vector paths, not glyphs.",
  },
];

/** The faces the engine promises, parsed out of its own map rather than restated here. */
export function readPromisedFontFiles(
  modulePath: string = screenshotModule,
): ReadonlyArray<{ readonly family: string; readonly file: string }> {
  const source = NodeFS.readFileSync(modulePath, "utf8");
  // `BUNDLED_FONT_FILES` is a `new Map([["Family|Style", "file"], …])`. Reading it from the engine
  // is the whole point: a restated copy is the bug this module exists to prevent.
  const entries = [...source.matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((match) => ({
    family: match[1] ?? "",
    file: match[2] ?? "",
  }));
  if (entries.length === 0) {
    throw new Error(
      `Could not read BUNDLED_FONT_FILES out of ${modulePath}. If the engine renamed the map, fix ` +
        `this parser rather than assuming the font list is empty.`,
    );
  }
  return entries;
}

/**
 * The most bytes any one family may cost.
 *
 * `CANVAS_BUDGETS.fontBytes` bounds the whole font payload, which is the wrong instrument for a
 * single runaway family: 2 MB total still allows one family to be 80% of it. A family at that size is
 * also often not worth carrying — an icon set that should be vector nodes, or a CJK face that should
 * be a deliberate decision.
 *
 * Set from what is actually shipped rather than a round number: Inter is five weights at 1626 KB, so
 * anything under that fails on a clean checkout and the budget stops being read as a budget. The
 * headroom to 2 MB is about a quarter, which catches a family that arrives large without failing on
 * the families already here.
 */
export const CANVAS_MAX_FONT_FAMILY_BYTES = 2 * 1024 * 1024;

export type CanvasFontCoverage =
  | {
      readonly family: string;
      readonly file: string;
      readonly status: "shipped";
      readonly path: string;
    }
  | {
      readonly family: string;
      readonly file: string;
      readonly status: "excluded";
      readonly reason: string;
    }
  | { readonly family: string; readonly file: string; readonly status: "missing" };

/** Every shipped face's family, with its on-disk size, for the per-family budget. */
export function measureFamilyBytes(
  coverage: ReadonlyArray<CanvasFontCoverage>,
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const entry of coverage) {
    if (entry.status !== "shipped") continue;
    const family = entry.family.split("|")[0] ?? entry.family;
    totals.set(family, (totals.get(family) ?? 0) + NodeFS.statSync(entry.path).size);
  }
  return totals;
}

/** Classifies every promised face as shipped, deliberately excluded, or missing. */
export function checkFontCoverage(
  entries: ReadonlyArray<{ readonly family: string; readonly file: string }>,
  searchDirectories: ReadonlyArray<string> = FONT_SEARCH_DIRECTORIES,
): ReadonlyArray<CanvasFontCoverage> {
  return entries.map((entry) => {
    const shippedName = CANVAS_FONT_FILENAME_ALIASES[entry.file] ?? entry.file;
    const found = searchDirectories
      .map((directory) => NodePath.join(directory, shippedName))
      .find((candidate) => NodeFS.existsSync(candidate));
    if (found !== undefined) {
      return { ...entry, status: "shipped", path: found };
    }
    const excluded = CANVAS_EXCLUDED_FONT_FILES.find((item) => item.file === entry.file);
    if (excluded !== undefined) {
      return { ...entry, status: "excluded", reason: excluded.reason };
    }
    return { ...entry, status: "missing" };
  });
}

export interface OwnedManifestFace {
  readonly file: string;
  readonly family: string;
  readonly style: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly location: "owned" | "upstream-vendor";
}

/** Every face `packages/canvas-engine/fonts/manifest.json` promises, decoded strictly. */
export function readOwnedManifest(
  manifestPath: string = NodePath.join(ownedFontsDir, "manifest.json"),
): ReadonlyArray<OwnedManifestFace> {
  const parsed = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
    fonts?: ReadonlyArray<Record<string, unknown>>;
  };
  if (!Array.isArray(parsed.fonts)) {
    throw new Error(
      `Could not read a fonts list out of ${manifestPath}. The manifest is the shipped-font ` +
        `record; fix it rather than assuming the font list is empty.`,
    );
  }
  return parsed.fonts.map((face) => {
    if (
      typeof face["file"] !== "string" ||
      typeof face["family"] !== "string" ||
      typeof face["style"] !== "string" ||
      typeof face["sha256"] !== "string" ||
      typeof face["bytes"] !== "number"
    ) {
      throw new Error(
        `Malformed font entry in ${manifestPath}: ${JSON.stringify(face)}. Every entry needs ` +
          `file, family, style, sha256 and bytes.`,
      );
    }
    const location = face["location"] ?? "owned";
    if (location !== "owned" && location !== "upstream-vendor") {
      throw new Error(`Unknown font location ${JSON.stringify(location)} in ${manifestPath}.`);
    }
    return {
      file: face["file"],
      family: face["family"],
      style: face["style"],
      sha256: face["sha256"],
      bytes: face["bytes"],
      location,
    };
  });
}

export type OwnedManifestVerdict =
  | { readonly face: OwnedManifestFace; readonly status: "ok" }
  | {
      readonly face: OwnedManifestFace;
      readonly status: "missing" | "modified";
      readonly detail: string;
    };

/**
 * Checks every manifest face against the bytes on disk: present, same size, same hash.
 *
 * The manifest is what the tool description promises and the preload loads, so a file that
 * changed without a manifest update is a build failure, not a quiet substitution.
 */
export function checkOwnedManifest(
  faces: ReadonlyArray<OwnedManifestFace>,
  directories: ReadonlyArray<string> = FONT_SEARCH_DIRECTORIES,
): ReadonlyArray<OwnedManifestVerdict> {
  return faces.map((face) => {
    const found = directories
      .map((directory) => NodePath.join(directory, face.file))
      .find((candidate) => NodeFS.existsSync(candidate));
    if (found === undefined) {
      return { face, status: "missing", detail: `no ${face.file} in any font directory` };
    }
    const bytes = NodeFS.readFileSync(found);
    if (bytes.length !== face.bytes) {
      return {
        face,
        status: "modified",
        detail: `${face.file} is ${bytes.length} bytes on disk, manifest says ${face.bytes}`,
      };
    }
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== face.sha256) {
      return {
        face,
        status: "modified",
        detail: `${face.file} hashes ${digest.slice(0, 12)}…, manifest says ${face.sha256.slice(0, 12)}…`,
      };
    }
    return { face, status: "ok" };
  });
}

const promised = readPromisedFontFiles();
const coverage = checkFontCoverage(promised);
const owned = checkOwnedManifest(readOwnedManifest());

for (const entry of coverage) {
  if (entry.status === "shipped") {
    console.log(`  shipped   ${entry.family.padEnd(32)} ${entry.file}`);
  } else if (entry.status === "excluded") {
    console.log(`  excluded  ${entry.family.padEnd(32)} ${entry.file}`);
  } else {
    console.log(`  MISSING   ${entry.family.padEnd(32)} ${entry.file}`);
  }
}

const missing = coverage.filter((entry) => entry.status === "missing");
const excluded = coverage.filter((entry) => entry.status === "excluded");
const oversized = [...measureFamilyBytes(coverage)].filter(
  ([, bytes]) => bytes > CANVAS_MAX_FONT_FAMILY_BYTES,
);
console.log("");
console.log(
  `${String(promised.length)} promised: ${String(coverage.length - missing.length - excluded.length)} shipped, ${String(excluded.length)} excluded, ${String(missing.length)} missing.`,
);
for (const [family, bytes] of measureFamilyBytes(coverage)) {
  console.log(
    `  family    ${family.padEnd(32)} ${String(Math.round(bytes / 1024)).padStart(5)} KB of ${String(Math.round(CANVAS_MAX_FONT_FAMILY_BYTES / 1024))} KB`,
  );
}

if (oversized.length > 0) {
  console.error(
    `\ncanvas-font-coverage: ${oversized.length} font family(ies) exceed the per-family budget of ` +
      `${String(Math.round(CANVAS_MAX_FONT_FAMILY_BYTES / 1024))} KB.\n` +
      oversized
        .map(([family, bytes]) => `  ${family} -> ${String(Math.round(bytes / 1024))} KB`)
        .join("\n") +
      `\nEither it does not earn its weight (an icon family should be vector nodes) or shipping it ` +
      `is a decision worth making deliberately.`,
  );
  process.exit(1);
}

if (missing.length > 0) {
  console.error(
    `\ncanvas-font-coverage: ${missing.length} promised face(s) are neither shipped nor declared ` +
      `excluded.\n  ${missing.map((entry) => `${entry.family} -> ${entry.file}`).join("\n  ")}\n` +
      `A design using one of these fails to render with ERR_MODULE_NOT_FOUND. Either vendor the ` +
      `file or add it to CANVAS_EXCLUDED_FONT_FILES with a reason.`,
  );
  process.exit(1);
}

const badOwned = owned.filter((entry) => entry.status !== "ok");
if (badOwned.length > 0) {
  console.error(
    `\ncanvas-font-coverage: ${badOwned.length} manifest face(s) do not match the bytes on disk.\n` +
      badOwned
        .map((entry) => `  ${entry.face.family} (${entry.face.style}): ${entry.detail}`)
        .join("\n") +
      `\nThe manifest is what the tool description promises and the preload loads. Update it ` +
      `deliberately rather than letting the bytes drift.`,
  );
  process.exit(1);
}
console.log(`manifest: ${owned.length} faces match the bytes on disk.`);
