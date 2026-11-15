import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { GoalSummary } from "@dak/contracts";
import type { IslandCopyStorage } from "./islandCopy.logic";
import {
  ISLAND_COPY_TIMEOUT_MS,
  buildIslandCopySubject,
  createIslandCopyGate,
  isIslandCopyRequestCurrent,
  isUnsupportedIslandError,
  islandCopyKey,
  validateIslandCopy,
} from "./islandCopy.logic";

const goal = (
  overrides: Partial<GoalSummary> & Pick<GoalSummary, "status">,
): Parameters<typeof buildIslandCopySubject>[0] => ({
  title: "Fix the login form",
  currentTaskTitle: "Wire the submit handler",
  question: null,
  failureReason: null,
  ...overrides,
});

describe("buildIslandCopySubject", () => {
  it("never builds a subject for waiting_provider, even with facts on offer", () => {
    expect(
      buildIslandCopySubject(
        goal({ status: "waiting_provider", waitingReason: "Free usage limit reached." }),
      ),
    ).toBeNull();
    expect(buildIslandCopySubject(goal({ status: "paused" }))).toBeNull();
    expect(buildIslandCopySubject(goal({ status: "planning" }))).toBeNull();
    expect(buildIslandCopySubject(goal({ status: "draft" }))).toBeNull();
    expect(buildIslandCopySubject(goal({ status: "completed" }))).toBeNull();
    expect(buildIslandCopySubject(goal({ status: "cancelled" }))).toBeNull();
  });

  it("keeps only semantic facts, with the caps applied before the wire", () => {
    const tabs = "q".repeat(700);
    const subject = buildIslandCopySubject(
      goal({ status: "needs_input", question: `why\ndo this   ${tabs}` }),
    );
    expect(subject).toMatchObject({ _tag: "goal", status: "needs_input" });
    expect(subject?.question).toHaveLength(600);
    // Whitespace (including newlines) collapses to single spaces.
    expect(subject?.question).not.toContain("\n");
    expect(subject?.question).not.toContain("  ");
  });

  it("maps a failed goal's failure reason into error", () => {
    const subject = buildIslandCopySubject(
      goal({ status: "failed", failureReason: "the migration failed at step 3" }),
    );
    expect(subject).toMatchObject({ status: "failed", error: "the migration failed at step 3" });
  });

  it("keys identically across progress ticks and task-count changes", () => {
    const base = goal({ status: "running", progress: 10, completedTaskCount: 1 });
    const tick = goal({ status: "running", progress: 80, completedTaskCount: 7 });
    const a = buildIslandCopySubject(base);
    const b = buildIslandCopySubject(tick);
    expect(islandCopyKey(a!)).toBe(islandCopyKey(b!));
    const changed = buildIslandCopySubject(goal({ status: "recovering" }));
    expect(islandCopyKey(a!)).not.toBe(islandCopyKey(changed!));
  });
});

describe("validateIslandCopy", () => {
  it("accepts calm copy and normalises whitespace", () => {
    expect(
      validateIslandCopy({ detail: "Working on the  login\nform ", compact: "Working" }),
    ).toEqual({
      detail: "Working on the login form",
      compact: "Working",
    });
  });

  it("rejects empty, over-cap, control or markdown output", () => {
    expect(validateIslandCopy({ detail: "   ", compact: "Reply" })).toBeNull();
    expect(validateIslandCopy({ detail: "x".repeat(91), compact: "Reply" })).toBeNull();
    expect(validateIslandCopy({ detail: "Working", compact: "x".repeat(13) })).toBeNull();
    expect(
      validateIslandCopy({ detail: "Working on it now\u0007", compact: "Working" }),
    ).toBeNull();
    expect(validateIslandCopy({ detail: "Working **now**", compact: "Working" })).toBeNull();
    expect(validateIslandCopy({ detail: `He said "do it"`, compact: "Reply" })).toBeNull();
    expect(validateIslandCopy({ detail: "Run `vp test`", compact: "Working" })).toBeNull();
    expect(validateIslandCopy(null)).toBeNull();
    expect(validateIslandCopy({ compact: "Working" })).toBeNull();
  });
});

describe("isIslandCopyRequestCurrent", () => {
  it("discards answers that arrive after the timeout", () => {
    expect(isIslandCopyRequestCurrent("k", "k", ISLAND_COPY_TIMEOUT_MS)).toBe(true);
    expect(isIslandCopyRequestCurrent("k", "k", ISLAND_COPY_TIMEOUT_MS + 1)).toBe(false);
  });

  it("discards answers for a stale subject", () => {
    expect(isIslandCopyRequestCurrent("k", "other", 10)).toBe(false);
    expect(isIslandCopyRequestCurrent("k", null, 10)).toBe(false);
  });
});

describe("isUnsupportedIslandError", () => {
  it("matches ACP's no-text-generation failure and nothing else", () => {
    expect(
      isUnsupportedIslandError({
        _tag: "TextGenerationError",
        operation: "generateIslandCopy",
        detail: "ACP Registry instances do not provide application text generation.",
      }),
    ).toBe(true);
    expect(
      isUnsupportedIslandError({
        _tag: "TextGenerationError",
        operation: "generateIslandCopy",
        detail: "The selected model is over quota.",
      }),
    ).toBe(false);
    expect(isUnsupportedIslandError({ _tag: "EnvironmentAuthorizationError" })).toBe(false);
    expect(isUnsupportedIslandError(null)).toBe(false);
  });
});

const makeStorage = (): IslandCopyStorage => {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
};

let now = 1_000_000;

describe("createIslandCopyGate", () => {
  beforeEach(() => {
    now = 1_000_000;
  });
  const ok = {
    scope: "goal-1",
    online: true,
    smartText: true,
    modelFingerprint: "fp-a",
  };
  const gate = (storage: IslandCopyStorage | null = null) =>
    createIslandCopyGate({ now: () => now, storage });

  it("makes no call when the setting is off or the client is offline", () => {
    const g = gate();
    expect(g.decision({ ...ok, smartText: false })).toEqual({ skip: "setting-off" });
    expect(g.decision({ ...ok, online: false })).toEqual({ skip: "offline" });
  });

  it("allows one in flight and rate-limits to one call per 20 seconds per goal", () => {
    const g = gate();
    g.start("goal-1");
    expect(g.decision(ok)).toEqual({ skip: "inflight" });
    g.settle();
    expect(g.decision(ok)).toEqual({ skip: "rate-limited" });
    now += 19_999;
    expect(g.decision(ok)).toEqual({ skip: "rate-limited" });
    now += 1;
    expect(g.decision(ok)).toBe(true);
    expect(g.decision({ ...ok, scope: "goal-2" })).toBe(true);
  });

  it("opens the breaker after two failures and closes it after the window", () => {
    const g = gate();
    g.fail("failure");
    expect(g.decision(ok)).toBe(true); // one failure is not enough
    g.start("goal-1");
    g.settle();
    g.fail("failure");
    expect(g.decision(ok)).toEqual({ skip: "breaker-open" });
    now += 10 * 60 * 1000 + 1;
    expect(g.decision(ok)).toBe(true);
  });

  it("backs the breaker off by doubling, capped at an hour", () => {
    const g = gate();
    const windows: number[] = [];
    for (const expectedMinutes of [10, 20, 40, 60, 60]) {
      g.fail("failure");
      g.start("goal-1");
      g.settle();
      g.fail("failure");
      windows.push((g.breakerState().disabledUntil - now) / 60_000);
      expect(windows.at(-1)).toBe(expectedMinutes);
      now += windows.at(-1)! * 60_000 + 1;
    }
  });

  it("resets the breaker on success", () => {
    const g = gate();
    g.fail("failure");
    g.start("goal-1");
    g.settle();
    g.fail("failure");
    expect(g.decision(ok)).toEqual({ skip: "breaker-open" });
    now += 10 * 60 * 1000 + 1;
    g.start("goal-1");
    g.settle();
    g.succeed("key", { detail: "Working on the login form", compact: "Working" });
    expect(g.breakerState()).toMatchObject({
      consecutiveFailures: 0,
      disabledUntil: 0,
      backoffMs: 10 * 60 * 1000,
    });
  });

  it("latches unsupported providers until the model selection changes", () => {
    const g = gate();
    g.fail("unsupported", "fp-a");
    expect(g.decision(ok)).toEqual({ skip: "unsupported" });
    expect(g.decision({ ...ok, modelFingerprint: "fp-b" })).toBe(true);
    // The latch cleared when the fingerprint changed; it does not stick for the old one either.
    expect(g.decision(ok)).toBe(true);
  });

  it("persists the LRU across instances and prunes at 7 days", () => {
    const storage = makeStorage();
    const g1 = createIslandCopyGate({ now: () => now, storage });
    g1.succeed("key-1", { detail: "Working on the login form", compact: "Working" });
    const g2 = createIslandCopyGate({ now: () => now, storage });
    expect(g2.cached("key-1")).toEqual({ detail: "Working on the login form", compact: "Working" });
    now += 8 * 24 * 60 * 60 * 1000;
    const g3 = createIslandCopyGate({ now: () => now, storage });
    expect(g3.cached("key-1")).toBeUndefined();
  });

  it("caps the persisted LRU at 100 entries", () => {
    const storage = makeStorage();
    const g = createIslandCopyGate({ now: () => now, storage });
    for (let index = 0; index < 150; index += 1) {
      g.succeed(`key-${index}`, { detail: `working on task ${index}`, compact: "Working" });
    }
    expect(g.cached("key-0")).toBeUndefined();
    expect(g.cached("key-149")).toBeDefined();
    expect(JSON.parse(storage.getItem("dak:island-copy:v1")!)).toHaveLength(100);
  });
});
