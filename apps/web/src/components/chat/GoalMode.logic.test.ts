import { GoalId, ThreadId, type Goal, type GoalTask } from "@dak/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  currentGoalTask,
  formatGoalActivityTime,
  goalHeadline,
  goalNeedsAttention,
  goalProgress,
  goalStatusLabel,
  goalStatusTone,
  selectGoalForThread,
} from "./GoalMode.logic";

function task(overrides: Partial<GoalTask> & Pick<GoalTask, "id" | "title">): GoalTask {
  return {
    detail: null,
    status: "pending",
    order: Number(overrides.id.replace(/\D/g, "")) || 0,
    startedAt: null,
    completedAt: null,
    evidence: null,
    attempts: 0,
    ...overrides,
  };
}

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
  completedAt: null,
  createdBy: "user",
  creationSource: "web",
};

function goal(
  overrides: Omit<Partial<Goal>, "id"> &
    Pick<Goal, "status" | "updatedAt"> & { readonly id: string },
): Goal {
  return {
    ...baseGoal,
    ...overrides,
    id: GoalId.make(overrides.id),
  };
}

describe("goalProgress", () => {
  it("counts only completed tasks and rounds the percentage down to a whole number", () => {
    const progress = goalProgress({
      tasks: [
        task({ id: "t1", title: "one", status: "completed" }),
        task({ id: "t2", title: "two", status: "completed" }),
        task({ id: "t3", title: "three", status: "in_progress" }),
      ],
    });
    expect(progress).toEqual({ completed: 2, total: 3, percent: 67 });
  });

  it("reports an empty plan as zero without dividing by zero", () => {
    expect(goalProgress({ tasks: [] })).toEqual({ completed: 0, total: 0, percent: 0 });
  });
});

describe("selectGoalForThread", () => {
  const threadId = ThreadId.make("thread:1");

  it("prefers an active goal bound to the current thread", () => {
    const bound = goal({
      id: "bound",
      status: "running",
      threadId,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = goal({
      id: "other",
      status: "running",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(selectGoalForThread([newer, bound], threadId)?.id).toBe("bound");
  });

  it("falls back to the most recent goal of this thread even when it ended", () => {
    const finished = goal({
      id: "finished",
      status: "completed",
      threadId,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const otherActive = goal({
      id: "other",
      status: "running",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(selectGoalForThread([otherActive, finished], threadId)?.id).toBe("finished");
  });

  it("shows the project's active goal when this thread has none", () => {
    const paused = goal({
      id: "paused",
      status: "paused",
      updatedAt: "2026-01-04T00:00:00.000Z",
    });
    const completed = goal({
      id: "completed",
      status: "completed",
      updatedAt: "2026-01-05T00:00:00.000Z",
    });
    expect(selectGoalForThread([completed, paused], threadId)?.id).toBe("paused");
  });

  it("returns the latest goal when everything has ended", () => {
    const older = goal({ id: "older", status: "completed", updatedAt: "2026-01-04T00:00:00.000Z" });
    const newer = goal({ id: "newer", status: "cancelled", updatedAt: "2026-01-05T00:00:00.000Z" });
    expect(selectGoalForThread([older, newer], null)?.id).toBe("newer");
  });

  it("returns null with no goals", () => {
    expect(selectGoalForThread([], threadId)).toBeNull();
  });
});

describe("goal status presentation", () => {
  it("labels and tones every status", () => {
    expect(goalStatusLabel("needs_input")).toBe("Needs input");
    expect(goalStatusTone("needs_input")).toBe("attention");
    expect(goalStatusTone("running")).toBe("active");
    expect(goalStatusTone("completed")).toBe("success");
    expect(goalStatusTone("failed")).toBe("danger");
    expect(goalStatusTone("cancelled")).toBe("muted");
  });

  it("flags the statuses that want the user", () => {
    expect(goalNeedsAttention("needs_input")).toBe(true);
    expect(goalNeedsAttention("blocked")).toBe(true);
    expect(goalNeedsAttention("running")).toBe(false);
    expect(goalNeedsAttention("completed")).toBe(false);
  });

  it("names the current task while running", () => {
    const running = goal({
      id: "g",
      status: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tasks: [task({ id: "t1", title: "Build the API", status: "in_progress" })],
    });
    expect(goalHeadline(running)).toBe("Working on: Build the API");
  });

  it("surfaces the blocking reason", () => {
    const blocked = goal({
      id: "g",
      status: "blocked",
      blockedReason: "The database is unreachable.",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(goalHeadline(blocked)).toBe("The database is unreachable.");
  });
});

describe("currentGoalTask", () => {
  it("prefers the task that is executing over a stale current id", () => {
    const running = goal({
      id: "g",
      status: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
      currentTaskId: "t1",
      tasks: [
        task({ id: "t1", title: "one", status: "completed" }),
        task({ id: "t2", title: "two", status: "in_progress" }),
      ],
    });
    expect(currentGoalTask(running)?.id).toBe("t2");
  });
});

describe("formatGoalActivityTime", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");

  it("formats recent and older timestamps", () => {
    expect(formatGoalActivityTime("2026-01-01T11:59:50.000Z", now)).toBe("just now");
    expect(formatGoalActivityTime("2026-01-01T11:45:00.000Z", now)).toBe("15m ago");
    expect(formatGoalActivityTime("2026-01-01T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatGoalActivityTime("2025-12-29T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("ignores an unparseable timestamp", () => {
    expect(formatGoalActivityTime("not a date", now)).toBe("");
  });
});
