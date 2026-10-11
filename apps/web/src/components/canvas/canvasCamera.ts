/**
 * Where the camera is, and how it moves.
 *
 * The panel used to be a document scroller: frames were laid out at `width: 100%` inside an
 * `overflow-auto` box, so widening the panel stretched every frame and narrowing it squashed them.
 * A design has a real size — 390x844 is a phone frame — and the panel's width has no say in it.
 *
 * So the frames are drawn at their own size and the camera moves over them instead. Everything here
 * is pure arithmetic over that camera, kept out of the component so the behaviour that actually
 * matters — that a frame's size is a property of the design and never of the viewport — can be
 * tested without a browser.
 */

/** The bounds a zoom is held to, so a stray gesture cannot make a design disappear or fill the sky. */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

/** What one Ctrl+wheel notch multiplies the zoom by. Matches a trackpad's pinch granularity. */
export const ZOOM_STEP = 1.1;

/** The gap left around the design when it is fitted, as a fraction of the fitted size. */
const FIT_PADDING = 0.08;

export interface CanvasCamera {
  /** Scale from design units to CSS pixels. 1 means one design pixel is one screen pixel. */
  readonly zoom: number;
  /** Camera offset in CSS pixels from the viewport's top-left to the world's origin. */
  readonly panX: number;
  readonly panY: number;
}

export const initialCanvasCamera: CanvasCamera = { zoom: 1, panX: 0, panY: 0 };

/** The world-space rectangle a set of frames occupies, in design units. */
export interface CanvasFrameBox {
  readonly width: number;
  readonly height: number;
}

export const clampZoom = (zoom: number): number =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : 1));

/**
 * The camera that shows `content` inside `viewport`.
 *
 * Centred, and never larger than 1: a design fitted to a wide panel must not be blown up past its
 * own size just because there is room, which is the same mistake as stretching it.
 */
export const fitCamera = (
  content: ReadonlyArray<CanvasFrameBox>,
  viewport: { readonly width: number; readonly height: number },
): CanvasCamera => {
  const width = content.reduce((widest, frame) => Math.max(widest, frame.width), 0);
  const height = content.reduce((tallest, frame) => Math.max(tallest, frame.height), 0);
  if (width <= 0 || height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return initialCanvasCamera;
  }
  const scale = Math.min(
    1,
    (viewport.width * (1 - FIT_PADDING)) / width,
    (viewport.height * (1 - FIT_PADDING)) / height,
  );
  const zoom = clampZoom(scale);
  return {
    zoom,
    // Centre the design, so opening a panel shows the middle of it rather than its top-left corner.
    panX: (viewport.width - width * zoom) / 2,
    panY: (viewport.height - height * zoom) / 2,
  };
};

/**
 * Zooms by `factor`, holding the design point under `anchor` still.
 *
 * `anchor` is in viewport pixels. Without this a zoom drives the content away from the cursor, so the
 * thing the user pointed at is no longer under their pointer — which is the whole complaint about
 * pinch-zoom in a browser.
 */
export const zoomCameraAt = (
  camera: CanvasCamera,
  factor: number,
  anchor: { readonly x: number; readonly y: number },
): CanvasCamera => {
  const zoom = clampZoom(camera.zoom * factor);
  if (zoom === camera.zoom) return camera;
  // The world point currently under the anchor, before the zoom changes.
  const worldX = (anchor.x - camera.panX) / camera.zoom;
  const worldY = (anchor.y - camera.panY) / camera.zoom;
  return { zoom, panX: anchor.x - worldX * zoom, panY: anchor.y - worldY * zoom };
};

/** Zooms about the middle of the viewport, for the `+`/`-` keys and the dropdown. */
export const zoomCameraCentered = (
  camera: CanvasCamera,
  factor: number,
  viewport: { readonly width: number; readonly height: number },
): CanvasCamera => zoomCameraAt(camera, factor, { x: viewport.width / 2, y: viewport.height / 2 });

export const panCamera = (
  camera: CanvasCamera,
  delta: { readonly x: number; readonly y: number },
): CanvasCamera => ({ ...camera, panX: camera.panX + delta.x, panY: camera.panY + delta.y });

/**
 * What a gesture means.
 *
 * Plain wheel pans, because panning is what a design surface is for and the scrollbar it replaces
 * did the same. Ctrl/⌘+wheel zooms, which is also what a trackpad pinch reports, so a pinch never
 * turns into a scroll that throws the user across the design.
 */
export type CanvasGesture = "pan" | "zoom";

export const gestureForWheel = (event: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): CanvasGesture => (event.ctrlKey || event.metaKey ? "zoom" : "pan");

/** How a wheel event moves the camera. */
export const applyWheel = (
  camera: CanvasCamera,
  event: {
    readonly deltaX: number;
    readonly deltaY: number;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly cursorX: number;
    readonly cursorY: number;
  },
): CanvasCamera => {
  if (gestureForWheel(event) === "zoom") {
    return zoomCameraAt(camera, Math.exp(-event.deltaY * 0.01), {
      x: event.cursorX,
      y: event.cursorY,
    });
  }
  return panCamera(camera, { x: -event.deltaX, y: -event.deltaY });
};

/** The zoom levels the dropdown offers. Coarse, because a slider is not the point. */
export const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4] as const;

export type CanvasShortcut = "zoomIn" | "zoomOut" | "fit" | "actualSize" | "zoomSelection" | null;

/**
 * Which shortcut a keystroke means.
 *
 * Returned rather than applied so the key handling stays a pure table, and so a test can assert the
 * whole map without synthesising events. `digits` carries the numeral so `Shift+0/1/2` can tell them
 * apart without three near-identical cases.
 */
export const shortcutForKey = (event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): CanvasShortcut => {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "+" || event.key === "=") return event.shiftKey ? null : "zoomIn";
  if (event.key === "-" || event.key === "_") return event.shiftKey ? null : "zoomOut";
  if (!event.shiftKey) return null;
  // Shift+0/1/2, matched on the digit because Shift rewrites the `key` on some layouts.
  if (event.key === ")" || event.key === "0") return "fit";
  if (event.key === "!" || event.key === "1") return "fit";
  if (event.key === "@" || event.key === "2") return "actualSize";
  return null;
};

/** Applies a shortcut, which is the only place a shortcut turns into arithmetic. */
export const applyShortcut = (
  camera: CanvasCamera,
  shortcut: Exclude<CanvasShortcut, null>,
  viewport: { readonly width: number; readonly height: number },
): CanvasCamera => {
  switch (shortcut) {
    case "zoomIn":
      return zoomCameraCentered(camera, ZOOM_STEP, viewport);
    case "zoomOut":
      return zoomCameraCentered(camera, 1 / ZOOM_STEP, viewport);
    case "actualSize":
      return zoomCameraCentered(camera, 1 / camera.zoom, viewport);
    case "fit":
    case "zoomSelection":
      return camera;
  }
};
