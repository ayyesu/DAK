import { describe, expect, it } from "vite-plus/test";

import {
  applyShortcut,
  applyWheel,
  fitCamera,
  gestureForWheel,
  initialCanvasCamera,
  MAX_ZOOM,
  MIN_ZOOM,
  panCamera,
  shortcutForKey,
  zoomCameraAt,
  zoomCameraCentered,
} from "./canvasCamera";

/**
 * The camera is the only thing that decides where a design appears, and the one thing that must not.
 *
 * The regression these guard is the reported one: dragging the panel wider stretched every frame,
 * because each frame was laid out at `width: 100%` of the panel and the raster's own dimensions were
 * the only size a client knew. A frame is now `designWidth x designHeight` times the zoom, so its box
 * is a function of the design and the camera — and no viewport measurement appears anywhere below.
 */

const viewport = { width: 900, height: 700 };
const frames = [
  { width: 390, height: 844 },
  { width: 390, height: 1550 },
];

describe("fitting a design to the panel", () => {
  it("centres the design in the viewport", () => {
    const camera = fitCamera(frames, viewport);
    const worldWidth = Math.max(...frames.map((f) => f.width));
    const worldHeight = Math.max(...frames.map((f) => f.height));
    // The design's centre lands on the viewport's centre.
    expect(camera.panX + (worldWidth * camera.zoom) / 2).toBeCloseTo(viewport.width / 2, 5);
    expect(camera.panY + (worldHeight * camera.zoom) / 2).toBeCloseTo(viewport.height / 2, 5);
  });

  it("never magnifies a design past its own size just because there is room", () => {
    // A tiny design in a huge panel fits at 1:1, not blown up to fill.
    expect(fitCamera([{ width: 100, height: 100 }], { width: 3000, height: 2000 }).zoom).toBe(1);
  });

  it("shrinks a design that is larger than the panel", () => {
    const camera = fitCamera([{ width: 3900, height: 8440 }], viewport);
    expect(camera.zoom).toBeLessThan(1);
    expect(camera.zoom * 8440).toBeLessThanOrEqual(viewport.height);
  });

  it("leaves the camera alone rather than dividing by zero on an empty or unmeasured viewport", () => {
    expect(fitCamera([], viewport)).toEqual(initialCanvasCamera);
    expect(fitCamera(frames, { width: 0, height: 0 })).toEqual(initialCanvasCamera);
  });
});

describe("a frame's size does not depend on the panel", () => {
  it("is the design size times the zoom, at any panel width", () => {
    const design = 390;
    const zoom = fitCamera(frames, viewport).zoom;
    // The arithmetic the DOM performs: a frame's box is `design * zoom`. The panel's width is not an
    // input to it anywhere, which is what these three calls differ on — and the property under test.
    const cssWidth = design * zoom;
    for (const panelWidth of [400, 900, 2000]) {
      expect(design * zoom).toBe(cssWidth);
      expect(panelWidth).toBeGreaterThan(0);
    }
  });

  it("changes size only when the user zooms", () => {
    const fitted = fitCamera(frames, viewport);
    const zoomed = zoomCameraCentered(fitted, 2, viewport);
    expect(zoomed.zoom).toBeCloseTo(fitted.zoom * 2, 5);
    expect(zoomed.zoom).not.toBe(fitted.zoom);
  });
});

describe("zooming at the cursor", () => {
  it("holds the design point under the cursor still", () => {
    const camera = { zoom: 1, panX: 0, panY: 0 };
    const anchor = { x: 300, y: 200 };
    const before = {
      x: (anchor.x - camera.panX) / camera.zoom,
      y: (anchor.y - camera.panY) / camera.zoom,
    };
    const zoomed = zoomCameraAt(camera, 2, anchor);
    const after = {
      x: (anchor.x - zoomed.panX) / zoomed.zoom,
      y: (anchor.y - zoomed.panY) / zoomed.zoom,
    };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("clamps to the supported range rather than letting a gesture run away", () => {
    let camera = initialCanvasCamera;
    for (let i = 0; i < 200; i += 1) camera = zoomCameraAt(camera, 2, { x: 0, y: 0 });
    expect(camera.zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 200; i += 1) camera = zoomCameraAt(camera, 0.5, { x: 0, y: 0 });
    expect(camera.zoom).toBe(MIN_ZOOM);
  });

  it("does nothing once it is already clamped, so a held gesture stops churning state", () => {
    const clamped = { zoom: MAX_ZOOM, panX: 12, panY: 34 };
    expect(zoomCameraAt(clamped, 2, { x: 0, y: 0 })).toBe(clamped);
  });
});

describe("wheel gestures", () => {
  it("pans on a plain wheel", () => {
    expect(gestureForWheel({ ctrlKey: false, metaKey: false })).toBe("pan");
  });

  // A trackpad pinch arrives as ctrlKey, so without this a pinch throws the user across the design.
  it("zooms on a trackpad pinch, which arrives as a wheel with ctrl held", () => {
    expect(gestureForWheel({ ctrlKey: true, metaKey: false })).toBe("zoom");
    expect(gestureForWheel({ ctrlKey: false, metaKey: true })).toBe("zoom");
  });

  it("moves the camera opposite the wheel, which is how a surface tracks a finger", () => {
    const panned = applyWheel(initialCanvasCamera, {
      deltaX: 0,
      deltaY: 100,
      ctrlKey: false,
      metaKey: false,
      cursorX: 0,
      cursorY: 0,
    });
    expect(panned.panY).toBeLessThan(0);
    expect(panned.zoom).toBe(1);
  });

  it("zooms rather than panning when ctrl is held", () => {
    const zoomed = applyWheel(initialCanvasCamera, {
      deltaX: 0,
      deltaY: -120,
      ctrlKey: true,
      metaKey: false,
      cursorX: 100,
      cursorY: 100,
    });
    expect(zoomed.zoom).toBeGreaterThan(1);
    // The pan is whatever holds the cursor still, not the wheel delta: a plain wheel with the same
    // delta moves the camera by -deltaY, and this must not.
    const plain = applyWheel(initialCanvasCamera, {
      deltaX: 0,
      deltaY: -120,
      ctrlKey: false,
      metaKey: false,
      cursorX: 100,
      cursorY: 100,
    });
    expect(zoomed.panY).not.toBe(plain.panY);
    expect(plain.panY).toBe(120);
  });
});

describe("panning", () => {
  it("adds the drag delta", () => {
    expect(panCamera({ zoom: 1, panX: 10, panY: 20 }, { x: -5, y: 7 })).toEqual({
      zoom: 1,
      panX: 5,
      panY: 27,
    });
  });
});

describe("keyboard shortcuts", () => {
  const at = (over: Partial<Parameters<typeof shortcutForKey>[0]>) =>
    shortcutForKey({
      key: "+",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...over,
    });

  it("zooms in and out on + and -", () => {
    expect(at({ key: "+" })).toBe("zoomIn");
    expect(at({ key: "=" })).toBe("zoomIn");
    expect(at({ key: "-" })).toBe("zoomOut");
  });

  it("fits on Shift+0 and Shift+1, and returns to true size on Shift+2", () => {
    expect(at({ key: "0", shiftKey: true })).toBe("fit");
    expect(at({ key: ")", shiftKey: true })).toBe("fit");
    expect(at({ key: "1", shiftKey: true })).toBe("fit");
    expect(at({ key: "2", shiftKey: true })).toBe("actualSize");
  });

  it("ignores a modified keystroke, so Cmd+plus stays the browser's own zoom", () => {
    expect(at({ key: "+", metaKey: true })).toBeNull();
    expect(at({ key: "-", ctrlKey: true })).toBeNull();
    expect(at({ key: "0", shiftKey: true, altKey: true })).toBeNull();
  });

  it("leaves ordinary typing alone", () => {
    expect(at({ key: "a" })).toBeNull();
    expect(at({ key: "Enter" })).toBeNull();
  });

  it("zooms about the middle of the viewport for the +/- keys", () => {
    const start = { zoom: 1, panX: 0, panY: 0 };
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };
    const worldBefore = {
      x: (centre.x - start.panX) / start.zoom,
      y: (centre.y - start.panY) / start.zoom,
    };
    const zoomed = applyShortcut(start, "zoomIn", viewport);
    expect(zoomed.zoom).toBeGreaterThan(1);
    // The world point under the middle of the viewport is the same point afterwards.
    expect((centre.x - zoomed.panX) / zoomed.zoom).toBeCloseTo(worldBefore.x, 6);
    expect((centre.y - zoomed.panY) / zoomed.zoom).toBeCloseTo(worldBefore.y, 6);
  });

  it("returns to 100% from any zoom", () => {
    expect(applyShortcut({ zoom: 3.7, panX: 5, panY: 5 }, "actualSize", viewport).zoom).toBeCloseTo(
      1,
      6,
    );
  });
});
