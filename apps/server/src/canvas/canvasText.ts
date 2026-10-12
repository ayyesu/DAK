// @effect-diagnostics nodeBuiltinImport:off - This module reads the vendored engine off disk by path,
// because measured text has to come from the same measurer the renderer draws with.
import * as NodeCrypto from "node:crypto";

import { fontManager } from "@dak/canvas-engine/upstream/vendor/open-pencil/engine.source.mjs";
import { measureDocumentText } from "@dak/canvas-engine/upstream/src/document-screenshot.mjs";

import { canvasFontsReady, shippedFontFaces } from "./CanvasHostFonts.ts";

/**
 * Measured text, from the same measurer the renderer draws with.
 *
 * The previous detector estimated a string's width as `characters x fontSize x 0.55`. On the real
 * portfolio page that flagged twelve text nodes, of which three turned out to fit on one line: the
 * estimate cannot know the font, the weight, or the glyphs. Everything here is measured instead, so
 * a node is only called broken when the engine's own shaper says it does not fit.
 *
 * `measureDocumentText` returns a `Map`, not an object. It is easy to read that as "no results" —
 * `JSON.stringify` of a `Map` is `{}` — which is exactly the mistake that made an earlier probe
 * report an empty measurement for a document with seventy-eight text nodes in it.
 */

/** One measured text node: the box the shaper produced and how it broke across lines. */
export interface MeasuredText {
  readonly width: number;
  readonly height: number;
  readonly lines: number;
  /** The height the wrapped lines actually occupy, which is what a node should be given. */
  readonly derivedHeight: number;
  readonly fontHashes: Readonly<Record<string, string>>;
}

const numberOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * The shipped faces the engine has actually loaded, as `Family|Style -> sha256`.
 *
 * The vendored measurer reports hashes only for faces in its own pinned map, so a DAK-owned
 * family would measure correctly yet be invisible to the `unknown_font` guard — measured with
 * the right glyphs, then refused as unshipped. These are the same bytes the renderer draws
 * with (the startup preload put them in the font cache), so their hashes belong alongside the
 * vendored ones rather than in a second list a caller must remember to check.
 */
const shippedFontHashes = (): Readonly<Record<string, string>> => {
  const manager = fontManager as unknown as {
    loadedData: (family: string, style: string) => ArrayBuffer | null;
  };
  const hashes: Record<string, string> = {};
  for (const face of shippedFontFaces()) {
    const bytes = manager.loadedData(face.family, face.style);
    if (bytes !== null) {
      hashes[`${face.family}|${face.style}`] = NodeCrypto.createHash("sha256")
        .update(new Uint8Array(bytes))
        .digest("hex");
    }
  }
  return hashes;
};

export const measureTextNodes = async (
  document: unknown,
  nodeIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, MeasuredText>> => {
  if (nodeIds.length === 0) return new Map();
  // Every render path funnels through here, so this is the one place that can promise the
  // shipped faces are in the font cache before the shaper runs. Against a warm engine it is a
  // resolved promise; against a fresh one it is what keeps the first measure from falling
  // through to a network fetch.
  await canvasFontsReady();
  const result = await measureDocumentText(document, nodeIds as string[], new Map());
  const layouts = result.textLayouts as unknown as Map<
    string,
    {
      width: number;
      height: number;
      lines: ReadonlyArray<{ top: number; bottom: number }>;
      fontHashes: Record<string, string>;
    }
  >;
  const measured = new Map<string, MeasuredText>();
  const shipped = shippedFontHashes();
  for (const [id, entry] of layouts) {
    const lines = entry.lines ?? [];
    const first = lines[0];
    const last = lines[lines.length - 1];
    measured.set(id, {
      width: numberOf(entry.width),
      height: numberOf(entry.height),
      lines: lines.length,
      // The shaper reports each line's ink box; the distance from the first top to the last bottom
      // is the height a wrapped node needs.
      derivedHeight: Math.max(1, Math.ceil(numberOf(last?.bottom) - numberOf(first?.top))),
      fontHashes: { ...shipped, ...entry.fontHashes },
    });
  }
  return measured;
};

interface NodeLike {
  type?: unknown;
  id?: unknown;
  textGrowth?: unknown;
  width?: unknown;
  height?: unknown;
  x?: unknown;
  y?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

const childrenOf = (node: NodeLike): ReadonlyArray<NodeLike> =>
  Array.isArray(node.children) ? (node.children as ReadonlyArray<NodeLike>) : [];

const idOf = (node: NodeLike): string | undefined =>
  typeof node.id === "string" && node.id.length > 0 ? node.id : undefined;

/** Every text node in a document, in document order. */
export const textNodeIds = (document: unknown): ReadonlyArray<string> => {
  const ids: string[] = [];
  const visit = (node: NodeLike): void => {
    if (node.type === "text") {
      const id = idOf(node);
      if (id !== undefined) ids.push(id);
    }
    for (const child of childrenOf(node)) visit(child);
  };
  for (const child of childrenOf(document as NodeLike)) visit(child);
  return ids;
};

/** The families a document asks for, which is not the same as the families that loaded. */
const requestedFamilies = (document: unknown): ReadonlyArray<string> => {
  const families = new Set<string>();
  const visit = (node: NodeLike): void => {
    if (node.type === "text" && typeof node.fontFamily === "string" && node.fontFamily.length > 0) {
      families.add(node.fontFamily);
    }
    for (const child of childrenOf(node)) visit(child);
  };
  for (const child of childrenOf(document as NodeLike)) visit(child);
  return [...families];
};

/** The families the engine actually loaded, from the hash table it reports alongside a measurement. */
export const loadedFamilies = (
  measured: ReadonlyMap<string, MeasuredText>,
): ReadonlyArray<string> => {
  const families = new Set<string>();
  for (const entry of measured.values()) {
    for (const key of Object.keys(entry.fontHashes)) families.add(key.split("|")[0] ?? key);
  }
  return [...families];
};

/**
 * Refuse to measure a document that names a face DAK does not ship.
 *
 * The engine falls back rather than failing: a document set in a face it does not have measures
 * against whatever it loaded instead, and returns a plausible height. That is the worst outcome
 * available, because the height is then used to lay the design out and nothing anywhere says the
 * design is not the one that will be drawn. A face nobody ships has to fail as `unknown_font` before
 * a measurement can be believed.
 *
 * The error names the face, lists what is available, and names the nearest match, because "unknown
 * font" on its own costs the author a round trip to find out which eleven families they could have
 * used instead.
 */
export class CanvasUnknownFontError extends Error {
  readonly code = "CANVAS_UNKNOWN_FONT";
  readonly family: string;
  readonly available: ReadonlyArray<string>;
  readonly nearest: string | undefined;
  constructor(family: string, available: ReadonlyArray<string>, nearest: string | undefined) {
    super(
      `Font ${JSON.stringify(family)} is not shipped by DAK, so this design cannot be measured or ` +
        `reliably drawn. Available families: ${available.join(", ") || "none"}.` +
        (nearest === undefined ? "" : ` Nearest match: ${JSON.stringify(nearest)}.`),
    );
    this.name = "CanvasUnknownFontError";
    this.family = family;
    this.available = available;
    this.nearest = nearest;
  }
}

/** The closest shipped family by shared prefix, longest first, so "Inter Display" finds "Inter". */
export const nearestFamily = (
  family: string,
  available: ReadonlyArray<string>,
): string | undefined => {
  const wanted = family.toLowerCase();
  let best: string | undefined;
  for (const candidate of available) {
    const lower = candidate.toLowerCase();
    if (lower === wanted) return candidate;
    // Either direction: the author may have written a longer name ("Inter Display", where the
    // shipped family is a prefix) or a shorter one ("Playfair", where the shipped family
    // completes it). The longest shipped candidate wins, so "Space" finds "Space Grotesk"
    // rather than stopping at a shorter family that also happens to prefix-match.
    if (wanted.startsWith(lower) || lower.startsWith(wanted)) {
      if (best === undefined || candidate.length > best.length) best = candidate;
    }
  }
  return best;
};

/**
 * Every family a document names, having been loaded.
 *
 * Throws on the first one that was not, so a caller never receives a measurement it should not trust.
 */
const assertFontsAvailable = (
  requested: ReadonlyArray<string>,
  loaded: ReadonlyArray<string>,
): void => {
  for (const family of requested) {
    if (loaded.includes(family)) continue;
    throw new CanvasUnknownFontError(family, loaded, nearestFamily(family, loaded));
  }
};

/**
 * Whether this node should wrap.
 *
 * Silence means wrap. A text node that declares a width has told us how wide it wants to be, and
 * growing past that width draws over its neighbours and gets sliced at the frame edge, which is how
 * a headline arrived in the middle of a word. An explicit `textGrowth` is a decision, so `auto` is
 * honoured as the no-wrap it is and the other two are honoured as written.
 */
export const shouldWrap = (node: NodeLike): boolean =>
  node.type === "text" &&
  node.textGrowth === undefined &&
  typeof node.width === "number" &&
  Number.isFinite(node.width);

/**
 * What to do about a family the engine never loaded.
 *
 * The two callers want opposite answers, and that is the whole point of the option.
 *
 * `throw` is for the edit path. An agent that sets `fontFamily: "Playfair"` deserves to be told,
 * immediately, that DAK does not ship it — silently measuring with Inter teaches it that a typo is
 * a valid design.
 *
 * `substitute` is for the render path. The user opening a design cannot fix it, and a panel that
 * refuses to draw because of one headline loses the entire design over a single text node. So the
 * family is replaced with the nearest shipped one, the frame draws in a font the user can see, and
 * inspect reports `font_unavailable` so the problem is still visible and still has an owner.
 */
export type MissingFontPolicy = "throw" | "substitute";

export const DEFAULT_MISSING_FONT_POLICY: MissingFontPolicy = "throw";

/**
 * The family to draw an unavailable one in.
 *
 * The nearest shipped match when there is one, else Inter. Not "no font at all": an unavailable
 * family should look like the nearest thing DAK has, so the user recognises the intent even while
 * the wrong face is on screen.
 */
const fallbackFamilyFor = (family: string, available: ReadonlyArray<string>): string =>
  nearestFamily(family, available) ?? "Inter";

/**
 * Rewrites every node asking for an unavailable family onto a shipped one.
 *
 * Returns the families it had to replace, so inspect can report which ones were wrong rather than
 * the viewer silently drawing something else. The nodes are matched by family, not by index, so a
 * document with one bad headline and forty good ones has only that headline replaced.
 */
export const substituteMissingFonts = (
  document: unknown,
  missing: ReadonlySet<string>,
  available: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (missing.size === 0) return [];
  const copy = document as NodeLike;
  const replaced = new Set<string>();
  const visit = (node: NodeLike): void => {
    if (
      node.type === "text" &&
      typeof node.fontFamily === "string" &&
      missing.has(node.fontFamily)
    ) {
      replaced.add(node.fontFamily);
      node.fontFamily = fallbackFamilyFor(node.fontFamily, available);
    }
    for (const child of childrenOf(node)) visit(child);
  };
  for (const child of childrenOf(copy)) visit(child);
  return [...replaced];
};

/** The families a document names that the engine never loaded. */
const unavailableFamilies = (
  document: unknown,
  loaded: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  requestedFamilies(document).filter((family) => !loaded.includes(family));

/**
 * The same, with the nodes that asked for each one.
 *
 * Grouped by family because that is how the problem is fixed — one edit renames every node in a
 * family — and reported per node because the author needs to know which text they are looking at.
 */
export const unavailableFontsByFamily = (
  document: unknown,
  loaded: ReadonlyArray<string>,
): ReadonlyArray<{ family: string; nodeIds: ReadonlyArray<string> }> => {
  const shipped = new Set(loaded);
  const grouped = new Map<string, Array<string>>();
  const visit = (node: NodeLike): void => {
    if (
      node.type === "text" &&
      typeof node.fontFamily === "string" &&
      !shipped.has(node.fontFamily)
    ) {
      const family = node.fontFamily;
      const ids = grouped.get(family) ?? [];
      const id = idOf(node);
      if (id !== undefined) ids.push(id);
      grouped.set(family, ids);
    }
    for (const child of childrenOf(node)) visit(child);
  };
  for (const child of childrenOf(document as NodeLike)) visit(child);
  return [...grouped].map(([family, nodeIds]) => ({ family, nodeIds }));
};

/**
 * A document whose silent text wraps, with the height each wrapped node actually needs.
 *
 * The height is measured, never guessed: the shaper lays the node out at its declared width and
 * reports how tall the result is. That matters because a height is not optional in the engine — with
 * growth fixed and no height there is nowhere to put the wrapped lines, and the text stays on one
 * line and overflows exactly as before.
 */
export const withMeasuredWrap = async (
  document: unknown,
  policy: MissingFontPolicy = DEFAULT_MISSING_FONT_POLICY,
): Promise<unknown> => {
  const copy = JSON.parse(JSON.stringify(document)) as NodeLike;
  const ids = textNodeIds(copy).filter((id) => {
    const node = findNode(copy, id);
    return node !== undefined && shouldWrap(node);
  });
  if (ids.length === 0) return copy;

  // Growth first, so the shaper breaks the lines the render will draw.
  for (const id of ids) {
    const node = findNode(copy, id);
    if (node !== undefined) node.textGrowth = "fixed-width-height";
  }
  let measured = await measureTextNodes(copy, ids);
  const loaded = loadedFamilies(measured);

  if (policy === "substitute") {
    const missing = new Set(unavailableFamilies(copy, loaded));
    if (missing.size > 0) {
      substituteMissingFonts(copy, missing, loaded);
      // Re-measured, because the substituted family has its own metrics. A height carried over from
      // the fallback would clip exactly the text the substitution was meant to rescue.
      measured = await measureTextNodes(copy, ids);
    }
  }

  // Before any measured height is written anywhere: a fallback face produces a plausible number that
  // nothing would ever contradict.
  assertFontsAvailable(requestedFamilies(copy), loadedFamilies(measured));
  for (const id of ids) {
    const entry = measured.get(id);
    const node = findNode(copy, id);
    if (entry !== undefined && node !== undefined) node.height = entry.derivedHeight;
  }
  return copy;
};

const findNode = (root: NodeLike, id: string): NodeLike | undefined => {
  if (idOf(root) === id) return root;
  for (const child of childrenOf(root)) {
    const found = findNode(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** A node's box in its own coordinate space, when it has one. */
const nodeBox = (
  node: NodeLike,
  measured?: MeasuredText,
): { x: number; y: number; width: number; height: number } | undefined => {
  const width = typeof node.width === "number" ? node.width : measured?.width;
  const height = typeof node.height === "number" ? node.height : measured?.derivedHeight;
  if (width === undefined || height === undefined) return undefined;
  return {
    x: typeof node.x === "number" ? node.x : 0,
    y: typeof node.y === "number" ? node.y : 0,
    width,
    height,
  };
};

/**
 * Every node's box in document coordinates, with each parent's offset added in.
 *
 * Text overlap only means anything in one space: a label placed at 0,0 inside a card at 16,116 sits
 * over that card, not over the page's origin.
 */
export const absoluteBoxes = (
  document: unknown,
  measured?: ReadonlyMap<string, MeasuredText>,
): ReadonlyMap<string, { x: number; y: number; width: number; height: number }> => {
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const visit = (node: NodeLike, offsetX: number, offsetY: number): void => {
    const id = idOf(node);
    const x = offsetX + (typeof node.x === "number" ? node.x : 0);
    const y = offsetY + (typeof node.y === "number" ? node.y : 0);
    const box = nodeBox(node, id === undefined ? undefined : measured?.get(id));
    if (id !== undefined && box !== undefined) boxes.set(id, { ...box, x, y });
    for (const child of childrenOf(node)) visit(child, x, y);
  };
  for (const child of childrenOf(document as NodeLike)) visit(child, 0, 0);
  return boxes;
};

const overlaps = (
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height;

/**
 * Shapes that look like a button and contain no label.
 *
 * A filled rounded rectangle is how a button is drawn, and drawing it without putting a text node on
 * top of it produces a dark blob the user cannot read and the agent cannot explain. The real
 * navigation CTA was exactly this: a 44x36 pill with no children at all.
 *
 * Only nodes wide enough to be a control are considered, so a background panel that happens to be
 * empty is not reported as a button.
 */
export const findEmptyButtonShapes = (
  document: unknown,
  boxes: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
): ReadonlyArray<{ id: string; width: number; height: number }> => {
  const textBoxes = [...boxes.entries()].filter(
    ([id]) => findNode(document as NodeLike, id)?.type === "text",
  );
  const empty: Array<{ id: string; width: number; height: number }> = [];
  const visit = (node: NodeLike): void => {
    const id = idOf(node);
    const width = typeof node.width === "number" ? node.width : 0;
    const height = typeof node.height === "number" ? node.height : 0;
    // A control is roughly as tall as it is wide and big enough to read. A progress track is 8px
    // tall and 196px wide, which the width rule alone would have reported as a button with no
    // label; the height floor is what separates the two.
    const isControl =
      id !== undefined &&
      node.fill !== undefined &&
      (node.type === "rectangle" || node.type === "ellipse") &&
      width > 0 &&
      width <= 200 &&
      height >= 24;
    if (isControl) {
      const box = boxes.get(id);
      if (box !== undefined && !textBoxes.some(([, text]) => overlaps(text, box))) {
        empty.push({ id, width, height: box.height });
      }
    }
    for (const child of childrenOf(node)) visit(child);
  };
  for (const child of childrenOf(document as NodeLike)) visit(child);
  return empty;
};
