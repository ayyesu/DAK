import type { Goal, GoalStatus, GoalTask, GoalTaskStatus, ThreadId } from "@dak/contracts";

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

/** The server only pauses a goal its driver is actively working on. */
export function canPauseGoal(status: GoalStatus): boolean {
  return status === "planning" || status === "running" || status === "verifying";
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

/** Completed tasks over the plan; a goal with no plan yet reads as 0%. */
export function goalProgress(goal: Pick<Goal, "tasks">): {
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
} {
  const total = goal.tasks.length;
  const completed = goal.tasks.filter((task) => task.status === "completed").length;
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

/**
 * The goal the panel should show, Codex-style: a goal belongs to the thread
 * that owns it, so another thread's goal never appears here. A selection the
 * user already made (the other-goals menu) wins over the thread default.
 */
export function selectGoalForThread(
  goals: ReadonlyArray<Goal>,
  threadId: ThreadId | null,
): Goal | null {
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

/** Typing `/goal ` at the start of the composer turns the same input into DAK goal mode. */
export const GOAL_SLASH_PREFIX = "/goal ";

export function isGoalSlashPrompt(prompt: string): boolean {
  return /^\s*\/goal\s+/i.test(prompt);
}

/** The objective is everything after the `/goal ` prefix, trimmed. */
export function getGoalSlashObjective(prompt: string): string {
  const match = /^\s*\/goal\s+/i.exec(prompt);
  if (match === null) return prompt.trim();
  return prompt.slice(match[0].length).trim();
}

/** Length of the leading `/goal ` prefix (including leading whitespace), 0 when absent. */
export function goalSlashPrefixLength(prompt: string): number {
  const match = /^\s*\/goal\s+/i.exec(prompt);
  return match === null ? 0 : match[0].length;
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
}

/**
 * Acceptance criteria with their verification verdict, newest check wins:
 * `met` stays null while the goal has never been verified.
 */
export function goalCriterionStates(
  goal: Pick<Goal, "acceptanceCriteria" | "verification">,
): ReadonlyArray<GoalCriterionState> {
  const results = goal.verification.criteria ?? [];
  return goal.acceptanceCriteria.map((criterion) => ({
    criterion,
    met: results.find((result) => result.criterion === criterion)?.met ?? null,
  }));
}
