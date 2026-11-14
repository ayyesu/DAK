// @vitest-environment jsdom

import type { DesktopUpdateState } from "@dak/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

interface TestShell {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly runtime: null;
}

const testState = vi.hoisted(() => ({
  update: null as DesktopUpdateState | null,
  shells: [] as ReadonlyArray<TestShell>,
  shellsVersion: 0,
  shellsListeners: new Set<() => void>(),
  routedThreadId: null as string | null,
  // Stable, like the router's and the island's own, so a test cannot pass by identity accident.
  navigate: vi.fn(),
  island: {
    collapse: vi.fn(),
    end: vi.fn(),
    expand: vi.fn(),
    start: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
  useParams: () => ({ environmentId: "env-1", threadId: testState.routedThreadId ?? undefined }),
}));
vi.mock("~/state/entities", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    // The real hook is an atom subscription, so the stand-in must notify too: a
    // re-render of the tree alone would be blocked by React Compiler memoization.
    useThreadShells: () => {
      useSyncExternalStore(
        (listener) => {
          testState.shellsListeners.add(listener);
          return () => testState.shellsListeners.delete(listener);
        },
        () => testState.shellsVersion,
        () => testState.shellsVersion,
      );
      return testState.shells;
    },
  };
});
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/lib/island", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/island")>()),
  useIslandActions: () => testState.island,
}));
vi.mock("./GoalIslandActivity", () => ({ GoalIslandActivities: () => null }));
vi.mock("~/state/desktopUpdate", () => ({
  useDesktopUpdateState: () => testState.update,
}));

import { DakIslandController, DesktopUpdateNotice } from "./DakIslandController";

const ISLAND_NOTIFICATION_EVENT = "dak:island-notification";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

let renderer: ReactTestRenderer | undefined;
interface TestNotice {
  readonly tone: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly open: () => void } | null;
}

let notices: TestNotice[] = [];

const listener = (event: Event) => {
  notices.push((event as CustomEvent<(typeof notices)[number]>).detail);
};

beforeEach(() => {
  notices = [];
  testState.update = null;
  testState.shells = [];
  testState.shellsVersion = 0;
  testState.shellsListeners.clear();
  testState.routedThreadId = null;
  testState.island.start.mockClear();
  testState.island.update.mockClear();
  testState.island.end.mockClear();
  window.addEventListener(ISLAND_NOTIFICATION_EVENT, listener);
});

afterEach(async () => {
  window.removeEventListener(ISLAND_NOTIFICATION_EVENT, listener);
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});

async function render(next: DesktopUpdateState) {
  testState.update = next;
  await act(async () => {
    renderer = create(<DesktopUpdateNotice />);
  });
}

async function transition(next: DesktopUpdateState) {
  testState.update = next;
  await act(async () => {
    renderer?.update(<DesktopUpdateNotice />);
  });
}

it("does not interrupt for an update that was already there when the window opened", async () => {
  await render({ ...baseState, status: "available", availableVersion: "0.0.36" });
  expect(notices).toEqual([]);
});

it("announces a newly available update exactly once", async () => {
  await render({ ...baseState, status: "checking" });
  await transition({ ...baseState, status: "available", availableVersion: "0.0.36" });
  await transition({
    ...baseState,
    status: "available",
    availableVersion: "0.0.36",
    checkedAt: "2026-11-14T00:00:00.000Z",
  });

  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    tone: "warning",
    kind: "update",
    title: "DAK 0.0.36 available",
    body: "Download it from the update button in the sidebar.",
    action: { label: "Show update" },
  });
});

it("stays quiet while a download is in progress", async () => {
  await render({ ...baseState, status: "available", availableVersion: "0.0.36" });
  await transition({
    ...baseState,
    status: "downloading",
    availableVersion: "0.0.36",
    downloadPercent: 40,
  });
  await transition({
    ...baseState,
    status: "downloading",
    availableVersion: "0.0.36",
    downloadPercent: 80,
  });

  expect(notices).toEqual([]);
});

it("announces a finished download and points at the sidebar control", async () => {
  await render({ ...baseState, status: "downloading", availableVersion: "0.0.36" });
  await transition({
    ...baseState,
    status: "downloaded",
    availableVersion: "0.0.36",
    downloadedVersion: "0.0.36",
  });

  expect(notices).toHaveLength(1);
  expect(notices[0]?.tone).toBe("success");
  expect(notices[0]?.title).toBe("Update ready to install");
  expect(notices[0]?.body).toBe("Restart from the update button in the sidebar to install 0.0.36.");
  expect(notices[0]?.action?.label).toBe("Show restart");
});

it("announces a failure with the updater's own message", async () => {
  await render({ ...baseState, status: "downloading", availableVersion: "0.0.36" });
  await transition({
    ...baseState,
    status: "error",
    availableVersion: "0.0.36",
    message: "Download failed: network unreachable.",
    errorContext: "download",
    canRetry: true,
  });

  expect(notices).toHaveLength(1);
  expect(notices[0]?.tone).toBe("error");
  expect(notices[0]?.kind).toBe("update");
  expect(notices[0]?.body).toBe("Download failed: network unreachable.");
});

it("hands a pressed notice to the control that owns the flow", async () => {
  await render({ ...baseState, status: "checking" });
  await transition({ ...baseState, status: "available", availableVersion: "0.0.36" });

  const reveal = vi.fn();
  window.addEventListener("dak:reveal-update-control", reveal);
  notices[0]?.action?.open();
  window.removeEventListener("dak:reveal-update-control", reveal);

  expect(reveal).toHaveBeenCalledOnce();
});

const blockedShell = (
  id: string,
  title: string,
  kind: "approval" | "input" = "input",
): TestShell => ({
  environmentId: "env-1",
  id,
  title,
  hasPendingApprovals: kind === "approval",
  hasPendingUserInput: kind === "input",
  runtime: null,
});

// Emits the way the shells atom does: new snapshot, then subscribers notified.
const emitShells = async (shells: ReadonlyArray<TestShell>) => {
  testState.shells = shells;
  testState.shellsVersion += 1;
  await act(async () => {
    for (const listener of testState.shellsListeners) listener();
  });
};

it("gives each blocked thread its own activity instead of one queue", async () => {
  await act(async () => {
    renderer = create(<DakIslandController />);
  });
  await emitShells([
    blockedShell("a", "Review the diff", "approval"),
    blockedShell("b", "Which database?", "input"),
  ]);

  const started = testState.island.start.mock.calls.map(([options]) => options);
  expect(started.map((options) => options.id)).toEqual([
    "needs-input:env-1:a",
    "needs-input:env-1:b",
  ]);
  expect(started.map((options) => options.label)).toEqual([
    "Approval needed: Review the diff",
    "Input needed: Which database?",
  ]);
  // Work that was already waiting when the page opened is stated, not announced.
  expect(started.every((options) => options.alert === false)).toBe(true);
});

it("alerts only for a thread this client watched start waiting", async () => {
  const runningShell = (id: string, title: string): TestShell => ({
    ...blockedShell(id, title),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  });

  await act(async () => {
    renderer = create(<DakIslandController />);
  });
  await emitShells([runningShell("a", "Thread A")]);
  expect(testState.island.start).not.toHaveBeenCalled();

  await emitShells([blockedShell("a", "Thread A")]);
  expect(testState.island.start).toHaveBeenCalledTimes(1);
  expect(testState.island.start.mock.calls[0]?.[0].alert).toBe(true);
});

it("does not re-send an activity when shells re-emit unchanged", async () => {
  await act(async () => {
    renderer = create(<DakIslandController />);
  });
  await emitShells([blockedShell("a", "Thread A"), blockedShell("b", "Thread B")]);
  expect(testState.island.start).toHaveBeenCalledTimes(2);
  expect(testState.island.update).not.toHaveBeenCalled();

  // Every thread emission rebuilds each shell object; nothing the cards show changed.
  await emitShells([blockedShell("a", "Thread A"), blockedShell("b", "Thread B")]);
  expect(testState.island.update).not.toHaveBeenCalled();

  await emitShells([blockedShell("a", "Thread A renamed"), blockedShell("b", "Thread B")]);
  expect(testState.island.update.mock.calls.map(([id]) => id)).toEqual(["needs-input:env-1:a"]);
  // The card and the screen reader hear the new name, not just the pill's text.
  expect(testState.island.update.mock.calls[0]?.[1]).toMatchObject({
    label: "Input needed: Thread A renamed",
  });
});

it("keeps the thread already open out of the island", async () => {
  testState.routedThreadId = "a";
  await act(async () => {
    renderer = create(<DakIslandController />);
  });
  await emitShells([blockedShell("a", "Thread A"), blockedShell("b", "Thread B")]);

  expect(testState.island.start.mock.calls.map(([options]) => options.id)).toEqual([
    "needs-input:env-1:b",
  ]);
});

it("ends the activity exactly once when the blocked thread is opened", async () => {
  await act(async () => {
    renderer = create(<DakIslandController />);
  });
  await emitShells([blockedShell("a", "Thread A")]);
  expect(testState.island.start).toHaveBeenCalledTimes(1);

  testState.routedThreadId = "a";
  await emitShells([blockedShell("a", "Thread A")]);

  expect(testState.island.end.mock.calls).toEqual([["needs-input:env-1:a"]]);
});

it("ends only the thread that stopped waiting", async () => {
  await act(async () => {
    renderer = create(<DakIslandController />);
  });
  await emitShells([blockedShell("a", "Thread A"), blockedShell("b", "Thread B")]);
  await emitShells([blockedShell("b", "Thread B")]);

  expect(testState.island.end.mock.calls.map(([id]) => id)).toEqual(["needs-input:env-1:a"]);
});
