import { GoalId, type Goal } from "@dak/contracts";
import { describe, expect, it } from "vite-plus/test";

import { advanceGoalNotice, goalNotification } from "./ThreadNotificationCoordinator.logic";

const baseGoal: Omit<Goal, "id" | "status" | "updatedAt"> = {
  projectId: "project:1" as Goal["projectId"],
  threadId: null,
  title: "A goal",
  objective: "Do the thing",
  acceptanceCriteria: [],
  tasks: [],
  activities: [],
  currentTaskId: null,
  modelSelection: {} as Goal["modelSelection"],
  runtimeMode: "auto",
  interactionMode: "default",
  revision: 1,
  cycleCount: 0,
  verification: { status: "pending", summary: null, checkedAt: null },
  blockedReason: null,
  failureReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  turnStartedAt: null,
  completedAt: null,
  createdBy: "user",
  creationSource: "web",
};

function goal(
  overrides: Omit<Partial<Goal>, "id"> & Pick<Goal, "status"> & { readonly id: string },
): Goal {
  return {
    ...baseGoal,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    id: GoalId.make(overrides.id),
  };
}

describe("goalNotification", () => {
  it("fires attention when the goal starts asking", () => {
    const prior = advanceGoalNotice(goal({ id: "goal:1", status: "running" }));
    expect(prior.attention).toBeNull();

    const next = advanceGoalNotice(goal({ id: "goal:1", status: "needs_input" }));
    expect(goalNotification(prior, next)).toBe("attention");
  });

  it("stays quiet while the same ask repeats", () => {
    const prior = advanceGoalNotice(goal({ id: "goal:1", status: "needs_input" }));
    const next = advanceGoalNotice(goal({ id: "goal:1", status: "needs_input" }));

    expect(goalNotification(prior, next)).toBeNull();
  });

  it("fires again when the ask changes kind", () => {
    const prior = advanceGoalNotice(goal({ id: "goal:1", status: "needs_input" }));
    const next = advanceGoalNotice(goal({ id: "goal:1", status: "failed" }));

    expect(goalNotification(prior, next)).toBe("attention");
  });

  it("fires completion once for the same finished timestamp", () => {
    const finished = { completedAt: "2026-01-01T01:00:00.000Z" };
    const prior = advanceGoalNotice(goal({ id: "goal:1", status: "running" }));
    const next = advanceGoalNotice(goal({ id: "goal:1", status: "completed", ...finished }));
    expect(goalNotification(prior, next)).toBe("completion");

    const rescanned = advanceGoalNotice(goal({ id: "goal:1", status: "completed", ...finished }));
    expect(goalNotification(next, rescanned)).toBeNull();
  });

  it("falls back to the update time when a finished goal has no completion stamp", () => {
    const prior = advanceGoalNotice(goal({ id: "goal:1", status: "running" }));
    const next = advanceGoalNotice(
      goal({ id: "goal:1", status: "completed", updatedAt: "2026-01-01T01:00:00.000Z" }),
    );

    expect(goalNotification(prior, next)).toBe("completion");
  });

  it("ignores a completion stamp on a goal that has not finished", () => {
    const prior = advanceGoalNotice(goal({ id: "goal:1", status: "running" }));
    const next = advanceGoalNotice(
      goal({ id: "goal:1", status: "running", completedAt: "2026-01-01T01:00:00.000Z" }),
    );

    expect(goalNotification(prior, next)).toBeNull();
  });

  it("quiets once the goal leaves an attention status", () => {
    const prior = advanceGoalNotice(goal({ id: "goal:1", status: "blocked" }));
    const next = advanceGoalNotice(goal({ id: "goal:1", status: "paused" }));

    expect(goalNotification(prior, next)).toBeNull();
    expect(next.attention).toBeNull();
  });
});
