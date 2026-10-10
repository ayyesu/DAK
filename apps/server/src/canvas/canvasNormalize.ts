// @effect-diagnostics nodeBuiltinImport:off - The normalization reads the vendored engine and the
// vendored font manifest off disk, both of which only exist as real paths.
// @effect-diagnostics globalDate:off - Cache entries are keyed by content, not by wall clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { measureTextNodes, textNodeIds, withMeasuredWrap } from "./canvasText.ts";
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
export const normalizeForRender = async (document: unknown): Promise<unknown> =>
  withMeasuredWrap(withImplicitAbsoluteLayout(document));

/**
 * A hash of every shipped font file, so a font change invalidates every cached measurement.
 *
 * Measuring with a different face than the renderer will draw with produces exactly the kind of
 * disagreement this module exists to prevent: a height that is right for the cache and wrong on
 * screen.
 */
let cachedFontSetVersion: string | undefined;
export const fontSetVersion = (): string => {
  if (cachedFontSetVersion !== undefined) return cachedFontSetVersion;
  const upstream = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../../../packages/canvas-engine/upstream/vendor/open-pencil/fonts",
  );
  const owned = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../../../packages/canvas-engine/fonts",
  );
  const hash = NodeCrypto.createHash("sha256");
  for (const directory of [upstream, owned]) {
    for (const file of NodeFS.readdirSync(directory).sort()) {
      if (!/\.(ttf|otf|woff2)$/iu.test(file)) continue;
      hash.update(file);
      hash.update(NodeFS.readFileSync(NodePath.join(directory, file)));
    }
  }
  cachedFontSetVersion = hash.digest("hex").slice(0, 16);
  return cachedFontSetVersion;
};

interface CacheEntry {
  readonly document: unknown;
  readonly measured: ReadonlyMap<string, unknown>;
}

const cache = new Map<string, CacheEntry>();

/** Bounded so a long-lived server cannot accumulate documents forever. */
export const NORMALIZE_CACHE_LIMIT = 32;

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
export const normalizeCacheKey = (payload: {
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

  const document = await normalizeForRender(input.document);
  const measured = await measureTextNodes(document, textNodeIds(document));
  const entry: CacheEntry = { document, measured };
  if (cache.size >= NORMALIZE_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, entry);
  return entry;
};

export const normalizeCacheSize = (): number => cache.size;
export const clearNormalizeCache = (): void => cache.clear();
