import { GoalId, ThreadId, type Goal, type GoalSummary, type GoalTask } from "@dak/contracts";
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
  goalDeliveryNotice,
  goalDrivesThread,
  goalHasOpenQuestion,
  goalIslandActionLabel,
  goalIslandHeadline,
  goalNeedsIslandAttention,
  goalOccupiesThread,
  goalHeadline,
  goalMetaLine,
  goalNeedsAttention,
  goalNoticeTitle,
  goalObjectiveText,
  goalProgress,
  goalProgressLabel,
  goalSendLabel,
  goalSlashPrefixLength,
  goalSummaryHeadline,
  goalSummaryProgress,
  goalStatusLabel,
  goalStatusTone,
  goalTaskStatusLabel,
  goalVerificationStatusLabel,
  goalWaitingTask,
  isGoalActive,
  isGoalEnded,
  isGoalDriven,
  isGoalIslandVisible,
  isGoalSlashCommand,
  isGoalSlashPrompt,
  isUsableGoalModelSelection,
  selectGoalForThread,
  selectGoalModelSelection,
  splitCriteriaLines,
  type GoalProgress,
} from "./GoalMode.logic";

function task(overrides: Partial<GoalTask> & Pick<GoalTask, "id" | "title">): GoalTask {
  return {
    detail: null,
    status: "pending",
    order: Number(overrides.id.replace(/\D/g, "")) || 0,
    startedAt: null,
    completedAt: null,
    evidence: null,
    question: null,
    blocker: null,
    attempts: 0,
    dependsOn: [],
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
  waitingReason: null,
  failureReason: null,
  question: null,
  questionTaskId: null,
  progress: null,
  progressLabel: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  turnStartedAt: null,
  completedAt: null,
  createdBy: "user",
  creationSource: "web",
};

const baseSummary: Pick<GoalSummary, "currentTaskTitle" | "completedTaskCount" | "totalTaskCount"> =
  {
    currentTaskTitle: null,
    completedTaskCount: 0,
    totalTaskCount: 0,
  };

function goal(
  overrides: Omit<Partial<Goal & GoalSummary>, "id"> &
    Pick<Goal, "status"> & { readonly id: string },
): Goal & GoalSummary {
  return {
    ...baseGoal,
    ...baseSummary,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    id: GoalId.make(overrides.id),
  };
}

describe("goalProgress", () => {
  const unchecked = { status: "pending", summary: null, checkedAt: null } as const;

  it("counts only completed tasks and reserves the last unit for verification", () => {
    const progress = goalProgress({
      tasks: [
        task({ id: "t1", title: "one", status: "completed" }),
        task({ id: "t2", title: "two", status: "completed" }),
        task({ id: "d3", title: "three", status: "in_progress" }),
      ],
      verification: unchecked,
    });
    expect(progress).toEqual({
      completed: 2,
      total: 4,
      percent: 50,
      tasksCompleted: 2,
      tasksTotal: 3,
      verified: false,
      agentProgress: null,
      agentProgressLabel: null,
    });
  });

  it("never reads 100% until verification passes", () => {
    const tasks = [
      task({ id: "t1", title: "one", status: "completed" }),
      task({ id: "t2", title: "two", status: "completed" }),
    ];
    const failed = goalProgress({
      tasks,
      verification: {
        status: "failed",
        summary: "One criterion missed",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(failed.percent).toBeLessThan(100);
    expect(failed.verified).toBe(false);
    expect(goalProgress({ tasks, verification: unchecked }).percent).toBeLessThan(100);

    const passed = goalProgress({
      tasks,
      verification: { status: "passed", summary: null, checkedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(passed.percent).toBe(100);
    expect(passed.verified).toBe(true);
  });

  it("reports an empty plan as zero without dividing by zero", () => {
    expect(goalProgress({ tasks: [], verification: unchecked })).toEqual({
      completed: 0,
      total: 0,
      percent: 0,
      tasksCompleted: 0,
      tasksTotal: 0,
      verified: false,
      agentProgress: null,
      agentProgressLabel: null,
    });
  });
});

describe("goalProgressLabel", () => {
  const progress = (overrides: Partial<GoalProgress>): GoalProgress => ({
    completed: 0,
    total: 0,
    percent: 0,
    tasksCompleted: 0,
    tasksTotal: 0,
    verified: false,
    agentProgress: null,
    agentProgressLabel: null,
    ...overrides,
  });

  it("says what is left instead of claiming a finished task", () => {
    expect(goalProgressLabel(progress({ tasksCompleted: 1, tasksTotal: 3 }))).toBe("1 of 3 tasks");
    expect(
      goalProgressLabel(progress({ tasksCompleted: 3, tasksTotal: 3, completed: 3, total: 4 })),
    ).toBe("3 of 3 tasks · awaiting verification");
    expect(
      goalProgressLabel(
        progress({ tasksCompleted: 3, tasksTotal: 3, completed: 4, total: 4, verified: true }),
      ),
    ).toBe("3 of 3 tasks · verified");
    expect(goalProgressLabel(progress({}))).toBe("No plan yet");
    expect(goalProgressLabel(progress({ tasksCompleted: 0, tasksTotal: 1 }))).toBe("0 of 1 task");
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

describe("goalDrivesThread", () => {
  const threadId = ThreadId.make("thread:1");

  it("reports a driven goal bound to this thread", () => {
    const running = goal({ id: "running", status: "running", threadId });
    expect(goalDrivesThread([running], threadId)).toBe(true);
  });

  it("counts every status where the server still dispatches turns", () => {
    for (const status of ["planning", "running", "recovering", "verifying"] as const) {
      expect(goalDrivesThread([goal({ id: status, status, threadId })], threadId)).toBe(true);
    }
  });

  it("ignores a goal of another thread", () => {
    const elsewhere = goal({ id: "elsewhere", status: "running", threadId: null });
    expect(goalDrivesThread([elsewhere], threadId)).toBe(false);
  });

  it("ignores a goal of this thread that is not driven", () => {
    const paused = goal({ id: "paused", status: "paused", threadId });
    expect(goalDrivesThread([paused], threadId)).toBe(false);
  });

  it("has nothing to drive in a threadless view", () => {
    const running = goal({ id: "running", status: "running", threadId });
    expect(goalDrivesThread([running], null)).toBe(false);
  });
});

describe("goalOccupiesThread", () => {
  const threadId = ThreadId.make("thread:1");

  it("reports a thread that already runs a goal", () => {
    for (const status of [
      "planning",
      "running",
      "recovering",
      "verifying",
      "paused",
      "needs_input",
      "waiting_provider",
      "failed",
    ] as const) {
      expect(goalOccupiesThread([goal({ id: status, status, threadId })], threadId)).toBe(true);
    }
  });

  it("frees the thread once the goal is finished or cancelled", () => {
    for (const status of ["completed", "cancelled"] as const) {
      expect(goalOccupiesThread([goal({ id: status, status, threadId })], threadId)).toBe(false);
    }
  });

  it("ignores a goal of another thread and a threadless view", () => {
    expect(
      goalOccupiesThread([goal({ id: "elsewhere", status: "running", threadId: null })], threadId),
    ).toBe(false);
    expect(goalOccupiesThread([goal({ id: "running", status: "running", threadId })], null)).toBe(
      false,
    );
  });
});

describe("goal-aware composer copy", () => {
  it("names the goal the message joins instead of talking about steering", () => {
    expect(goalSendLabel("steer")).toBe("Send to the goal");
    expect(goalSendLabel("queue")).toBe("Queue for the goal");
  });

  it("explains where a queued message waits", () => {
    expect(goalDeliveryNotice("queue")).toContain("queued behind");
    expect(goalDeliveryNotice("steer")).toContain("joins the goal");
  });
});

describe("goal summary progress and headline", () => {
  it("derives progress from summary counts and the completion status", () => {
    expect(
      goalSummaryProgress({ completedTaskCount: 2, totalTaskCount: 5, status: "running" }),
    ).toEqual({
      completed: 2,
      total: 6,
      percent: 33,
      tasksCompleted: 2,
      tasksTotal: 5,
      verified: false,
      agentProgress: null,
      agentProgressLabel: null,
    });
    expect(
      goalSummaryProgress({ completedTaskCount: 5, totalTaskCount: 5, status: "completed" }),
    ).toEqual({
      completed: 6,
      total: 6,
      percent: 100,
      tasksCompleted: 5,
      tasksTotal: 5,
      verified: true,
      agentProgress: null,
      agentProgressLabel: null,
    });
    expect(
      goalSummaryProgress({ completedTaskCount: 0, totalTaskCount: 0, status: "planning" }),
    ).toEqual({
      completed: 0,
      total: 0,
      percent: 0,
      tasksCompleted: 0,
      tasksTotal: 0,
      verified: false,
      agentProgress: null,
      agentProgressLabel: null,
    });
  });

  it("names the current task and progress without task detail", () => {
    const summary = goal({
      id: "g",
      status: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
      currentTaskTitle: "Build the API",
      completedTaskCount: 1,
      totalTaskCount: 3,
    });

    expect(goalSummaryHeadline(summary)).toBe("Working on: Build the API · 1 of 3 tasks done");
  });

  it("keeps the planning headline and the provider's reason in the summary", () => {
    expect(goalSummaryHeadline(goal({ id: "g", status: "planning" }))).toBe("Planning the work");
    expect(
      goalSummaryHeadline(
        goal({
          id: "g",
          status: "waiting_provider",
          waitingReason: "The database is unreachable.",
        }),
      ),
    ).toBe("The database is unreachable.");
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

  it("labels the recovering state as work in progress", () => {
    expect(goalStatusLabel("recovering")).toBe("Recovering");
    expect(goalStatusTone("recovering")).toBe("active");
    expect(isGoalDriven("recovering")).toBe(true);
  });

  it("parks a goal the provider stopped without calling it failed", () => {
    expect(goalStatusLabel("waiting_provider")).toBe("Waiting for provider");
    expect(goalStatusTone("waiting_provider")).toBe("attention");
    expect(goalNoticeTitle("waiting_provider")).toBe("Waiting for the provider");
    expect(goalNeedsAttention("waiting_provider")).toBe(true);
    // No turn is in flight while the goal waits, so the card does not spin,
    // but it stays alive because the server retries on its own.
    expect(isGoalDriven("waiting_provider")).toBe(false);
    expect(isGoalActive("waiting_provider")).toBe(true);
    const parked = goal({
      id: "g",
      status: "waiting_provider",
      updatedAt: "2026-01-01T00:00:00.000Z",
      waitingReason: "the provider is not signed in",
      tasks: [task({ id: "t1", title: "Build the API", status: "in_progress" })],
    });
    expect(goalHeadline(parked)).toBe("the provider is not signed in");
  });

  it("names the task being recovered on the headline", () => {
    const recovering = goal({
      id: "g",
      status: "recovering",
      updatedAt: "2026-01-01T00:00:00.000Z",
      currentTaskId: "t1",
      tasks: [task({ id: "t1", title: "Build the API", status: "recovering" })],
    });
    expect(goalHeadline(recovering)).toBe("Recovering: Build the API");
  });

  it("labels a task that waits on the user and one that could not finish", () => {
    expect(goalTaskStatusLabel("waiting_input")).toBe("Waiting for you");
    expect(goalTaskStatusLabel("recovering")).toBe("Recovering");
    expect(goalTaskStatusLabel("failed")).toBe("Could not finish");
  });

  it("shows an open question even while the goal keeps working", () => {
    expect(goalHasOpenQuestion({ question: "Which credential do I use?" })).toBe(true);
    expect(goalHasOpenQuestion({ question: null })).toBe(false);
  });

  it("flags the statuses that want the user", () => {
    expect(goalNeedsAttention("needs_input")).toBe(true);
    expect(goalNeedsAttention("waiting_provider")).toBe(true);
    expect(goalNeedsAttention("running")).toBe(false);
    expect(goalNeedsAttention("completed")).toBe(false);
  });

  it("names each status a notification can fire for", () => {
    expect(goalNoticeTitle("needs_input")).toBe("Input needed");
    expect(goalNoticeTitle("waiting_provider")).toBe("Waiting for the provider");
    expect(goalNoticeTitle("failed")).toBe("Goal failed");
    expect(goalNoticeTitle("completed")).toBe("Goal completed");
    expect(goalNoticeTitle("running")).toBe("Goal working");
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

  it("surfaces why the goal is waiting on the environment", () => {
    const parked = goal({
      id: "g",
      status: "waiting_provider",
      waitingReason: "The database is unreachable.",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(goalHeadline(parked)).toBe("The database is unreachable.");
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
    // A parked goal has no turn in flight, but the user can stop it from
    // retrying the provider.
    expect(canPauseGoal("waiting_provider")).toBe(true);
    expect(canPauseGoal("paused")).toBe(false);
    expect(canPauseGoal("needs_input")).toBe(false);
    expect(canPauseGoal("completed")).toBe(false);
  });

  it("marks only driver-owned statuses as driven for the spinner and turn timer", () => {
    expect(isGoalDriven("planning")).toBe(true);
    expect(isGoalDriven("running")).toBe(true);
    expect(isGoalDriven("verifying")).toBe(true);
    expect(isGoalDriven("paused")).toBe(false);
    expect(isGoalDriven("needs_input")).toBe(false);
    expect(isGoalDriven("waiting_provider")).toBe(false);
    expect(isGoalDriven("draft")).toBe(false);
    expect(isGoalDriven("completed")).toBe(false);
  });

  it("resumes every recoverable state, including failed", () => {
    expect(canResumeGoal("paused")).toBe(true);
    expect(canResumeGoal("failed")).toBe(true);
    expect(canResumeGoal("draft")).toBe(true);
    // The server retries a parked goal on its own, but the user may want to
    // try now instead of waiting out the delay.
    expect(canResumeGoal("waiting_provider")).toBe(true);
    expect(canResumeGoal("running")).toBe(false);
    expect(canResumeGoal("completed")).toBe(false);
    expect(canResumeGoal("cancelled")).toBe(false);
  });

  it("gates edit, cancel and retry on the goal not having ended", () => {
    for (const status of [
      "planning",
      "running",
      "paused",
      "failed",
      "draft",
      "waiting_provider",
    ] as const) {
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

describe("goal island lifecycle", () => {
  it("keeps active work and actionable stops visible, but not an intentionally paused goal", () => {
    expect(isGoalIslandVisible({ status: "running", question: null })).toBe(true);
    expect(isGoalIslandVisible({ status: "needs_input", question: null })).toBe(true);
    expect(isGoalIslandVisible({ status: "waiting_provider", question: null })).toBe(true);
    expect(isGoalIslandVisible({ status: "failed", question: null })).toBe(true);
    expect(isGoalIslandVisible({ status: "paused", question: null })).toBe(false);
  });

  it("elevates an open question and names the useful next action", () => {
    const waiting = {
      status: "running" as const,
      question: "Which provider should I use?",
      currentTaskTitle: "Configure the client",
      completedTaskCount: 1,
      totalTaskCount: 3,
      waitingReason: null,
    };
    expect(goalNeedsIslandAttention(waiting)).toBe(true);
    expect(goalIslandHeadline(waiting)).toBe("Needs your answer");
    expect(goalIslandActionLabel(waiting)).toBe("Answer goal");
    expect(goalIslandActionLabel({ status: "failed", question: null })).toBe("Review goal");
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
    expect(states).toEqual([{ criterion: "Persists after reload", met: null, proof: [] }]);
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
      { criterion: "Persists after reload", met: true, proof: [] },
      { criterion: "Loads under a second", met: false, proof: [] },
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
      { criterion: "Checked", met: true, proof: [] },
      { criterion: "Never judged", met: null, proof: [] },
    ]);
  });
});

describe("goalWaitingTask", () => {
  it("names the task parked on the user", () => {
    const waiting = goalWaitingTask(
      goal({
        id: "g",
        status: "running",
        tasks: [
          task({ id: "t1", title: "one", status: "completed" }),
          task({ id: "t2", title: "two", status: "waiting_input" }),
        ],
      }),
    );
    expect(waiting?.id).toBe("t2");
  });

  it("reports nothing while every task is running", () => {
    const waiting = goalWaitingTask(
      goal({
        id: "g",
        status: "running",
        tasks: [task({ id: "t1", title: "one", status: "in_progress" })],
      }),
    );
    expect(waiting).toBeNull();
  });
});

describe("goalObjectiveText", () => {
  it("keeps the user's own wording when it differs from the title", () => {
    expect(goalObjectiveText({ objective: "Ship the settings page", title: "Settings page" })).toBe(
      "Ship the settings page",
    );
  });

  it("stays quiet when the objective only repeats the title", () => {
    expect(goalObjectiveText({ objective: "A goal", title: "A goal" })).toBeNull();
  });

  it("stays quiet when there is no objective", () => {
    expect(goalObjectiveText({ objective: "   ", title: "A goal" })).toBeNull();
  });
});

describe("goalMetaLine", () => {
  it("names the model and the turns spent", () => {
    expect(
      goalMetaLine({
        modelSelection: { model: "gpt-5.4" } as Goal["modelSelection"],
        cycleCount: 7,
      }),
    ).toBe("gpt-5.4 · 7 turns");
  });

  it("counts a single turn in the singular", () => {
    expect(
      goalMetaLine({
        modelSelection: { model: "gpt-5.4" } as Goal["modelSelection"],
        cycleCount: 1,
      }),
    ).toBe("gpt-5.4 · 1 turn");
  });

  it("still reports the turns without a model", () => {
    expect(
      goalMetaLine({
        modelSelection: { model: "" } as Goal["modelSelection"],
        cycleCount: 3,
      }),
    ).toBe("3 turns");
  });
});
