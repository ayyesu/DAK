// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { CanvasWorld, FRAME_LABEL_GUTTER, layoutFrames } from "./CanvasPanel";
import type { CanvasCamera } from "./canvasCamera";
import type { CanvasRenderedFrame } from "./canvasViewState";

/**
 * What a frame says it is, and how big it is, in the real markup.
 *
 * These assert the rendered DOM rather than the arithmetic behind it. The arithmetic is covered in
 * `canvasCamera.test.ts`; what it cannot tell us is whether the word "route" reaches the screen,
 * because that depends on what the component chose to render.
 */

const frame = (over: Partial<CanvasRenderedFrame> = {}): CanvasRenderedFrame => ({
  nodeId: "frame-projects",
  designWidth: 390,
  designHeight: 1550,
  width: 258,
  height: 1024,
  data: "",
  sequence: 1,
  ...over,
});

const camera = (over: Partial<CanvasCamera> = {}): CanvasCamera => ({
  zoom: 1,
  panX: 0,
  panY: 0,
  ...over,
});

const render = async (
  frames: ReadonlyArray<CanvasRenderedFrame>,
  view: CanvasCamera = camera(),
): Promise<HTMLElement> => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CanvasWorld frames={frames} camera={view} omittedFrames={0} projectionCurrent={true} />,
    );
  });
  return container;
};

describe("what a frame says it is", () => {
  it("shows the frame's own name", async () => {
    const container = await render([frame({ name: "Projects" })]);
    expect(container.textContent).toContain("Projects");
  });

  it("never shows the word 'route', even though the server sends it", async () => {
    // `role` is on the frame in the document and arrives in the payload. "route" identifies nothing
    // when every screen in a design carries it, so it must not reach the screen.
    const container = await render([frame({ name: "Projects", role: "route" })]);
    expect(container.textContent?.toLowerCase()).not.toContain("route");
    expect(container.innerHTML.toLowerCase()).not.toContain("route");
  });

  it("falls back to 'Frame N', counting from one, for a frame the agent left unnamed", async () => {
    const container = await render([
      frame({ nodeId: "a", name: "Home" }),
      frame({ nodeId: "b" }),
      frame({ nodeId: "c" }),
    ]);
    expect(container.textContent).toContain("Frame 2");
    expect(container.textContent).toContain("Frame 3");
    expect(container.textContent).not.toContain("Frame 1");
  });

  it("labels every frame, so two designs can be told apart in the viewer", async () => {
    const container = await render([
      frame({ nodeId: "a", name: "Home" }),
      frame({ nodeId: "b", name: "Projects" }),
      frame({ nodeId: "c", name: "Contact" }),
    ]);
    for (const label of ["Home", "Projects", "Contact"]) {
      expect(container.textContent).toContain(label);
    }
  });
});

describe("a frame's box in the DOM", () => {
  it("is the design size, not the size of the bitmap it was drawn from", async () => {
    // 258x1024 is the raster at a 1024 edge. The frame is 390x1550 and is laid out as such.
    const container = await render([frame()]);
    const figure = container.querySelector("[data-canvas-frame]") as HTMLElement;
    expect(figure.style.width).toBe("390px");
    expect(figure.style.height).toBe("1550px");
  });

  it("is identical for the same frame at any raster resolution", async () => {
    // The regression: a panel that laid out from the bitmap resized every frame when it re-rendered
    // at a different edge, which is the same bug as a frame resizing with the panel.
    const low = await render([frame({ width: 237, height: 512 })]);
    const high = await render([frame({ width: 390, height: 1550 })]);
    const box = (c: HTMLElement) => {
      const f = c.querySelector("[data-canvas-frame]") as HTMLElement;
      return `${f.style.width}x${f.style.height}`;
    };
    expect(box(low)).toBe("390pxx1550px");
    expect(box(high)).toBe(box(low));
  });

  it("puts the next frame to the right, so panning sideways reaches it", async () => {
    const container = await render([
      frame({ nodeId: "home", name: "Home" }),
      frame({ nodeId: "projects", name: "Projects" }),
    ]);
    const first = container.querySelector('[data-canvas-frame="home"]') as HTMLElement;
    const second = container.querySelector('[data-canvas-frame="projects"]') as HTMLElement;
    expect(Number.parseFloat(first.style.left)).toBe(0);
    expect(Number.parseFloat(second.style.left)).toBeGreaterThan(0);
  });
});

describe("the world's transform", () => {
  it("carries the zoom and the pan, which is how the design moves without resizing", async () => {
    const container = await render([frame()], camera({ zoom: 2, panX: 30, panY: -12 }));
    const world = container.querySelector("[data-canvas-world]") as HTMLElement;
    expect(world.style.transform).toContain("scale(2)");
    expect(world.style.transform).toContain("30px");
    expect(world.style.transform).toContain("-12px");
  });
});

describe("the layout itself", () => {
  it("places every frame at its own declared size, whatever the panel is doing", () => {
    // Pure, and the reason the DOM above cannot drift from it: no viewport width is an input.
    const laid = layoutFrames([
      frame({ nodeId: "a", designWidth: 390, designHeight: 844 }),
      frame({ nodeId: "b", designWidth: 1440, designHeight: 900 }),
    ]);
    expect(laid.items.map((placed) => [placed.width, placed.height])).toEqual([
      [390, 844],
      [1440, 900],
    ]);
    expect(laid.width).toBe(1440 + 48 + 390);
    expect(laid.height).toBe(900 + FRAME_LABEL_GUTTER);
  });

  it("leaves room above every frame for the frame's own name", () => {
    // The name is drawn above the frame, so the layout has to reserve the space for it. Without
    // this, a caption and the top of its own frame want the same pixels, and the caption wins.
    const laid = layoutFrames([frame({ nodeId: "a" }), frame({ nodeId: "b" })]);
    expect(laid.items.map((placed) => placed.top)).toEqual([
      FRAME_LABEL_GUTTER,
      FRAME_LABEL_GUTTER,
    ]);
    expect(laid.height).toBe(1550 + FRAME_LABEL_GUTTER);
  });
});
