// @effect-diagnostics nodeBuiltinImport:off - The normalization reads the vendored engine and the
// vendored font manifest off disk, both of which only exist as real paths.
// @effect-diagnostics globalDate:off - Cache entries are keyed by content, not by wall clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  DEFAULT_MISSING_FONT_POLICY,
  loadedFamilies,
  measureTextNodes,
  textNodeIds,
  unavailableFontsByFamily,
  withMeasuredWrap,
  type MissingFontPolicy,
} from "./canvasText.ts";
import { withImplicitAbsoluteLayout } from "./canvasInvariants.ts";

/**
 * The one place a document is made renderable.
 *
 * Panel, screenshot, export, tiles, inspect and the future geometry index all call this and nothing
 * else. That is the whole point: a second path is how the panel ends up showing a design that an
 * export disagrees with, which is the exact failure that made the layout default and the text
 * default two separate incidents in the first place.
 *
 * Two defaults are applied, both of which read silence as the safe answer and honour an explicit
 * value as written:
 *
 * - A frame with no `layout` whose children carry their own coordinates is placed absolutely, because
 *   that is what the author wrote. An explicit `layout` is never overridden.
 * - Text that declares a width and says nothing about `textGrowth` wraps at that width, with a height
 *   the engine's own shaper measures. An explicit `textGrowth` — including `"auto"`, which really is
 *   a decision to not wrap — and an explicit height are left exactly as the author left them.
 *
 * ## Why the height is not committed
 *
 * An earlier version wrote the measured height into the stored document on every edit. That made the
 * readers agree by construction, and it also meant 78 silent text nodes each landing as their own
 * mutation: the sequence advanced by dozens, the update log filled with noise nobody authored, and a
 * user's undo and a history scrub both became useless. So the height is derived at the render
 * boundary instead, and the agreement it costs is bought back with the cache below.
 *
 * ## What this means for dirty-rect invalidation
 *
 * A rect computed from the *stored* document is wrong, because normalization changes geometry: a
 * wrapped text node is taller than the author wrote, and in an auto-layout parent that height shifts
 * every sibling below it. Any future incremental invalidation must diff normalized-before against
 * normalized-after. An edit that touches only `name` or `role` produces no normalized diff at all and
 * so invalidates nothing.
 */
export const NORMALIZE_VERSION = 3;

/**
 * Bumped whenever normalization changes shape, so a cached document from an older rule is never
 * reused. Part of the cache key rather than a stored field, because nothing should be able to
 * invalidate another environment's cache.
 */
/**
 * Makes a document renderable.
 *
 * `policy` decides what happens to a family DAK does not ship. The edit path passes `throw` and the
 * viewer passes `substitute`; both are right for their caller, and they differ because only the
 * editor can act on the answer. A viewer that refused to draw would lose the whole design over one
 * headline the user cannot fix.
 */
export const normalizeForRender = async (
  document: unknown,
  policy: MissingFontPolicy = DEFAULT_MISSING_FONT_POLICY,
): Promise<unknown> => withMeasuredWrap(withImplicitAbsoluteLayout(document), policy);

/**
 * Where a shipped face is read from, in the order it is searched.
 *
 * There are two layouts and they do not share a directory. A dev run has this module at
 * `apps/server/src/canvas`, with the vendored snapshot and the DAK-owned faces four levels up. A
 * bundled run has it as a chunk in the server's `dist`, where nothing under `packages/` ships at
 * all: `scripts/place-canvas-assets.ts` stages every face flat beside the chunk instead. The
 * module's own directory is searched first for that reason, and the repo-relative directories are
 * the fallbacks a dev run needs — the same search `CanvasEngineLive` registers with the engine, so
 * the faces measured here are the faces drawn there.
 *
 * Reading only one layout is the failure this list exists to prevent: a path four levels up from
 * the source tree is outside the repository in the bundle, and a render that read it threw `ENOENT`
 * on every packaged and desktop build while `vp run dev` rendered the same design happily.
 */
export const canvasFontDirectories = (
  moduleUrl: string | URL = import.meta.url,
): ReadonlyArray<string> => {
  const moduleDir = NodePath.dirname(NodeURL.fileURLToPath(moduleUrl));
  return [
    moduleDir,
    NodePath.resolve(
      moduleDir,
      "../../../../packages/canvas-engine/upstream/vendor/open-pencil/fonts",
    ),
    NodePath.resolve(moduleDir, "../../../../packages/canvas-engine/fonts"),
  ];
};

/**
 * The hash those directories produce.
 *
 * Takes the directories rather than reading `import.meta.url` itself so the packaged layout can be
 * exercised directly: a test that can only ever run in the source tree is the test that would have
 * passed while every bundled server failed.
 */
export const fontSetVersionFrom = (directories: ReadonlyArray<string>): string => {
  const hash = NodeCrypto.createHash("sha256");
  for (const directory of directories) {
    let files: ReadonlyArray<string>;
    try {
      files = NodeFS.readdirSync(directory).sort();
    } catch {
      // A directory that is not there is a layout this process is not running in — a bundle has no
      // `packages/` tree, and the source tree has no faces beside the module. Skipping is what lets
      // one rule cover both instead of a path that is only ever right in one of them.
      continue;
    }
    for (const file of files) {
      if (!/\.(ttf|otf|woff2)$/iu.test(file)) continue;
      hash.update(file);
      hash.update(NodeFS.readFileSync(NodePath.join(directory, file)));
    }
  }
  return hash.digest("hex").slice(0, 16);
};

/**
 * A hash of every shipped font file, so a font change invalidates every cached measurement.
 *
 * Measuring with a different face than the renderer will draw with produces exactly the kind of
 * disagreement this module exists to prevent: a height that is right for the cache and wrong on
 * screen.
 */
let cachedFontSetVersion: string | undefined;
export const fontSetVersion = (): string => {
  cachedFontSetVersion ??= fontSetVersionFrom(canvasFontDirectories());
  return cachedFontSetVersion;
};

interface CacheEntry {
  readonly document: unknown;
  readonly measured: ReadonlyMap<string, unknown>;
  /**
   * Families the document asked for that DAK does not ship, with the node that asked.
   *
   * Carried on the cache entry because the substitution has already happened by the time anything
   * can ask: the normalized document no longer names the missing family, so this is the only place
   * the fact survives. Inspect reads it to report `font_unavailable` instead of the viewer quietly
   * showing a substituted face as though it were what the author chose.
   */
  readonly missingFontFamilies: ReadonlyArray<{ family: string; nodeIds: ReadonlyArray<string> }>;
}

const cache = new Map<string, CacheEntry>();

/** Bounded so a long-lived server cannot accumulate documents forever. */
const NORMALIZE_CACHE_LIMIT = 32;

/**
 * The cache key, derived from the content rather than passed in.
 *
 * The payload already *is* the identity: the snapshot state is the document as of its compaction,
 * and the update log's sequences say how far past that it has moved. Two reads of the same document
 * at the same sequence hash the same; any edit changes a sequence and so changes the key. That means
 * no reader has to thread a document id and a sequence through to be correct, and an execution that
 * has no identity yet still caches correctly instead of borrowing someone else's entry.
 *
 * A hash rather than the payload itself: the state is a base64 blob of tens of kilobytes and this is
 * on the render path.
 */
const normalizeCacheKey = (payload: {
  readonly snapshot: { readonly throughSequence: number; readonly state: string };
  readonly updates: ReadonlyArray<{ readonly sequence: number }>;
}): string => {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(NORMALIZE_VERSION.toString());
  hash.update(fontSetVersion());
  hash.update(payload.snapshot.throughSequence.toString());
  hash.update(payload.snapshot.state);
  for (const update of payload.updates) hash.update(`:${update.sequence}`);
  return hash.digest("hex").slice(0, 32);
};

/**
 * The normalized document, with its measurements, cached per document content.
 *
 * A render, a screenshot and an export of the same document at the same sequence all hit this once.
 * Measurement is the expensive part — the shaper runs over every text node — and without the cache a
 * panel that re-renders on every sequence bump would re-measure a page it has already measured.
 */
export const normalizedDocument = async (input: {
  readonly document: unknown;
  readonly payload: {
    readonly snapshot: { readonly throughSequence: number; readonly state: string };
    readonly updates: ReadonlyArray<{ readonly sequence: number }>;
  };
}): Promise<CacheEntry> => {
  const key = normalizeCacheKey(input.payload);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  // `substitute`, not the default: everything that reaches this cache is being drawn for a person to
  // look at. A frame set in a family DAK does not ship renders in the nearest shipped face instead of
  // failing the whole view.
  //
  // What was missing is read from the input *before* normalization, because afterwards the document no
  // longer names the bad family and the fact is gone. That is the only moment it can be observed.
  const shipped = loadedFamilies(
    await measureTextNodes(input.document, textNodeIds(input.document)),
  );
  const missingFontFamilies = unavailableFontsByFamily(input.document, shipped);
  const document = await normalizeForRender(input.document, "substitute");
  const measured = await measureTextNodes(document, textNodeIds(document));
  const entry: CacheEntry = { document, measured, missingFontFamilies };
  if (cache.size >= NORMALIZE_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, entry);
  return entry;
};
