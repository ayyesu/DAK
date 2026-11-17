import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { contentWidth } from "./surface";

type FakeElement = HTMLElement & { transform: string };

/** Just enough of an element for `contentWidth`: a transform, a rect and an enclosing root. */
const fakeElement = (input: {
  transform: string;
  rectWidth: number;
  root?: FakeElement | null;
}): FakeElement =>
  ({
    childNodes: { length: 1 },
    getBoundingClientRect: () => ({ width: input.rectWidth }),
    closest: () => input.root ?? null,
    transform: input.transform,
  }) as unknown as FakeElement;

describe("contentWidth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubStyle = () => {
    vi.stubGlobal("getComputedStyle", (element: { transform: string }) => ({
      transform: element.transform,
    }));
    vi.stubGlobal(
      "DOMMatrixReadOnly",
      class {
        a: number;
        constructor(transform: string) {
          this.a = Number(/matrix\(([^,]+)/.exec(transform)?.[1] ?? 1);
        }
      },
    );
  };

  it("divides out a scale on the island itself, not only the slot's own", () => {
    stubStyle();
    // The island is drawn at 0.8, so a 100 px slot measures 80 on screen. Without the correction
    // it would read 80, look 20% too narrow, and the card would cut its text to fit.
    const root = fakeElement({ transform: "matrix(0.8, 0, 0, 0.8, 0, 0)", rectWidth: 800 });
    const slot = fakeElement({ transform: "none", rectWidth: 80, root });
    expect(contentWidth(slot)).toBeCloseTo(100, 5);
  });

  it("still divides out the slot's own scale on top of the island's", () => {
    stubStyle();
    const root = fakeElement({ transform: "matrix(0.8, 0, 0, 0.8, 0, 0)", rectWidth: 800 });
    // Slot at its own 0.5 inside an island at 0.8: 100 px of layout draws 40 px wide.
    const slot = fakeElement({ transform: "matrix(0.5, 0, 0, 0.5, 0, 0)", rectWidth: 40, root });
    expect(contentWidth(slot)).toBeCloseTo(100, 5);
  });

  it("is unchanged when nothing is scaled", () => {
    stubStyle();
    const root = fakeElement({ transform: "none", rectWidth: 1000 });
    const slot = fakeElement({ transform: "none", rectWidth: 123.4, root });
    expect(contentWidth(slot)).toBeCloseTo(123.4, 5);
  });
});
