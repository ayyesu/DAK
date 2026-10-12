// @effect-diagnostics nodeBuiltinImport:off - This is the filesystem seam for a vendored engine
// that loads fonts itself. It reads bytes from disk on behalf of that engine, so the Effect
// equivalents would only add ceremony around a single `readFile`.
/**
 * The host font provider the vendored engine asks DAK for.
 *
 * Penkra owns its fonts and answers this hook; upstream ships no font files for most of the faces it
 * declares, because its own build resolves them from npm packages. DAK is now that host. Without a
 * provider here, a render that goes through the editor rather than the screenshot path falls through
 * to `fetchBundledFont`, which imports `@open-pencil/core` — a package nothing depends on — and the
 * design fails with `ERR_MODULE_NOT_FOUND` aimed at nobody.
 *
 * Two maps exist and they disagree, which is why this file carries its own rather than reading one.
 * `document-screenshot.mjs` declares 11 faces including JetBrains Mono and the Material Symbols
 * families; the engine's private `BUNDLED_FONTS` declares 7, adding Noto Naskh Arabic and omitting
 * all four of those. The engine's is module-private with no accessor, so there is nothing to read.
 * Covering only one map means a face works in the screenshot path and fails in the editor path —
 * which is exactly the split that let a missing face go unnoticed.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { fontManager } from "@dak/canvas-engine/upstream/vendor/open-pencil/engine.source.mjs";
import ownedManifestJson from "../../../../packages/canvas-engine/fonts/manifest.json" with { type: "json" };

/**
 * Every face either map names, keyed `"Family|Style"`.
 *
 * Kept explicit rather than derived so a reviewer can see the union at a glance, and so the coverage
 * check has one list to reconcile against. `scripts/canvas-font-coverage.ts` fails the build if a
 * face here is neither shipped nor declared excluded.
 */
export const CANVAS_HOST_FONT_FILES: Readonly<Record<string, string>> = {
  // From `document-screenshot.mjs`, and shared with the engine's own map.
  "Inter|Regular": "Inter-Regular.ttf",
  "Inter|Medium": "Inter-Medium.ttf",
  "Inter|SemiBold": "Inter-SemiBold.ttf",
  "Inter|Bold": "Inter-Bold.ttf",
  "Inter|ExtraBold": "Inter-ExtraBold.ttf",
  // Only in `document-screenshot.mjs`. DAK ships these as the official TTF rather than the woff2 the
  // map names, because bytes reach CanvasKit uncompressed and it accepts TTF and OTF only.
  "JetBrains Mono|Regular": "jetbrains-mono-400.woff2",
  "JetBrains Mono|Medium": "jetbrains-mono-500.woff2",
  // DAK-owned display faces. None of the engine maps names these; they resolve through the host
  // loader below (editor path) and the startup preload (screenshot/measure path), never through a
  // vendored map edit. The pinned tree is not touched.
  "Playfair Display|Regular": "playfair-display-400.ttf",
  "Playfair Display|Bold": "playfair-display-700.ttf",
  "Space Grotesk|Regular": "space-grotesk-400.ttf",
  "Space Grotesk|Medium": "space-grotesk-500.ttf",
  "Space Grotesk|Bold": "space-grotesk-700.ttf",
  "Anton|Regular": "anton-400.ttf",
  // Icon families. They reach a document only as `type: "icon"` nodes resolved from `icon-chunks`, so
  // these are listed for completeness and answered with null unless a document ever asks for one as
  // text. Shipping the variable fonts for that would add megabytes for an unreachable path.
  "Material Symbols Outlined|Regular": "material-symbols-outlined.woff2",
  "Material Symbols Rounded|Regular": "material-symbols-rounded.woff2",
  "Material Symbols Sharp|Regular": "material-symbols-sharp.woff2",
  "Noto Color Emoji|Regular": "NotoColorEmoji.ttf",
  // Only in the engine's own map. Not vendored: a design that needs it should report `unknown_font`
  // rather than silently substituting another script.
  "Noto Naskh Arabic|Regular": "NotoNaskhArabic-Regular.ttf",
};

/**
 * Engine filenames mapped to the files DAK actually ships.
 *
 * Only ever maps onto a real TTF: a renamed woff2 would reach CanvasKit undecompressed and fail at
 * render time rather than here, which is the failure this whole exercise exists to remove.
 */
export const CANVAS_FONT_FILE_ALIASES: Readonly<Record<string, string>> = {
  "jetbrains-mono-400.woff2": "jetbrains-mono-400.ttf",
  "jetbrains-mono-500.woff2": "jetbrains-mono-500.ttf",
};

export interface CanvasHostFontsOptions {
  /** Absolute paths to search, in priority order. */
  readonly directories: ReadonlyArray<string>;
  /** Overrides the alias table, for tests. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Overrides the face table, for tests. */
  readonly files?: Readonly<Record<string, string>>;
}

/** `fontManager` is a module singleton, so one registration is enough per process. */
let registered = false;

/**
 * Resolves one face to its bytes, or null when DAK does not ship it.
 *
 * Null rather than throw: a deliberately excluded face (the 10.5 MB emoji font, the icon families,
 * Naskh Arabic) is an expected answer, and the engine treats null as "ask the next source". Throwing
 * would turn an intentional gap into a failed render.
 */
export const readCanvasFace = async (
  family: string,
  style: string,
  options: CanvasHostFontsOptions,
): Promise<ArrayBuffer | null> => {
  const files = options.files ?? CANVAS_HOST_FONT_FILES;
  const aliases = options.aliases ?? CANVAS_FONT_FILE_ALIASES;
  const requested = files[`${family}|${style}`];
  // A face neither map names cannot be resolved by guessing: reading an unrelated file that happens
  // to match would put the wrong glyphs on the design.
  if (requested === undefined) return null;
  const shipped = aliases[requested] ?? requested;
  for (const directory of options.directories) {
    try {
      const bytes = await NodeFSP.readFile(NodePath.join(directory, shipped));
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    } catch (error) {
      // ENOENT is the normal case for the first directories tried; anything else is worth surfacing.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
};

/**
 * Registers the provider with the vendored engine.
 *
 * Idempotent, because a second registration would leave the first closure alive for the life of the
 * process and make it impossible for a test to substitute directories afterwards.
 */
export const registerCanvasHostFonts = (options: CanvasHostFontsOptions): void => {
  if (registered) return;
  const manager = fontManager as unknown as {
    setHostFontLoader: (
      loader: (family: string, style: string) => Promise<ArrayBuffer | null>,
    ) => void;
  };
  manager.setHostFontLoader((family, style) => readCanvasFace(family, style, options));
  registered = true;
};

/**
 * One shipped text face, as recorded in `packages/canvas-engine/fonts/manifest.json`.
 *
 * That file is the only hand-maintained list of shipped families: the `dak_canvas_edit`
 * description is generated from it, the startup preload reads it, and the parity test fails when
 * it and `CANVAS_HOST_FONT_FILES` disagree. `location` says where the bytes live — Inter is
 * pinned snapshot bytes owned by `vendor-manifest.json`, everything else sits beside the manifest.
 */
export interface ShippedFontFace {
  readonly file: string;
  readonly family: string;
  readonly style: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly location: "owned" | "upstream-vendor";
}

const isShippedFontFace = (value: unknown): value is ShippedFontFace => {
  if (typeof value !== "object" || value === null) return false;
  const face = value as Record<string, unknown>;
  return (
    typeof face["file"] === "string" &&
    typeof face["family"] === "string" &&
    typeof face["style"] === "string" &&
    typeof face["sha256"] === "string" &&
    typeof face["bytes"] === "number" &&
    (face["location"] === undefined ||
      face["location"] === "owned" ||
      face["location"] === "upstream-vendor")
  );
};

/** Every face DAK ships, throwing rather than returning a half-decoded list. */
export const shippedFontFaces = (): ReadonlyArray<ShippedFontFace> => {
  const fonts = (ownedManifestJson as { fonts?: unknown }).fonts;
  if (!Array.isArray(fonts) || !fonts.every(isShippedFontFace)) {
    throw new Error(
      "packages/canvas-engine/fonts/manifest.json is malformed. It is the shipped-font record " +
        "the tool description and the font preload read; fix it rather than working around it.",
    );
  }
  return fonts.map((face) => ({
    ...face,
    location: (face.location ?? "owned") as "owned" | "upstream-vendor",
  }));
};

/**
 * The shipped families for the `dak_canvas_edit` description, generated from the manifest.
 *
 * Generated rather than written out so the description cannot drift from what is actually
 * shipped: adding a family to the manifest changes the tool text with no second edit.
 */
export const shippedFontDescription = (): string => {
  const groups: Array<string> = [];
  for (const face of [...shippedFontFaces()].sort((left, right) =>
    left.family.localeCompare(right.family),
  )) {
    if (!groups.includes(face.family)) groups.push(face.family);
  }
  return groups
    .map(
      (family) =>
        `${family} (${shippedFontFaces()
          .filter((face) => face.family === family)
          .map((face) => face.style)
          .join(", ")})`,
    )
    .join(", ");
};

interface FontManagerPreload {
  isStyleLoaded: (family: string, style: string) => boolean;
  markLoaded: (family: string, style: string, data: ArrayBuffer) => void;
}

let preloadPromise: Promise<void> | undefined;

/**
 * Loads every shipped face into the engine's font cache before anything measures.
 *
 * The editor path resolves new families through `registerCanvasHostFonts` alone — the host
 * loader is consulted before the engine's private map, so a family outside that map needs no
 * vendored edit. The screenshot/measure path cannot use that answer: `document-screenshot.mjs`
 * installs its own loader over ours, keyed by its own pinned map, which names neither the new
 * families nor the DAK-owned directory. Rather than editing the pinned tree, the shipped bytes
 * are registered here with `markLoaded`, which `loadFont` consults before any loader, remote
 * provider, or bundled fallback runs. Without this, a new family would be fetched from Google
 * Fonts at measure time when online and fail offline — the same font by name, but neither
 * DAK's bytes nor DAK's budget.
 *
 * Idempotent per process and skips faces already loaded, so repeated engine construction in
 * tests does not churn the font generation. A missing or unreadable shipped face rejects, which
 * surfaces through `canvasFontsReady` on the next measure rather than limping on fallbacks.
 */
export const preloadCanvasHostFonts = (directories: ReadonlyArray<string>): Promise<void> => {
  preloadPromise ??= (async () => {
    const manager = fontManager as unknown as FontManagerPreload;
    for (const face of shippedFontFaces()) {
      if (manager.isStyleLoaded(face.family, face.style)) continue;
      let found: string | undefined;
      for (const directory of directories) {
        const candidate = NodePath.join(directory, face.file);
        try {
          await NodeFSP.access(candidate);
          found = candidate;
          break;
        } catch {
          continue;
        }
      }
      if (found === undefined) {
        throw new Error(
          `Shipped font ${face.family} (${face.style}) has no ${face.file} in any font ` +
            `directory. It is listed in the manifest and the tool description promises it; ` +
            `vendor the file rather than shipping the promise.`,
        );
      }
      const bytes = await NodeFSP.readFile(found);
      manager.markLoaded(
        face.family,
        face.style,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
    }
  })();
  // Marks the rejection handled so an engine that never measures does not trip the
  // unhandled-rejection detector; awaiting `canvasFontsReady` still throws it.
  preloadPromise.catch(() => undefined);
  return preloadPromise;
};

/** Resolves once every shipped face is in the engine's font cache. */
export const canvasFontsReady = (): Promise<void> => preloadPromise ?? Promise.resolve();

/** Test-only: forget preloaded faces so the next call loads fresh bytes. */
