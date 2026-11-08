import { GoalId, ThreadId, type Goal, type GoalTask } from "@dak/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canCancelGoal,
  canEditGoal,
  canPauseGoal,
  canResumeGoal,
  canRetryGoal,
  currentGoalTask,
  formatGoalActivityTime,
  formatGoalTurnElapsed,
  getGoalSlashObjective,
  goalCriterionStates,
  goalHeadline,
  goalNeedsAttention,
  goalProgress,
  goalSlashPrefixLength,
  goalStatusLabel,
  goalStatusTone,
  goalVerificationStatusLabel,
  isGoalEnded,
  isGoalDriven,
  isGoalSlashCommand,
  isGoalSlashPrompt,
  isUsableGoalModelSelection,
  selectGoalForThread,
  selectGoalModelSelection,
  splitCriteriaLines,
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
  turnStartedAt: null,
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
    expect(selectGoalForThread([completed, paused], threadId)).toBeNull();
  });

  it("never shows a goal without a thread in a threadless view", () => {
    const running = goal({
      id: "running",
      status: "running",
      updatedAt: "2026-01-05T00:00:00.000Z",
    });
    expect(selectGoalForThread([running], null)).toBeNull();
  });

  it("returns null in a threadless view even when goals exist", () => {
    const older = goal({ id: "older", status: "completed", updatedAt: "2026-01-04T00:00:00.000Z" });
    const newer = goal({ id: "newer", status: "cancelled", updatedAt: "2026-01-05T00:00:00.000Z" });
    expect(selectGoalForThread([older, newer], null)).toBeNull();
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

  it("appends task progress on the headline once there is a plan", () => {
    const running = goal({
      id: "g",
      status: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tasks: [
        task({ id: "t1", title: "one", status: "completed" }),
        task({ id: "t2", title: "two", status: "in_progress" }),
      ],
    });
    expect(goalHeadline(running)).toBe("Working on: two · 1 of 2 tasks done");
  });

  it("omits the progress suffix for a single-task goal", () => {
    const running = goal({
      id: "g",
      status: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tasks: [task({ id: "t1", title: "only", status: "in_progress" })],
    });
    expect(goalHeadline(running)).toBe("Working on: only");
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

describe("formatGoalTurnElapsed", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");

  it("counts the in-flight turn's age", () => {
    expect(formatGoalTurnElapsed("2026-01-01T11:59:15.000Z", now)).toBe("45s");
    expect(formatGoalTurnElapsed("2026-01-01T11:58:55.000Z", now)).toBe("1m 05s");
    expect(formatGoalTurnElapsed("2026-01-01T10:56:00.000Z", now)).toBe("1h 04m");
  });

  it("never goes negative and ignores an unparseable timestamp", () => {
    expect(formatGoalTurnElapsed("2026-01-01T13:00:00.000Z", now)).toBe("0s");
    expect(formatGoalTurnElapsed("not a date", now)).toBe("");
  });
});

describe("goal control matrix", () => {
  it("pauses only the statuses the server's driver is working on", () => {
    expect(canPauseGoal("planning")).toBe(true);
    expect(canPauseGoal("running")).toBe(true);
    expect(canPauseGoal("verifying")).toBe(true);
    expect(canPauseGoal("paused")).toBe(false);
    expect(canPauseGoal("needs_input")).toBe(false);
    expect(canPauseGoal("blocked")).toBe(false);
    expect(canPauseGoal("completed")).toBe(false);
  });

  it("marks only driver-owned statuses as driven for the spinner and turn timer", () => {
    expect(isGoalDriven("planning")).toBe(true);
    expect(isGoalDriven("running")).toBe(true);
    expect(isGoalDriven("verifying")).toBe(true);
    expect(isGoalDriven("paused")).toBe(false);
    expect(isGoalDriven("needs_input")).toBe(false);
    expect(isGoalDriven("blocked")).toBe(false);
    expect(isGoalDriven("draft")).toBe(false);
    expect(isGoalDriven("completed")).toBe(false);
  });

  it("resumes every recoverable state, including failed and blocked", () => {
    expect(canResumeGoal("paused")).toBe(true);
    expect(canResumeGoal("blocked")).toBe(true);
    expect(canResumeGoal("failed")).toBe(true);
    expect(canResumeGoal("draft")).toBe(true);
    expect(canResumeGoal("running")).toBe(false);
    expect(canResumeGoal("completed")).toBe(false);
    expect(canResumeGoal("cancelled")).toBe(false);
  });

  it("gates edit, cancel and retry on the goal not having ended", () => {
    for (const status of ["planning", "running", "paused", "failed", "blocked", "draft"] as const) {
      expect(canEditGoal(status)).toBe(true);
      expect(canCancelGoal(status)).toBe(true);
      expect(canRetryGoal(status)).toBe(true);
      expect(isGoalEnded(status)).toBe(false);
    }
    for (const status of ["completed", "cancelled"] as const) {
      expect(canEditGoal(status)).toBe(false);
      expect(canCancelGoal(status)).toBe(false);
      expect(canRetryGoal(status)).toBe(false);
      expect(isGoalEnded(status)).toBe(true);
    }
  });
});

describe("goal slash command parsing", () => {
  it("enters goal mode only when `/goal ` starts the prompt", () => {
    expect(isGoalSlashPrompt("/goal Fix failing tests")).toBe(true);
    expect(isGoalSlashPrompt("/goal ")).toBe(true);
    expect(isGoalSlashPrompt("/goal")).toBe(false);
    expect(isGoalSlashPrompt("/Goal fix")).toBe(true);
    expect(isGoalSlashPrompt("Fix tests")).toBe(false);
  });

  it("strips the `/goal ` prefix for the objective", () => {
    expect(getGoalSlashObjective("/goal Fix failing CI checks")).toBe("Fix failing CI checks");
    expect(getGoalSlashObjective("/goal   ")).toBe("");
    expect(getGoalSlashObjective("Fix tests")).toBe("Fix tests");
    expect(goalSlashPrefixLength("/goal ok")).toBe(6);
  });

  it("keeps reserved subcommands out of goal mode", () => {
    for (const command of ["clear", "pause", "resume", "status"] as const) {
      expect(isGoalSlashCommand(`/goal ${command}`)).toBe(true);
      expect(isGoalSlashPrompt(`/goal ${command}`)).toBe(false);
      expect(getGoalSlashObjective(`/goal ${command}`)).toBe(`/goal ${command}`);
      expect(goalSlashPrefixLength(`/goal ${command}`)).toBe(0);
      // The commands are case-insensitive and match the trimmed remainder.
      expect(isGoalSlashCommand(`/Goal   ${command.toUpperCase()}   `)).toBe(true);
      expect(isGoalSlashPrompt(`/Goal   ${command.toUpperCase()}   `)).toBe(false);
    }
  });

  it("treats a longer sentence after a reserved word as an objective", () => {
    expect(isGoalSlashCommand("/goal clear")).toBe(true);
    expect(isGoalSlashPrompt("/goal clear the backlog")).toBe(true);
    expect(getGoalSlashObjective("/goal clear the backlog")).toBe("clear the backlog");
    expect(goalSlashPrefixLength("/goal clear the backlog")).toBe(6);
    expect(isGoalSlashCommand("clear")).toBe(false);
    expect(isGoalSlashCommand("/goal")).toBe(false);
    expect(isGoalSlashCommand("/goal ")).toBe(false);
  });

  it("rejects the no-provider placeholder with an empty model", () => {
    expect(isUsableGoalModelSelection({ model: "" })).toBe(false);
    expect(isUsableGoalModelSelection({ model: "   " })).toBe(false);
    expect(isUsableGoalModelSelection({ model: "gpt-5" })).toBe(true);
    expect(isUsableGoalModelSelection(null)).toBe(false);
    expect(isUsableGoalModelSelection(undefined)).toBe(false);
  });

  it("prefers the composer selection over the thread placeholder", () => {
    const composer = { instanceId: "opencode", model: "crouton-alpha-free" };
    const placeholder = { instanceId: "dak_no_provider", model: "" };
    const projectDefault = { instanceId: "opencode", model: "default-model" };
    expect(selectGoalModelSelection([composer, null, placeholder, projectDefault])).toBe(composer);
    expect(selectGoalModelSelection([placeholder, null, projectDefault])).toBe(projectDefault);
    expect(selectGoalModelSelection([placeholder, null])).toBeNull();
  });
});

describe("splitCriteriaLines", () => {
  it("trims lines and drops the blank ones", () => {
    expect(splitCriteriaLines("  Ships on mobile  \n\n\nPersists after reload\n")).toEqual([
      "Ships on mobile",
      "Persists after reload",
    ]);
  });

  it("caps each criterion at the schema's length limit", () => {
    const [criterion] = splitCriteriaLines("x".repeat(600));
    expect(criterion).toHaveLength(500);
  });

  it("keeps at most twenty criteria", () => {
    const lines = Array.from({ length: 25 }, (_, index) => `criterion ${index}`);
    expect(splitCriteriaLines(lines.join("\n"))).toHaveLength(20);
  });
});

describe("goalVerificationStatusLabel", () => {
  it("reads as a sentence rather than the raw enum", () => {
    expect(goalVerificationStatusLabel("pending")).toBe("Not checked yet");
    expect(goalVerificationStatusLabel("passed")).toBe("Verified");
    expect(goalVerificationStatusLabel("failed")).toBe("Did not pass");
  });
});

describe("goalCriterionStates", () => {
  it("stays unchecked while no verification pass has judged the criteria", () => {
    const states = goalCriterionStates(
      goal({
        id: "g",
        status: "running",
        updatedAt: "2026-01-01T00:00:00.000Z",
        acceptanceCriteria: ["Persists after reload"],
      }),
    );
    expect(states).toEqual([{ criterion: "Persists after reload", met: null }]);
  });

  it("maps verification verdicts back onto the acceptance criteria", () => {
    const states = goalCriterionStates(
      goal({
        id: "g",
        status: "completed",
        updatedAt: "2026-01-01T00:00:00.000Z",
        acceptanceCriteria: ["Persists after reload", "Loads under a second"],
        verification: {
          status: "failed",
          summary: "One criterion missed",
          checkedAt: "2026-01-01T00:00:00.000Z",
          criteria: [
            { criterion: "Persists after reload", met: true },
            { criterion: "Loads under a second", met: false },
          ],
        },
      }),
    );
    expect(states).toEqual([
      { criterion: "Persists after reload", met: true },
      { criterion: "Loads under a second", met: false },
    ]);
  });

  it("leaves criteria the check never mentioned as unchecked", () => {
    const states = goalCriterionStates(
      goal({
        id: "g",
        status: "completed",
        updatedAt: "2026-01-01T00:00:00.000Z",
        acceptanceCriteria: ["Checked", "Never judged"],
        verification: {
          status: "passed",
          summary: null,
          checkedAt: "2026-01-01T00:00:00.000Z",
          criteria: [{ criterion: "Checked", met: true }],
        },
      }),
    );
    expect(states).toEqual([
      { criterion: "Checked", met: true },
      { criterion: "Never judged", met: null },
    ]);
  });
});
