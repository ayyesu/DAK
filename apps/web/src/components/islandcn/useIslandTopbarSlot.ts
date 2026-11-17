import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  ISLAND_SLOT_WIDTH,
  chooseIslandSlot,
  islandTopForBar,
  sampleOccupied,
  type IslandSlot,
  type Span,
} from "./islandPlacement";

export interface IslandTopbarSlot extends IslandSlot {
  /** The island's `top` that centres its resting pill on the title bar. */
  readonly top: number;
  /** Style for the island's region: shifts it sideways into the free part of the bar. */
  readonly style: CSSProperties;
}

/** Until the bar is measured: the default `--workspace-topbar-height`. */
const FALLBACK_BAR_HEIGHT = 52;

/**
 * What counts as something drawn on the bar. Text is checked separately, by its own extent, and
 * pictures only count when they are icon-sized (see `isMedia`).
 */
const CONTENT_SELECTOR =
  "button, a[href], input, select, textarea, summary, " +
  "[role='button'], [role='tab'], [role='link'], [role='menuitem'], [role='combobox'], " +
  "[role='switch'], [data-island-avoid]";
const MEDIA_SELECTOR = "svg, img, canvas, video";

/** Quiet moments: a scan is a few hundred hit tests, so it is spaced out, never per frame. */
const RESCAN_AFTER_EVENT_MS = 120;
const RESCAN_BACKSTOP_MS = 2_000;

const sameSlot = (a: IslandSlot & { top: number }, b: IslandSlot & { top: number }) =>
  a.top === b.top && a.fits === b.fits && Math.abs(a.offsetX - b.offsetX) < 1.5;

function makeProbe(css: string): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("aria-hidden", "true");
  element.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;${css}`;
  document.body.append(element);
  return element;
}

function hasOwnText(element: Element): boolean {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
  }
  return false;
}

/** The glyphs' own extent, clipped to the element: a truncated title ends where it is cut. */
function textBounds(element: Element, cache: WeakMap<Element, DOMRect | null>): DOMRect | null {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  const range = document.createRange();
  range.selectNodeContents(element);
  const text = range.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const bounds =
    text.width === 0
      ? null
      : new DOMRect(
          Math.max(text.left, box.left),
          box.top,
          Math.max(0, Math.min(text.right, box.right) - Math.max(text.left, box.left)),
          box.height,
        );
  cache.set(element, bounds);
  return bounds;
}

/**
 * A logo or an icon, not a backdrop: a full-window background image or canvas sits under every
 * point of the bar and would otherwise mark all of it as taken.
 */
function isMedia(element: Element, barHeight: number): boolean {
  if (!element.matches(MEDIA_SELECTOR)) return false;
  const box = element.getBoundingClientRect();
  return box.height <= barHeight && box.width <= barHeight * 4;
}

function drawnOnAt(
  x: number,
  y: number,
  barHeight: number,
  cache: WeakMap<Element, DOMRect | null>,
): boolean {
  for (const element of document.elementsFromPoint(x, y)) {
    if (element === document.documentElement || element === document.body) continue;
    // The island's own pieces: it is what is being placed, not an obstacle.
    if (element.closest("[data-islandcn]") !== null) continue;
    if (element.matches(CONTENT_SELECTOR) || isMedia(element, barHeight)) return true;
    if (hasOwnText(element)) {
      const bounds = textBounds(element, cache);
      if (bounds !== null && x >= bounds.left && x <= bounds.right) return true;
    }
  }
  return false;
}

function measure(
  bar: HTMLElement,
  controlsInset: HTMLElement,
  scale: number,
): { top: number } & IslandSlot {
  const barHeight = bar.getBoundingClientRect().height || FALLBACK_BAR_HEIGHT;
  const viewportWidth = document.documentElement.clientWidth;

  const cache = new WeakMap<Element, DOMRect | null>();
  const occupied: Span[] = sampleOccupied({
    viewportWidth,
    barHeight,
    occupiedAt: (x, y) => drawnOnAt(x, y, barHeight, cache),
  });

  // The window's own buttons are not in the page, so they never show up in a hit test.
  const inset = controlsInset.getBoundingClientRect().width;
  if (inset > 0) occupied.push({ start: viewportWidth - inset, end: viewportWidth });

  // Anything that must stay clear but can't be found by hit testing (pointer-events: none, say).
  for (const marked of document.querySelectorAll("[data-island-avoid]")) {
    const rect = marked.getBoundingClientRect();
    if (rect.width > 0 && rect.top < barHeight && rect.bottom > 0) {
      occupied.push({ start: rect.left, end: rect.right });
    }
  }

  return {
    top: islandTopForBar(barHeight, scale),
    // The resting island is drawn at `scale`, so that is the width it needs.
    ...chooseIslandSlot({ viewportWidth, occupied, islandWidth: ISLAND_SLOT_WIDTH * scale }),
  };
}

/**
 * Where the island goes so it covers nothing: on the title bar's centre line, shifted sideways
 * into the free part of the bar when the header's content reaches the middle.
 *
 * `scale` is how much smaller than the phone design the island is drawn (`ISLAND_UI_SCALE`). The
 * returned `style` applies it, and `top` and the free width it looks for allow for it.
 *
 * It re-measures when the window resizes, when a layout transition ends (the sidebar opening),
 * when header content changes, when `routeKey` changes and on a slow backstop for anything those
 * miss. `routeKey` is any value that changes when the screen does (the pathname).
 */
export function useIslandTopbarSlot(routeKey: string, scale = 1): IslandTopbarSlot {
  const [slot, setSlot] = useState<{ top: number } & IslandSlot>(() => ({
    top: islandTopForBar(FALLBACK_BAR_HEIGHT, scale),
    offsetX: 0,
    fits: true,
  }));

  const rescanRef = useRef<(delay?: number) => void>(() => {});
  const scaleRef = useRef(scale);

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    // Probes, so the bar height and the native-controls inset are whatever the CSS resolves them
    // to (`max(40px, env(titlebar-area-height, 52px))` is not a number until it is laid out).
    const bar = makeProbe("top:0;left:0;width:0;height:var(--workspace-topbar-height);");
    const controlsInset = makeProbe(
      "top:0;right:0;height:0;width:var(--workspace-native-controls-inset);",
    );

    let timer: number | null = null;
    const run = () => {
      timer = null;
      const next = measure(bar, controlsInset, scaleRef.current);
      setSlot((current) => (sameSlot(current, next) ? current : next));
    };
    const schedule = (delay = RESCAN_AFTER_EVENT_MS) => {
      if (timer === null) timer = window.setTimeout(run, delay);
    };

    rescanRef.current = schedule;
    run();
    // After the screen settles: a route change mounts its header a frame or two later.
    schedule(250);

    const resize = new ResizeObserver(() => schedule());
    resize.observe(document.documentElement);

    let headers: MutationObserver | null = null;
    const watchHeaders = () => {
      headers?.disconnect();
      headers = new MutationObserver(() => schedule());
      for (const header of document.querySelectorAll("header, .drag-region, [data-island-avoid]")) {
        headers.observe(header, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["class", "style", "data-sidebar-state", "hidden"],
        });
      }
    };
    watchHeaders();

    const onTransitionEnd = () => schedule();
    document.addEventListener("transitionend", onTransitionEnd, true);
    window.addEventListener("resize", onTransitionEnd);
    const backstop = window.setInterval(() => {
      watchHeaders();
      schedule(0);
    }, RESCAN_BACKSTOP_MS);

    return () => {
      rescanRef.current = () => {};
      if (timer !== null) window.clearTimeout(timer);
      window.clearInterval(backstop);
      resize.disconnect();
      headers?.disconnect();
      document.removeEventListener("transitionend", onTransitionEnd, true);
      window.removeEventListener("resize", onTransitionEnd);
      bar.remove();
      controlsInset.remove();
    };
  }, []);

  // A new screen has a new header, and a new scale changes how much room the island needs.
  useEffect(() => {
    scaleRef.current = scale;
    rescanRef.current(180);
  }, [routeKey, scale]);

  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const style = useMemo<CSSProperties>(
    () => ({
      // Same width, shifted: the island still lays out against the whole window.
      left: slot.offsetX,
      right: -slot.offsetX,
      // Drawn smaller about its top centre. The region spans the window, so its centre is the
      // island's, and the shift above moves that centre without being scaled itself.
      ...(scale === 1 ? {} : { transform: `scale(${scale})`, transformOrigin: "50% 0" }),
      ...(reducedMotion
        ? {}
        : {
            transition: "left 220ms var(--ease-macos, ease), right 220ms var(--ease-macos, ease)",
          }),
    }),
    [slot.offsetX, reducedMotion, scale],
  );

  return { top: slot.top, offsetX: slot.offsetX, fits: slot.fits, style };
}
