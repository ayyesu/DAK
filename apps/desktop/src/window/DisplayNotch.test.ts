import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  displayHasNotch,
  resetDisplayNotchCache,
  watchWindowDisplayNotch,
  windowDisplayHasNotch,
  type NotchDisplay,
  type NotchScreen,
  type NotchWindow,
} from "./DisplayNotch.ts";

const display = (overrides: Partial<NotchDisplay> & { menuBar?: number } = {}): NotchDisplay => ({
  id: overrides.id ?? 1,
  internal: overrides.internal ?? true,
  bounds: { y: 0 },
  workArea: { y: overrides.menuBar ?? 0 },
});

beforeEach(resetDisplayNotchCache);

describe("displayHasNotch", () => {
  it("reads a notched menu bar as a notch", () => {
    expect(displayHasNotch(display({ menuBar: 37 }), "darwin")).toBe(true);
    expect(displayHasNotch(display({ menuBar: 38 }), "darwin")).toBe(true);
  });

  it("reads a classic menu bar as no notch", () => {
    expect(displayHasNotch(display({ menuBar: 24 }), "darwin")).toBe(false);
  });

  it("ignores external displays and other platforms", () => {
    expect(displayHasNotch(display({ menuBar: 37, internal: false }), "darwin")).toBe(false);
    expect(displayHasNotch(display({ menuBar: 37 }), "win32")).toBe(false);
    expect(displayHasNotch(display({ menuBar: 37 }), "linux")).toBe(false);
  });

  it("does not read a tall top inset (a top Dock) as a notch", () => {
    expect(displayHasNotch(display({ menuBar: 90 }), "darwin")).toBe(false);
  });

  it("keeps the last real answer while the menu bar is hidden in fullscreen", () => {
    expect(displayHasNotch(display({ menuBar: 37 }), "darwin")).toBe(true);
    expect(displayHasNotch(display({ menuBar: 0 }), "darwin")).toBe(true);
  });

  it("reads a display it never saw a menu bar on as no notch", () => {
    expect(displayHasNotch(display({ id: 9, menuBar: 0 }), "darwin")).toBe(false);
  });

  it("remembers each display separately", () => {
    expect(displayHasNotch(display({ id: 1, menuBar: 37 }), "darwin")).toBe(true);
    expect(displayHasNotch(display({ id: 2, menuBar: 24 }), "darwin")).toBe(false);
    expect(displayHasNotch(display({ id: 1, menuBar: 0 }), "darwin")).toBe(true);
    expect(displayHasNotch(display({ id: 2, menuBar: 0 }), "darwin")).toBe(false);
  });
});

const makeHarness = () => {
  const handlers = new Map<string, Set<() => void>>();
  const emitter = {
    on: (event: string, listener: () => void) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(listener));
    },
    removeListener: (event: string, listener: () => void) => {
      handlers.get(event)?.delete(listener);
    },
  };
  let current = display({ menuBar: 37 });
  const window: NotchWindow = {
    ...emitter,
    getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    isDestroyed: () => false,
  };
  const screen: NotchScreen = { ...emitter, getDisplayMatching: () => current };
  return {
    window,
    screen,
    setDisplay: (next: NotchDisplay) => {
      current = next;
    },
    emit: (event: string) => handlers.get(event)?.forEach((listener) => listener()),
    listenerCount: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
};

describe("windowDisplayHasNotch", () => {
  it("is false for a destroyed window", () => {
    const harness = makeHarness();
    const destroyed = { ...harness.window, isDestroyed: () => true };
    expect(windowDisplayHasNotch(destroyed, harness.screen, "darwin")).toBe(false);
  });
});

describe("watchWindowDisplayNotch", () => {
  it("reports only changes, when the window moves to a display without a notch", () => {
    const harness = makeHarness();
    const onChange = vi.fn();
    watchWindowDisplayNotch({
      window: harness.window,
      screen: harness.screen,
      platform: "darwin",
      onChange,
    });

    harness.emit("moved");
    expect(onChange).not.toHaveBeenCalled();

    harness.setDisplay(display({ id: 2, internal: false, menuBar: 24 }));
    harness.emit("moved");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);

    harness.emit("display-metrics-changed");
    expect(onChange).toHaveBeenCalledTimes(1);

    harness.setDisplay(display({ id: 1, menuBar: 37 }));
    harness.emit("display-added");
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("stops listening when disposed", () => {
    const harness = makeHarness();
    const dispose = watchWindowDisplayNotch({
      window: harness.window,
      screen: harness.screen,
      platform: "darwin",
      onChange: vi.fn(),
    });
    expect(harness.listenerCount()).toBeGreaterThan(0);
    dispose();
    expect(harness.listenerCount()).toBe(0);
  });

  it("does nothing off macOS", () => {
    const harness = makeHarness();
    const dispose = watchWindowDisplayNotch({
      window: harness.window,
      screen: harness.screen,
      platform: "linux",
      onChange: vi.fn(),
    });
    expect(harness.listenerCount()).toBe(0);
    dispose();
  });
});
