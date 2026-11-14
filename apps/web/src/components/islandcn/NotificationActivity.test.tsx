// @vitest-environment jsdom

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  activities: [] as ReadonlyArray<{ readonly id: string }>,
  activitiesVersion: 0,
  activitiesListeners: new Set<() => void>(),
  island: {
    start: vi.fn(),
    update: vi.fn(),
    end: vi.fn(),
  },
}));

vi.mock("~/lib/island", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  // Stable, like the store's own API: the notice's timers depend on its identity.
  const island = {
    get activities() {
      return testState.activities;
    },
    start: testState.island.start,
    update: testState.island.update,
    end: testState.island.end,
  };
  return {
    ...(await importOriginal<typeof import("~/lib/island")>()),
    useIsland: () => {
      useSyncExternalStore(
        (listener) => {
          testState.activitiesListeners.add(listener);
          return () => testState.activitiesListeners.delete(listener);
        },
        () => testState.activitiesVersion,
        () => testState.activitiesVersion,
      );
      return island;
    },
  };
});

import { IslandNotificationActivity, showIslandNotification } from "./NotificationActivity";

const NOTIFICATION_ID = "dak-notification";

let renderer: ReactTestRenderer | undefined;

/** Moves the island's front slot the way the store re-sorts after start/end. */
const setFrontActivity = async (id: string | null) => {
  testState.activities = id === null ? [] : [{ id }];
  testState.activitiesVersion += 1;
  await act(async () => {
    for (const listener of testState.activitiesListeners) listener();
  });
};

const showNotice = () => {
  act(() => {
    showIslandNotification({
      tone: "success",
      kind: "completion",
      title: "Thread finished",
      body: "Review the diff.",
      action: null,
    });
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  testState.activities = [];
  testState.activitiesVersion = 0;
  testState.activitiesListeners.clear();
  testState.island.start.mockClear();
  testState.island.update.mockClear();
  testState.island.end.mockClear();
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
});

it("holds its clock while a higher-priority activity keeps it off screen", async () => {
  // A blocked thread owns the island; the notice arrives behind it.
  await setFrontActivity("needs-input:env-1:a");
  await act(async () => {
    renderer = create(<IslandNotificationActivity />);
  });
  showNotice();
  expect(testState.island.start).toHaveBeenCalledTimes(1);

  // The whole TTL passes while it waits; news the user never saw is never spent.
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(testState.island.end).not.toHaveBeenCalled();

  // The thread is answered; on screen the notice gets a full TTL.
  await setFrontActivity(NOTIFICATION_ID);
  act(() => {
    vi.advanceTimersByTime(6_400);
  });
  expect(testState.island.end).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(testState.island.end).toHaveBeenCalledWith(NOTIFICATION_ID);
});

it("stops the clock while displaced and grants the full time when it returns", async () => {
  await act(async () => {
    renderer = create(<IslandNotificationActivity />);
  });
  showNotice();
  // The store moves a fresh notice to the front; now it is on screen and ticking.
  await setFrontActivity(NOTIFICATION_ID);
  expect(testState.island.start).toHaveBeenCalledTimes(1);
  act(() => {
    vi.advanceTimersByTime(3_000);
  });

  // A blocked thread displaces it; the leftover time must not keep ticking.
  await setFrontActivity("needs-input:env-1:a");
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(testState.island.end).not.toHaveBeenCalled();

  // Back on screen: the full TTL, not the 3.5s left before it was pushed aside.
  await setFrontActivity(NOTIFICATION_ID);
  act(() => {
    vi.advanceTimersByTime(6_400);
  });
  expect(testState.island.end).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(testState.island.end).toHaveBeenCalledWith(NOTIFICATION_ID);
});

/** The handler an activity's start or update carries for the notice's body tap. */
const currentOnPress = (target: unknown): (() => void) | undefined =>
  (target as { onPress?: () => void } | undefined)?.onPress;

it("does not run the replaced notice's action when the new notice has none", async () => {
  await act(async () => {
    renderer = create(<IslandNotificationActivity />);
  });
  const open = vi.fn();
  act(() => {
    showIslandNotification({
      tone: "success",
      kind: "completion",
      title: "Thread finished",
      body: "Review the diff.",
      action: { label: "Open", open },
    });
  });
  expect(testState.island.start).toHaveBeenCalledTimes(1);

  // A notice with nowhere to go replaces it. The island keeps the old handler when an update
  // omits `onPress`, so the component must hand over one that runs nothing.
  act(() => {
    showIslandNotification({
      tone: "warning",
      kind: "input",
      title: "Needs input",
      body: "Answer to continue.",
      action: null,
    });
  });
  expect(testState.island.update).toHaveBeenCalledTimes(1);
  const onPress = currentOnPress(testState.island.update.mock.calls[0]?.[1]);
  expect(onPress).toBeTypeOf("function");
  onPress?.();
  expect(open).not.toHaveBeenCalled();
});

it("leaves the body tap unbound when the notice offers two choices", async () => {
  await act(async () => {
    renderer = create(<IslandNotificationActivity />);
  });
  act(() => {
    showIslandNotification({
      tone: "warning",
      kind: "update",
      title: "OpenCode v2.4.7 available",
      body: "Install the update now or review provider settings.",
      action: { label: "Update", open: vi.fn(), keepOpen: true },
      secondaryAction: { label: "Settings", open: vi.fn() },
    });
  });
  // Tapping the island expands it; it must not also press the primary action.
  expect(currentOnPress(testState.island.start.mock.calls[0]?.[0])).toBeUndefined();
});

it("keeps the island open for an action that starts work and ends it for one that does not", async () => {
  await act(async () => {
    renderer = create(<IslandNotificationActivity />);
  });
  const startWork = vi.fn();
  act(() => {
    showIslandNotification({
      tone: "warning",
      kind: "update",
      title: "OpenCode v2.4.7 available",
      body: "Install the update now or review provider settings.",
      action: { label: "Update", open: startWork, keepOpen: true },
    });
  });
  const keepOpenPress = currentOnPress(testState.island.start.mock.calls[0]?.[0]);
  expect(keepOpenPress).toBeTypeOf("function");
  keepOpenPress?.();
  expect(startWork).toHaveBeenCalled();
  expect(testState.island.end).not.toHaveBeenCalled();

  // A plain single-action notice still dismisses itself when pressed.
  const open = vi.fn();
  act(() => {
    showIslandNotification({
      tone: "success",
      kind: "completion",
      title: "Thread finished",
      body: "Review the diff.",
      action: { label: "Open", open },
    });
  });
  const onPress = currentOnPress(testState.island.update.mock.calls.at(-1)?.[1]);
  expect(onPress).toBeTypeOf("function");
  onPress?.();
  expect(open).toHaveBeenCalled();
  expect(testState.island.end).toHaveBeenCalledWith(NOTIFICATION_ID);
});
