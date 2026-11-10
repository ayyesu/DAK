import type {
  Goal,
  GoalProof,
  GoalStatus,
  GoalSummary,
  GoalTask,
  GoalTaskStatus,
  ThreadId,
} from "@dak/contracts";

/** Statuses where the server is still working or waiting to work. */
const GOAL_ACTIVE_STATUSES: ReadonlyArray<GoalStatus> = [
  "planning",
  "running",
  "verifying",
  "paused",
  "needs_input",
  "blocked",
];

export function isGoalActive(status: GoalStatus): boolean {
  return GOAL_ACTIVE_STATUSES.includes(status);
}

/** Statuses that ended the goal for good; resume, edit, cancel and retry refuse them. */
const ENDED_GOAL_STATUSES: ReadonlyArray<GoalStatus> = ["completed", "cancelled"];

export function isGoalEnded(status: GoalStatus): boolean {
  return ENDED_GOAL_STATUSES.includes(status);
}

/** Statuses with a driver dispatching turns; the card spins and counts turn age here. */
export function isGoalDriven(status: GoalStatus): boolean {
  return status === "planning" || status === "running" || status === "verifying";
}

/** The server only pauses a goal its driver is actively working on. */
export function canPauseGoal(status: GoalStatus): boolean {
  return isGoalDriven(status);
}

/** Recoverable states; `failed` and `blocked` resume rather than restart. */
export function canResumeGoal(status: GoalStatus): boolean {
  return status === "paused" || status === "blocked" || status === "failed" || status === "draft";
}

export function canEditGoal(status: GoalStatus): boolean {
  return !isGoalEnded(status);
}

export function canCancelGoal(status: GoalStatus): boolean {
  return !isGoalEnded(status);
}

export function canRetryGoal(status: GoalStatus): boolean {
  return !isGoalEnded(status);
}

export function goalNeedsAttention(status: GoalStatus): boolean {
  return (
    status === "needs_input" || status === "blocked" || status === "paused" || status === "failed"
  );
}

export interface GoalProgress {
  /** Completed units over all units; verification is the last unit. */
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
  /** Task counts on their own, so the label never calls verification a task. */
  readonly tasksCompleted: number;
  readonly tasksTotal: number;
  readonly verified: boolean;
  /** The agent's own reported progress, when it reported one this turn. */
  readonly agentProgress: number | null;
  readonly agentProgressLabel: string | null;
}

/**
 * The agent's own reported progress takes precedence: it is authoritative
 * during planning and execution, so the bar never sits at 0% while the agent
 * is working. Falls back to tasks + verification when the agent hasn't
 * reported anything yet.
 */
export function goalProgress(
  goal: Pick<Goal, "tasks" | "verification"> & {
    readonly progress?: number | null;
    readonly progressLabel?: string | null;
  },
): GoalProgress {
  const tasksTotal = goal.tasks.length;
  const tasksCompleted = goal.tasks.filter((task) => task.status === "completed").length;
  const verified = goal.verification.status === "passed";
  const agentProgress = goal.progress ?? null;
  const agentProgressLabel = goal.progressLabel ?? null;

  // Agent-reported progress is authoritative whenever it is present.
  if (agentProgress !== null) {
    return {
      completed: agentProgress,
      total: 100,
      percent: agentProgress,
      tasksCompleted,
      tasksTotal,
      verified,
      agentProgress,
      agentProgressLabel,
    };
  }

  if (tasksTotal === 0) {
    return {
      completed: 0,
      total: 0,
      percent: 0,
      tasksCompleted,
      tasksTotal,
      verified,
      agentProgress: null,
      agentProgressLabel: null,
    };
  }
  const total = tasksTotal + 1;
  const completed = tasksCompleted + (verified ? 1 : 0);
  return {
    completed,
    total,
    percent: Math.round((completed / total) * 100),
    tasksCompleted,
    tasksTotal,
    verified,
    agentProgress: null,
    agentProgressLabel: null,
  };
}

/** The counter beside the bar; verification never reads as a finished task. */
export function goalProgressLabel(progress: GoalProgress): string {
  // The agent's own label takes precedence while it is working.
  if (progress.agentProgressLabel !== null) return progress.agentProgressLabel;
  if (progress.tasksTotal === 0) return "No plan yet";
  const tasks = `${progress.tasksCompleted} of ${progress.tasksTotal} ${
    progress.tasksTotal === 1 ? "task" : "tasks"
  }`;
  if (progress.verified) return `${tasks} · verified`;
  return progress.tasksCompleted === progress.tasksTotal
    ? `${tasks} · awaiting verification`
    : tasks;
}

/** The same model without importing the full task list. */
export function goalSummaryProgress(
  summary: Pick<GoalSummary, "completedTaskCount" | "totalTaskCount" | "status"> & {
    readonly progress?: number | null;
    readonly progressLabel?: string | null;
  },
): GoalProgress {
  const tasksTotal = summary.totalTaskCount;
  const tasksCompleted = summary.completedTaskCount;
  // Only a verified goal is ever completed, so the status carries the unit.
  const verified = summary.status === "completed";
  const agentProgress = summary.progress ?? null;
  const agentProgressLabel = summary.progressLabel ?? null;

  if (agentProgress !== null) {
    return {
      completed: agentProgress,
      total: 100,
      percent: agentProgress,
      tasksCompleted,
      tasksTotal,
      verified,
      agentProgress,
      agentProgressLabel,
    };
  }

  if (tasksTotal === 0) {
    return {
      completed: 0,
      total: 0,
      percent: 0,
      tasksCompleted,
      tasksTotal,
      verified,
      agentProgress: null,
      agentProgressLabel: null,
    };
  }
  const total = tasksTotal + 1;
  const completed = tasksCompleted + (verified ? 1 : 0);
  return {
    completed,
    total,
    percent: Math.round((completed / total) * 100),
    tasksCompleted,
    tasksTotal,
    verified,
    agentProgress: null,
    agentProgressLabel: null,
  };
}

/**
 * The goal the panel should show, Codex-style: a goal belongs to the thread
 * that owns it, so another thread's goal never appears here. A selection the
 * user already made (the other-goals menu) wins over the thread default.
 */
export function selectGoalForThread(
  goals: ReadonlyArray<GoalSummary>,
  threadId: ThreadId | null,
): GoalSummary | null {
  if (threadId === null) return null;
  const byUpdate = goals.toSorted(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const threadGoals = byUpdate.filter((goal) => goal.threadId === threadId);
  const activeThreadGoal = threadGoals.find((goal) => isGoalActive(goal.status));
  if (activeThreadGoal !== undefined) return activeThreadGoal;
  return threadGoals[0] ?? null;
}

export function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "planning":
      return "Planning";
    case "running":
      return "Working";
    case "paused":
      return "Paused";
    case "needs_input":
      return "Needs input";
    case "blocked":
      return "Blocked";
    case "verifying":
      return "Verifying";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** Headline for a goal's attention or completion notification. */
export function goalNoticeTitle(status: GoalStatus): string {
  switch (status) {
    case "needs_input":
      return "Input needed";
    case "blocked":
      return "Goal blocked";
    case "failed":
      return "Goal failed";
    case "completed":
      return "Goal completed";
    default:
      // Only the statuses above fire notices; fall back to the card label so
      // a caller bug reads plainly instead of claiming completion.
      return `Goal ${goalStatusLabel(status).toLowerCase()}`;
  }
}

export type GoalTone = "active" | "attention" | "success" | "danger" | "muted";

export function goalStatusTone(status: GoalStatus): GoalTone {
  switch (status) {
    case "planning":
    case "running":
    case "verifying":
      return "active";
    case "paused":
    case "needs_input":
    case "blocked":
      return "attention";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "draft":
    case "cancelled":
      return "muted";
  }
}

/** One line that answers "what is happening right now?" for the collapsed card. */
export function goalHeadline(
  goal: Pick<Goal, "status" | "tasks" | "currentTaskId" | "blockedReason">,
): string {
  switch (goal.status) {
    case "draft":
      return "Draft";
    case "planning":
      return "Planning the work";
    case "running": {
      const current =
        goal.tasks.find((task) => task.id === goal.currentTaskId) ??
        goal.tasks.find((task) => task.status === "in_progress");
      const done = goal.tasks.filter((task) => task.status === "completed").length;
      const progressSuffix =
        goal.tasks.length > 1 ? ` · ${done} of ${goal.tasks.length} tasks done` : "";
      return current === undefined
        ? `Working${progressSuffix}`
        : `Working on: ${current.title}${progressSuffix}`;
    }
    case "paused":
      return "Paused";
    case "needs_input":
      return "Waiting for your answer";
    case "blocked":
      return goal.blockedReason ?? "Blocked";
    case "verifying":
      return "Verifying the result";
    case "completed":
      return "Completed and verified";
    case "failed":
      return "Stopped after an error";
    case "cancelled":
      return "Cancelled";
  }
}

/** The collapsed card's line without importing task or activity detail. */
export function goalSummaryHeadline(
  summary: Pick<
    GoalSummary,
    "status" | "currentTaskTitle" | "completedTaskCount" | "totalTaskCount" | "blockedReason"
  >,
): string {
  switch (summary.status) {
    case "draft":
      return "Draft";
    case "planning":
      return "Planning the work";
    case "running": {
      const progressSuffix =
        summary.totalTaskCount > 1
          ? ` · ${summary.completedTaskCount} of ${summary.totalTaskCount} tasks done`
          : "";
      return summary.currentTaskTitle === null
        ? `Working${progressSuffix}`
        : `Working on: ${summary.currentTaskTitle}${progressSuffix}`;
    }
    case "paused":
      return "Paused";
    case "needs_input":
      return "Waiting for your answer";
    case "blocked":
      return summary.blockedReason ?? "Blocked";
    case "verifying":
      return "Verifying the result";
    case "completed":
      return "Completed and verified";
    case "failed":
      return "Stopped after an error";
    case "cancelled":
      return "Cancelled";
  }
}

export function goalTaskStatusLabel(status: GoalTaskStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "in_progress":
      return "Currently executing";
    case "completed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
  }
}

/** Compact relative time for "last activity"; no Intl formatting per row. */
export function formatGoalActivityTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((nowMs - then) / 1_000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  return `${weeks}w ago`;
}

/** Age of the in-flight turn, "45s" / "12m 05s" / "1h 04m"; "" when unparseable. */
export function formatGoalTurnElapsed(startedAt: string, nowMs: number): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return "";
  const totalSeconds = Math.max(0, Math.floor((nowMs - started) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes === 0) return `${totalSeconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The task a progress row should mark as current. */
export function currentGoalTask(
  goal: Pick<Goal, "tasks" | "currentTaskId" | "status">,
): GoalTask | null {
  const active = goal.tasks.find((task) => task.status === "in_progress");
  if (active !== undefined) return active;
  if (goal.currentTaskId === null) return null;
  return goal.tasks.find((task) => task.id === goal.currentTaskId) ?? null;
}

/** Mirrors the server's acceptance-criteria bounds so input never trips the schema. */
const GOAL_CRITERIA_MAX_LINES = 20;
const GOAL_CRITERIA_MAX_LENGTH = 500;

/** One criterion per line; blank lines dropped, length and count capped. */
export function splitCriteriaLines(text: string): Array<string> {
  return text
    .split("\n")
    .map((line) => line.trim().slice(0, GOAL_CRITERIA_MAX_LENGTH))
    .filter((line) => line !== "")
    .slice(0, GOAL_CRITERIA_MAX_LINES);
}

const GOAL_SLASH_PROMPT = /^\s*\/goal\s+/i;

/** Reserved subcommands: they must run as commands, never become an objective. */
const GOAL_SLASH_RESERVED = new Set(["clear", "pause", "resume", "status"]);

/** `/goal clear` and friends; matched exactly against the trimmed remainder. */
export function isGoalSlashCommand(prompt: string): boolean {
  const match = GOAL_SLASH_PROMPT.exec(prompt);
  if (match === null) return false;
  return GOAL_SLASH_RESERVED.has(prompt.slice(match[0].length).trim().toLowerCase());
}

/** Typing `/goal ` at the start of the composer turns the same input into DAK goal mode. */
export function isGoalSlashPrompt(prompt: string): boolean {
  return GOAL_SLASH_PROMPT.test(prompt) && !isGoalSlashCommand(prompt);
}

/** The objective is everything after the `/goal ` prefix, trimmed. */
export function getGoalSlashObjective(prompt: string): string {
  const match = GOAL_SLASH_PROMPT.exec(prompt);
  if (match === null || isGoalSlashCommand(prompt)) return prompt.trim();
  return prompt.slice(match[0].length).trim();
}

/** Length of the leading `/goal ` prefix (including leading whitespace), 0 when absent. */
export function goalSlashPrefixLength(prompt: string): number {
  if (isGoalSlashCommand(prompt)) return 0;
  const match = GOAL_SLASH_PROMPT.exec(prompt);
  return match === null ? 0 : match[0].length;
}

/**
 * Whether a model selection can start a goal. The no-provider placeholder
 * (`NO_PROVIDER_MODEL_SELECTION`) carries an empty model, which the goal
 * schema rejects — treating it as absent turns the failure into the
 * "Pick a model to start a goal" message instead of a schema error.
 */
export function isUsableGoalModelSelection(
  selection: { readonly model: string } | null | undefined,
): boolean {
  return selection !== null && selection !== undefined && selection.model.trim() !== "";
}

/**
 * The first usable candidate wins. Callers put the composer's own resolved
 * selection first: on a draft thread the footer pick updates only the
 * composer draft, while thread-level selections stay the no-provider
 * placeholder, so falling back to them would fail schema validation.
 */
export function selectGoalModelSelection<T extends { readonly model: string }>(
  candidates: ReadonlyArray<T | null | undefined>,
): T | null {
  return candidates.find((candidate) => isUsableGoalModelSelection(candidate)) ?? null;
}

export function goalVerificationStatusLabel(status: Goal["verification"]["status"]): string {
  switch (status) {
    case "pending":
      return "Not checked yet";
    case "passed":
      return "Verified";
    case "failed":
      return "Did not pass";
  }
}

export interface GoalCriterionState {
  readonly criterion: string;
  /** `null` until a verification pass has judged the criterion. */
  readonly met: boolean | null;
  /** Rich proof backing a met criterion: images, screenshots, canvas, test results, etc. */
  readonly proof: ReadonlyArray<GoalProof>;
}

/**
 * Acceptance criteria with their verification verdict, newest check wins:
 * `met` stays null while the goal has never been verified.
 */
export function goalCriterionStates(
  goal: Pick<Goal, "acceptanceCriteria" | "verification">,
): ReadonlyArray<GoalCriterionState> {
  const results = goal.verification.criteria ?? [];
  return goal.acceptanceCriteria.map((criterion) => {
    const result = results.find((item) => item.criterion === criterion);
    return {
      criterion,
      met: result?.met ?? null,
      proof: result?.proof ?? [],
    };
  });
}
