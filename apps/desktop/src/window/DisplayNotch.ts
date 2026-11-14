/**
 * Whether the display a window is on has a physical camera notch (MacBook Pro 2021+,
 * MacBook Air 2022+).
 *
 * Electron has no notch API and Chromium does not fill in `env(safe-area-inset-top)`,
 * so this infers it from the menu bar. A classic macOS menu bar is about 24pt tall;
 * on a notched Mac the menu bar grows to about 37-38pt. Electron reports the menu bar
 * as the gap between a display's `bounds.y` and `workArea.y`.
 *
 * Known limits:
 * - The menu bar is hidden in native fullscreen and with auto-hide, so the gap reads 0.
 *   The last real reading per display is remembered and reused then. A display that has
 *   never been seen with a visible menu bar reads as "no notch".
 * - A Dock docked to the top of the screen also moves `workArea.y`. The upper bound
 *   below keeps that from reading as a notch on most setups.
 * - Only the built-in display (`internal`) of a notched Mac can have a notch.
 */

/** A notched menu bar starts around 37pt; a classic one is about 24pt. */
const NOTCH_MENU_BAR_MIN_THICKNESS = 30;
/** Above this the top inset is more likely a top Dock than a menu bar. */
const NOTCH_MENU_BAR_MAX_THICKNESS = 50;

export interface NotchDisplay {
  readonly id: number;
  readonly internal: boolean;
  readonly bounds: { readonly y: number };
  readonly workArea: { readonly y: number };
}

export interface NotchWindow {
  getBounds(): { x: number; y: number; width: number; height: number };
  isDestroyed(): boolean;
  on(event: "moved" | "enter-full-screen" | "leave-full-screen", listener: () => void): unknown;
  removeListener(
    event: "moved" | "enter-full-screen" | "leave-full-screen",
    listener: () => void,
  ): unknown;
}

export interface NotchScreen {
  getDisplayMatching(rect: { x: number; y: number; width: number; height: number }): NotchDisplay;
  on(event: DisplayEvent, listener: () => void): unknown;
  removeListener(event: DisplayEvent, listener: () => void): unknown;
}

type DisplayEvent = "display-added" | "display-removed" | "display-metrics-changed";
const DISPLAY_EVENTS: readonly DisplayEvent[] = [
  "display-added",
  "display-removed",
  "display-metrics-changed",
];

/** Last real answer per display id, for the moments the menu bar is hidden. */
const lastKnownByDisplayId = new Map<number, boolean>();

export const resetDisplayNotchCache = (): void => {
  lastKnownByDisplayId.clear();
};

export function displayHasNotch(display: NotchDisplay, platform: NodeJS.Platform): boolean {
  if (platform !== "darwin" || !display.internal) return false;
  const thickness = display.workArea.y - display.bounds.y;
  if (thickness > 0) {
    const hasNotch =
      thickness >= NOTCH_MENU_BAR_MIN_THICKNESS && thickness <= NOTCH_MENU_BAR_MAX_THICKNESS;
    lastKnownByDisplayId.set(display.id, hasNotch);
    return hasNotch;
  }
  return lastKnownByDisplayId.get(display.id) ?? false;
}

export function windowDisplayHasNotch(
  window: Pick<NotchWindow, "getBounds" | "isDestroyed">,
  screen: Pick<NotchScreen, "getDisplayMatching">,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "darwin" || window.isDestroyed()) return false;
  return displayHasNotch(screen.getDisplayMatching(window.getBounds()), platform);
}

/**
 * Calls `onChange` whenever the answer for `window` changes: a display is plugged in or
 * removed, its resolution changes, the window is moved to another display, or the menu
 * bar comes back after fullscreen. Returns a function that stops watching.
 */
export function watchWindowDisplayNotch(input: {
  readonly window: NotchWindow;
  readonly screen: NotchScreen;
  readonly platform: NodeJS.Platform;
  readonly onChange: (hasNotch: boolean) => void;
}): () => void {
  const { window, screen, platform, onChange } = input;
  if (platform !== "darwin") return () => undefined;

  let last = windowDisplayHasNotch(window, screen, platform);
  const refresh = () => {
    const next = windowDisplayHasNotch(window, screen, platform);
    if (next === last) return;
    last = next;
    onChange(next);
  };

  for (const event of DISPLAY_EVENTS) screen.on(event, refresh);
  window.on("moved", refresh);
  window.on("enter-full-screen", refresh);
  window.on("leave-full-screen", refresh);

  return () => {
    for (const event of DISPLAY_EVENTS) screen.removeListener(event, refresh);
    window.removeListener("moved", refresh);
    window.removeListener("enter-full-screen", refresh);
    window.removeListener("leave-full-screen", refresh);
  };
}
