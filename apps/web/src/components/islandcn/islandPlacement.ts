import { islandMetrics } from "~/lib/island";

/**
 * Where the resting island sits in the title bar. It lives on the bar's centre line, in the
 * horizontal gap the header leaves free, so it never covers the thread title, the panel buttons
 * or the window controls, and never lands on the chat below.
 *
 * Everything here is arithmetic on measured spans (`useIslandTopbarSlot` measures them), so the
 * rules can be tested without a browser.
 */

/** A horizontal stretch of the window, in CSS px. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The widest the resting island gets: a compact pill with both sides filled. Reserving this, not
 * the current width, keeps the island from sliding sideways when an activity makes it grow.
 */
export const ISLAND_SLOT_WIDTH = islandMetrics.compact.maxWidth;

/** Clear space kept between the island and anything beside it. */
export const ISLAND_SLOT_MARGIN = 12;

/** The island's resting height, which the title bar's centre line is measured against. */
export const ISLAND_PILL_HEIGHT = islandMetrics.idle.height;

/** Sorts spans, grows each by `pad` on both sides and joins the ones that touch. */
export function mergeSpans(spans: readonly Span[], pad = 0): Span[] {
  const sorted = spans
    .filter(
      (span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start,
    )
    .map((span) => ({ start: span.start - pad, end: span.end + pad }))
    .toSorted((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export interface IslandSlot {
  /** How far to move the island from the window's centre, in px. Negative is left. */
  readonly offsetX: number;
  /** False when no gap in the bar is wide enough for the resting island. */
  readonly fits: boolean;
}

/**
 * The spot nearest the window's centre where the resting island fits between `occupied` spans.
 *
 * Centred when the middle is free, which is the usual case on a wide window. Otherwise it slides
 * the shortest distance into a free gap, and when no gap is wide enough it reports `fits: false`
 * so the caller can keep the resting pill out of the way instead of drawing it over something.
 */
export function chooseIslandSlot(input: {
  readonly viewportWidth: number;
  readonly occupied: readonly Span[];
  readonly islandWidth?: number;
  readonly margin?: number;
}): IslandSlot {
  const islandWidth = input.islandWidth ?? ISLAND_SLOT_WIDTH;
  const margin = input.margin ?? ISLAND_SLOT_MARGIN;
  const ideal = input.viewportWidth / 2;

  const blocked = mergeSpans(input.occupied, margin);
  const gaps: Span[] = [];
  let cursor = 0;
  for (const span of blocked) {
    if (span.start > cursor)
      gaps.push({ start: cursor, end: Math.min(span.start, input.viewportWidth) });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < input.viewportWidth) gaps.push({ start: cursor, end: input.viewportWidth });

  let best: { center: number; distance: number } | null = null;
  for (const gap of gaps) {
    if (gap.end - gap.start < islandWidth) continue;
    const center = Math.min(
      Math.max(ideal, gap.start + islandWidth / 2),
      gap.end - islandWidth / 2,
    );
    const distance = Math.abs(center - ideal);
    if (best === null || distance < best.distance) best = { center, distance };
  }
  return best === null ? { offsetX: 0, fits: false } : { offsetX: best.center - ideal, fits: true };
}

/**
 * The island's `top` that centres its resting pill on a title bar of `barHeight`, to the half
 * pixel of what is drawn. The island is drawn at `scale` about its top edge (`ISLAND_UI_SCALE`),
 * so the pill is `pillHeight * scale` tall on screen and `top` is given in the island's own,
 * unscaled units. A bar shorter than the pill pins it to the window's top edge.
 */
export function islandTopForBar(
  barHeight: number,
  scale = 1,
  pillHeight = ISLAND_PILL_HEIGHT,
): number {
  const drawnTop = Math.max(0, Math.round(barHeight - pillHeight * scale)) / 2;
  return drawnTop / scale;
}

/**
 * Which stretches of the bar are drawn on, found by asking `occupiedAt(x, y)` along rows through
 * the bar (a header's content sits on its centre line, so a couple of rows near it are enough).
 * Cells that touch are joined; the caller pads them.
 */
export function sampleOccupied(input: {
  readonly viewportWidth: number;
  readonly barHeight: number;
  readonly occupiedAt: (x: number, y: number) => boolean;
  readonly step?: number;
  readonly rows?: readonly number[];
}): Span[] {
  const step = input.step ?? 10;
  const rows = input.rows ?? [0.4, 0.62];
  const cells: Span[] = [];
  for (let x = step / 2; x < input.viewportWidth; x += step) {
    if (rows.some((row) => input.occupiedAt(x, input.barHeight * row))) {
      cells.push({ start: x - step / 2, end: x + step / 2 });
    }
  }
  return mergeSpans(cells);
}
