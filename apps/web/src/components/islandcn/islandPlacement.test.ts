import { describe, expect, it } from "vite-plus/test";

import {
  ISLAND_PILL_HEIGHT,
  ISLAND_SLOT_WIDTH,
  chooseIslandSlot,
  islandTopForBar,
  mergeSpans,
  sampleOccupied,
} from "./islandPlacement";

describe("chooseIslandSlot", () => {
  it("stays centred when the middle of the bar is free", () => {
    // The workspace in the bug report: a 1905 px window, the thread title ending at 762 and the
    // panel and window controls starting at 1665. The old fixed top put the pill on the chat.
    expect(
      chooseIslandSlot({
        viewportWidth: 1905,
        occupied: [
          { start: 312, end: 762 },
          { start: 1665, end: 1905 },
        ],
      }),
    ).toEqual({ offsetX: 0, fits: true });
  });

  it("slides into the free gap when the title reaches the middle", () => {
    const slot = chooseIslandSlot({
      viewportWidth: 1500,
      occupied: [
        { start: 300, end: 900 },
        { start: 1250, end: 1500 },
      ],
    });
    expect(slot.fits).toBe(true);
    // Free gap 912 to 1238 (the margin is kept on both sides); the island sits against its left edge.
    const centre = 1500 / 2 + slot.offsetX;
    expect(centre - ISLAND_SLOT_WIDTH / 2).toBeCloseTo(912, 5);
  });

  it("slides left of the title when that is the nearer gap", () => {
    const slot = chooseIslandSlot({
      viewportWidth: 1400,
      occupied: [{ start: 660, end: 1400 }],
    });
    expect(slot.fits).toBe(true);
    expect(slot.offsetX).toBeLessThan(0);
    const right = 1400 / 2 + slot.offsetX + ISLAND_SLOT_WIDTH / 2;
    expect(right).toBeLessThanOrEqual(660 - 12 + 1e-6);
  });

  it("reports no room when every gap is narrower than the island", () => {
    expect(
      chooseIslandSlot({
        viewportWidth: 1100,
        occupied: [
          { start: 0, end: 800 },
          { start: 940, end: 1100 },
        ],
      }),
    ).toEqual({ offsetX: 0, fits: false });
  });

  it("never places the island over anything it was told about", () => {
    const occupied = [
      { start: 100, end: 500 },
      { start: 650, end: 900 },
      { start: 1300, end: 1600 },
    ];
    const slot = chooseIslandSlot({ viewportWidth: 1600, occupied });
    expect(slot.fits).toBe(true);
    const left = 1600 / 2 + slot.offsetX - ISLAND_SLOT_WIDTH / 2;
    const right = left + ISLAND_SLOT_WIDTH;
    for (const span of occupied) {
      expect(right <= span.start || left >= span.end).toBe(true);
    }
  });
});

describe("islandTopForBar", () => {
  it("centres the resting pill on the bar", () => {
    expect(islandTopForBar(52)).toBe(7.5);
    expect(islandTopForBar(40)).toBe(1.5);
  });

  it("pins the pill to the window's top edge on a bar shorter than it", () => {
    expect(islandTopForBar(30)).toBe(0);
  });

  it("centres the pill as drawn when the island is scaled down", () => {
    // `top` is in the island's unscaled units and the island is drawn at `scale` about its top, so
    // the pill's drawn top is `top * scale`. At 0.82 the pill is 30 px tall: 5 px clear above and
    // below on the 40 px bar the Windows build has.
    for (const bar of [40, 52]) {
      const top = islandTopForBar(bar, 0.82);
      const drawnTop = top * 0.82;
      const drawnBottom = drawnTop + ISLAND_PILL_HEIGHT * 0.82;
      expect(drawnTop).toBeGreaterThan(0);
      expect(Math.abs(drawnTop - (bar - drawnBottom))).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("sampleOccupied", () => {
  it("returns the stretches that something is drawn on", () => {
    const drawn = (x: number) => (x > 300 && x < 700) || x > 1600;
    const spans = sampleOccupied({
      viewportWidth: 1900,
      barHeight: 40,
      occupiedAt: (x) => drawn(x),
    });
    expect(spans).toHaveLength(2);
    expect(spans[0]!.start).toBeLessThanOrEqual(305);
    expect(spans[0]!.end).toBeGreaterThanOrEqual(695);
    expect(spans[1]!.end).toBeGreaterThanOrEqual(1900);
  });

  it("looks at more than one row, so content off the exact centre line still counts", () => {
    const rowsSeen = new Set<number>();
    sampleOccupied({
      viewportWidth: 100,
      barHeight: 50,
      occupiedAt: (_x, y) => {
        rowsSeen.add(y);
        return false;
      },
    });
    expect(rowsSeen.size).toBeGreaterThan(1);
  });
});

describe("mergeSpans", () => {
  it("pads and joins spans that end up touching", () => {
    expect(
      mergeSpans(
        [
          { start: 10, end: 20 },
          { start: 30, end: 40 },
          { start: 100, end: 110 },
        ],
        6,
      ),
    ).toEqual([
      { start: 4, end: 46 },
      { start: 94, end: 116 },
    ]);
  });
});
