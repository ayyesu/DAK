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
const GOAL_ACTIVE_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "planning",
  "running",
  "recovering",
  "verifying",
  "paused",
  "needs_input",
  // The goal is parked on a provider fault. It resumes on its own, so it is
  // alive, but no turn is in flight.
  "waiting_provider",
]);

export function isGoalActive(status: GoalStatus): boolean {
  return GOAL_ACTIVE_STATUSES.has(status);
}

/** Statuses that ended the goal for good; resume, edit, cancel and retry refuse them. */
const ENDED_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set(["completed", "cancelled"]);

export function isGoalEnded(status: GoalStatus): boolean {
  return ENDED_GOAL_STATUSES.has(status);
}

/** Statuses with a driver dispatching turns; the card spins and counts turn age here. */
export function isGoalDriven(status: GoalStatus): boolean {
  return (
    status === "planning" ||
    status === "running" ||
    status === "recovering" ||
    status === "verifying"
  );
}

/** The server only pauses a goal its driver is actively working on. */
export function canPauseGoal(status: GoalStatus): boolean {
  // A goal parked on a provider fault has no turn in flight, but the user
  // can still stop it from retrying.
  return isGoalDriven(status) || status === "waiting_provider";
}
/** Recoverable states; `failed` resumes rather than restarts. */
export function canResumeGoal(status: GoalStatus): boolean {
  // A parked goal resumes on its own, but the user may want to try now
  // instead of waiting out the provider's delay.
  return (
    status === "paused" ||
    status === "failed" ||
    status === "draft" ||
    status === "waiting_provider"
  );
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
    status === "needs_input" ||
    status === "paused" ||
    status === "failed" ||
    // The provider broke, so the goal cannot move until it comes back. The
    // server keeps trying, but the user may be able to fix it faster.
    status === "waiting_provider"
  );
}

/**
 * Whether the agent is waiting on the user. The question can be open while
 * the goal keeps working on other tasks, so the card shows the question even
 * when the goal's status is still "running".
 */
export function goalHasOpenQuestion(goal: Pick<GoalSummary, "question">): boolean {
  return goal.question !== null;
}

/**
 * The island is ambient status, not a second goal dashboard. It stays visible
 * for work in progress and for states where a person can move the goal
 * forward; a deliberately paused goal remains in the thread card instead.
 */
export function goalNeedsIslandAttention(goal: Pick<GoalSummary, "status" | "question">): boolean {
  return (
    goal.question !== null ||
    goal.status === "needs_input" ||
    goal.status === "waiting_provider" ||
    goal.status === "failed"
  );
}

/** A goal belongs in the ambient island only while it is moving or needs intervention. */
export function isGoalIslandVisible(goal: Pick<GoalSummary, "status" | "question">): boolean {
  return isGoalDriven(goal.status) || goalNeedsIslandAttention(goal);
}

/** The island's one-line explanation of the exact state to act on. */
export function goalIslandHeadline(
  goal: Pick<
    GoalSummary,
    | "status"
    | "currentTaskTitle"
    | "completedTaskCount"
    | "totalTaskCount"
    | "waitingReason"
    | "question"
  >,
): string {
  if (goal.question !== null) return "Needs your answer";
  return goalSummaryHeadline(goal);
}

/** A verb that reflects the next useful destination, not merely navigation. */
export function goalIslandActionLabel(goal: Pick<GoalSummary, "status" | "question">): string {
  if (goal.question !== null || goal.status === "needs_input") return "Answer goal";
  if (goal.status === "waiting_provider" || goal.status === "failed") return "Review goal";
  return "Open goal";
}

/**
 * Whether a goal is the one driving this thread's work.
 *
 * A goal runs its turns in the thread it is bound to, so the thread knows
 * that the agent is busy on the goal and not on a plain message.
 */
export function goalDrivesThread(
  goals: ReadonlyArray<Pick<GoalSummary, "threadId" | "status">>,
  threadId: ThreadId | null,
): boolean {
  if (threadId === null) return false;
  return goals.some((goal) => goal.threadId === threadId && isGoalDriven(goal.status));
}

/**
 * Whether a thread already has a goal.
 *
 * A thread runs one goal: two goals in one thread would answer each other's
 * turns. The server keeps this rule, and the client follows the same one, so
 * a second goal starts in a thread of its own instead of being refused. A
 * goal owns its thread until it is completed or cancelled; a failed goal can
 * still be resumed, so it keeps the thread.
 */
export function goalOccupiesThread(
  goals: ReadonlyArray<Pick<GoalSummary, "threadId" | "status">>,
  threadId: ThreadId | null,
): boolean {
  if (threadId === null) return false;
  return goals.some(
    (goal) =>
      goal.threadId === threadId && goal.status !== "completed" && goal.status !== "cancelled",
  );
}

/**
 * The composer's send label while a goal is working in this thread.
 *
 * The goal owns the thread's turns, so the button names where the message
 * lands instead of talking about steering.
 */
export function goalSendLabel(kind: "steer" | "queue"): string {
  return kind === "queue" ? "Queue for the goal" : "Send to the goal";
}

/** What the composer tells the user about a message sent while a goal runs. */
export function goalDeliveryNotice(kind: "steer" | "queue"): string {
  return kind === "queue"
    ? "A goal is working in this thread. Your message is queued behind the goal's current turn."
    : "A goal is working in this thread. Your message joins the goal's current turn.";
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
    case "recovering":
      return "Recovering";
    case "paused":
      return "Paused";
    case "needs_input":
      return "Needs input";
    case "waiting_provider":
      return "Waiting for provider";
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
    case "waiting_provider":
      return "Waiting for the provider";
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
    case "recovering":
    case "verifying":
      return "active";
    case "paused":
    case "needs_input":
    case "waiting_provider":
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
  goal: Pick<Goal, "status" | "tasks" | "currentTaskId" | "waitingReason" | "question">,
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
    case "recovering": {
      const current =
        goal.tasks.find((task) => task.id === goal.currentTaskId) ??
        goal.tasks.find((task) => task.status === "recovering");
      return current === undefined ? "Working through a problem" : `Recovering: ${current.title}`;
    }
    case "paused":
      return "Paused";
    case "needs_input":
      return "Waiting for your answer";
    case "waiting_provider":
      return goal.waitingReason ?? "Waiting for the provider";
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
    | "status"
    | "currentTaskTitle"
    | "completedTaskCount"
    | "totalTaskCount"
    | "waitingReason"
    | "question"
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
    case "recovering":
      return summary.currentTaskTitle === null
        ? "Working through a problem"
        : `Recovering: ${summary.currentTaskTitle}`;
    case "paused":
      return "Paused";
    case "needs_input":
      return "Waiting for your answer";
    case "waiting_provider":
      return summary.waitingReason ?? "Waiting for the provider";
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
    case "recovering":
      return "Recovering";
    case "waiting_input":
      return "Waiting for you";
    case "completed":
      return "Completed";
    case "failed":
      return "Could not finish";
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

/**
 * The task parked on the user.
 *
 * A question parks one task, not the goal, so the card names the task the
 * answer unblocks instead of leaving the user to hunt for it.
 */
export function goalWaitingTask(goal: Pick<Goal, "tasks">): GoalTask | null {
  return goal.tasks.find((task) => task.status === "waiting_input") ?? null;
}

/**
 * The user's own words for the goal, when they add something to the title.
 *
 * The server names the goal from the objective, so the two usually differ
 * in wording. Showing the objective keeps the user's request visible.
 */
export function goalObjectiveText(goal: Pick<Goal, "objective" | "title">): string | null {
  const objective = goal.objective.trim();
  if (objective === "") return null;
  if (objective === goal.title.trim()) return null;
  return objective;
}

/**
 * The meta line under the progress bar: which model runs the goal and how
 * much work it has already done.
 */
export function goalMetaLine(goal: Pick<Goal, "modelSelection" | "cycleCount">): string | null {
  const model = goal.modelSelection.model.trim();
  const turns = goal.cycleCount;
  const turnPart = turns === 1 ? "1 turn" : `${turns} turns`;
  if (model === "") return turnPart;
  return `${model} · ${turnPart}`;
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
