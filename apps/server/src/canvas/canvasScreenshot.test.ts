import { describe, expect, it } from "vite-plus/test";

import {
  CANVAS_SCREENSHOT_MAX_EDGE,
  CANVAS_SCREENSHOT_MAX_SECTIONS,
  CANVAS_SCREENSHOT_MAX_UPSCALE,
  CANVAS_SCREENSHOT_MAX_WHOLE_FRAME_UPSCALE,
  CANVAS_SCREENSHOT_TARGET_WIDTH,
  CANVAS_SCREENSHOT_SLICE_OVERLAP,
  planScreenshot,
  planSections,
} from "./canvasScreenshot.ts";
import { isPng } from "./bytes.ts";

/**
 * How a screenshot is cut up.
 *
 * The decision that matters is not the maths, it is that a long page never comes back as one
 * stretched image. That is the bug that made a 390x5250 page arrive a couple of hundred pixels wide
 * and unreadable, and these tests exist so it cannot come back quietly.
 */

const box = (width: number, height: number) => ({ x: 0, y: 0, width, height });

describe("screenshot planning", () => {
  it("keeps a design that already fits as a single image", () => {
    // 390 wide at the whole-frame cap is 780 wide and 600 tall, both inside the limit.
    const plan = planScreenshot(box(390, 300));
    expect(plan.tall).toBe(false);
    expect(planSections(box(390, 300), plan.scale, [])).toHaveLength(1);
  });

  it("never shrinks a design to fit, because that is what made it unreadable", () => {
    // The bug being guarded: a 390x5250 page fitted to a 1568 long edge is 117px wide.
    const plan = planScreenshot(box(390, 5250));
    expect(plan.scale).toBeGreaterThan(1);
    // A whole frame is held to the lower cap, so this is 780 rather than 1560. Still far from 117.
    expect(390 * plan.scale).toBeGreaterThan(700);
    expect(plan.tall).toBe(true);
  });

  it("gives a whole frame less scale than a crop, because its slice count depends on it", () => {
    // The whole-frame cap exists for one reason: at 4x a 390px page is 1560 wide, which leaves a
    // 392px slice and turns a 6000px page into sixteen of them. At 2x the slice is 784px and the
    // page is about eight. A targeted crop still gets the full budget.
    const whole = planScreenshot(box(390, 5250)).scale;
    const crop = planScreenshot(box(390, 5250), { targeted: true }).scale;
    expect(whole).toBe(CANVAS_SCREENSHOT_MAX_WHOLE_FRAME_UPSCALE);
    expect(crop).toBe(CANVAS_SCREENSHOT_MAX_UPSCALE);
    expect(whole).toBeLessThan(crop);
  });

  it("keeps a 6000px phone page to about one page of sections", () => {
    // The planner's whole job: a phone-sized landing page should not need a dozen calls to review.
    // Before the whole-frame cap this was twenty parts; now it is nine, which is two paged calls.
    const target = box(390, 6000);
    const plan = planScreenshot(target);
    const sections = planSections(target, plan.scale, []);
    const pages = Math.ceil(sections.length / CANVAS_SCREENSHOT_MAX_SECTIONS);
    expect(sections.length).toBeLessThanOrEqual(CANVAS_SCREENSHOT_MAX_SECTIONS * 2);
    expect(pages).toBeLessThanOrEqual(2);
    // Each slice is still within the long edge, so nothing is rendered oversized.
    for (const section of sections) {
      expect(section.height * plan.scale).toBeLessThanOrEqual(CANVAS_SCREENSHOT_MAX_EDGE + 1);
    }
  });

  it("enlarges a small frame to the width text is read at, and no further", () => {
    // Targeted, so the full 4x budget applies: nothing else is competing for the pixels.
    expect(planScreenshot(box(390, 800), { targeted: true }).scale).toBeCloseTo(4, 5);
    expect(planScreenshot(box(3900, 800), { targeted: true }).scale).toBe(1);
    // The whole-frame cap still refuses to go past 2x.
    expect(planScreenshot(box(390, 800)).scale).toBeCloseTo(2, 5);
    expect(planScreenshot(box(3900, 800)).scale).toBe(1);
  });

  it("splits a long design into crops that each fit the long edge", () => {
    const plan = planScreenshot(box(390, 5250), { targeted: true });
    const sections = planSections(box(390, 5250), plan.scale, []);
    expect(sections.length).toBeGreaterThan(3);
    for (const section of sections) {
      expect(section.height * plan.scale).toBeLessThanOrEqual(CANVAS_SCREENSHOT_MAX_EDGE + 1);
      expect(section.width * plan.scale).toBeGreaterThanOrEqual(
        CANVAS_SCREENSHOT_TARGET_WIDTH * 0.99,
      );
    }
  });

  it("cuts at section boundaries when the design has them", () => {
    // A design built out of sections reads best cut between them: a crop landing inside a section
    // hides the relationship the section was making.
    const sections = planSections(box(390, 1200), 1, [400, 800]);
    expect(sections.map((section) => section.height)).toEqual([400, 400, 400]);
    expect(sections.map((section) => section.y)).toEqual([0, 400, 800]);
  });

  it("falls back to overlapping slices when there are no boundaries", () => {
    const sections = planSections(box(390, 3000), 1, []);
    expect(sections.length).toBeGreaterThan(1);
    const first = sections[0]!;
    const second = sections[1]!;
    // The overlap is what stops a boundary being cut in exactly one place.
    expect(first.y + first.height - second.y).toBe(CANVAS_SCREENSHOT_SLICE_OVERLAP);
  });

  it("covers the whole target with no gaps", () => {
    const sections = planSections(box(390, 5250), 1, []);
    expect(sections[0]?.y).toBe(0);
    const last = sections[sections.length - 1]!;
    expect(last.y + last.height).toBeGreaterThanOrEqual(5250);
    for (let index = 1; index < sections.length; index += 1) {
      const previous = sections[index - 1]!;
      const current = sections[index]!;
      expect(current.y).toBeLessThan(previous.y + previous.height);
    }
  });

  it("ignores boundaries outside the target rather than emitting an empty crop", () => {
    const sections = planSections(box(390, 600), 1, [-100, 0, 600, 900]);
    expect(sections.every((section) => section.height > 1)).toBe(true);
  });
});

describe("png identification", () => {
  it("recognises a real png", () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  it("does not mistake text for an image", () => {
    expect(isPng(new TextEncoder().encode('{"type":"image"}'))).toBe(false);
    expect(isPng(new Uint8Array(0))).toBe(false);
  });
});
