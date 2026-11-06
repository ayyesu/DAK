import {
  GOAL_MAX_TASKS,
  type Goal,
  type GoalActivityKind,
  type GoalStatus,
  type GoalTask,
  type GoalTaskStatus,
} from "@dak/contracts";

/**
 * Goal Mode talks to the agent through one fenced JSON block in its final
 * message. The server owns task state; the block is the only thing the agent
 * can use to report progress, and an unparseable or missing block is treated
 * as "no progress" rather than as success. That is what keeps the progress
 * bars honest across providers that shape text very differently.
 */
const REPORT_FENCE = /\n?```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/g;
const MAX_REPORT_TEXT = 2_000;

export type GoalReportStatus = "running" | "needs_input" | "blocked" | "completed";

export interface GoalReportPlanItem {
  readonly title: string;
  readonly detail: string | null;
}

export interface GoalReportTaskUpdate {
  readonly title: string;
  readonly status: GoalTaskStatus;
  readonly evidence: string | null;
}

export interface GoalReportAcceptance {
  readonly criterion: string;
  readonly met: boolean;
  readonly evidence: string | null;
}

export interface GoalReport {
  readonly plan: ReadonlyArray<GoalReportPlanItem>;
  readonly tasks: ReadonlyArray<GoalReportTaskUpdate>;
  readonly status: GoalReportStatus;
  readonly summary: string | null;
  readonly question: string | null;
  readonly acceptance: ReadonlyArray<GoalReportAcceptance>;
  readonly verified: boolean | null;
  /** Conditions the agent proposes when the user gave none. */
  readonly acceptanceCriteria: ReadonlyArray<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_REPORT_TEXT);
}

const TASK_STATUSES: ReadonlyArray<GoalTaskStatus> = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "failed",
];

const REPORT_STATUSES: ReadonlyArray<GoalReportStatus> = [
  "running",
  "needs_input",
  "blocked",
  "completed",
];

function asTaskStatus(value: unknown): GoalTaskStatus | null {
  return typeof value === "string" && (TASK_STATUSES as ReadonlyArray<string>).includes(value)
    ? (value as GoalTaskStatus)
    : null;
}

function asReportStatus(value: unknown): GoalReportStatus | null {
  return typeof value === "string" && (REPORT_STATUSES as ReadonlyArray<string>).includes(value)
    ? (value as GoalReportStatus)
    : null;
}

function parseReportBody(body: unknown): GoalReport | null {
  if (!isRecord(body)) return null;
  const report = isRecord(body.goal_report) ? body.goal_report : body;

  const plan = Array.isArray(report.plan)
    ? report.plan
        .flatMap((item): ReadonlyArray<GoalReportPlanItem> => {
          if (!isRecord(item)) return [];
          const title = text(item.title);
          return title === null ? [] : [{ title, detail: text(item.detail) }];
        })
        .slice(0, GOAL_MAX_TASKS)
    : [];

  const tasks = Array.isArray(report.tasks)
    ? report.tasks
        .flatMap((item): ReadonlyArray<GoalReportTaskUpdate> => {
          if (!isRecord(item)) return [];
          const title = text(item.title) ?? text(item.id);
          const status = asTaskStatus(item.status);
          return title === null || status === null
            ? []
            : [{ title, status, evidence: text(item.evidence) }];
        })
        .slice(0, GOAL_MAX_TASKS)
    : [];

  const acceptance = Array.isArray(report.acceptance)
    ? report.acceptance
        .flatMap((item): ReadonlyArray<GoalReportAcceptance> => {
          if (!isRecord(item)) return [];
          const criterion = text(item.criterion);
          return criterion === null
            ? []
            : [{ criterion, met: item.met === true, evidence: text(item.evidence) }];
        })
        .slice(0, 20)
    : [];

  const acceptanceCriteria = Array.isArray(report.acceptanceCriteria)
    ? report.acceptanceCriteria.flatMap((item): ReadonlyArray<string> => {
        const criterion = text(item);
        return criterion === null ? [] : [criterion];
      })
    : [];

  const status = asReportStatus(report.status) ?? "running";
  const summary = text(report.summary);
  const question = text(report.question);
  const verified = typeof report.verified === "boolean" ? report.verified : null;

  // An empty object must not count as a report: it would look like a turn that
  // ran and reported nothing, which the runner treats as idle progress.
  if (
    plan.length === 0 &&
    tasks.length === 0 &&
    acceptance.length === 0 &&
    acceptanceCriteria.length === 0 &&
    summary === null &&
    valueHasStatus(report) === false
  ) {
    return null;
  }

  return {
    plan,
    tasks,
    status,
    summary,
    question,
    acceptance,
    verified,
    acceptanceCriteria,
  };
}

function valueHasStatus(report: Record<string, unknown>): boolean {
  return typeof report.status === "string";
}

/**
 * Reads the last goal report in an assistant message. Providers sometimes wrap
 * the block in prose, and a retry can leave two blocks, so the last one wins.
 */
export function parseGoalReport(message: string): GoalReport | null {
  const blocks = Array.from(message.matchAll(REPORT_FENCE));
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    const language = (block[1] ?? "").toLowerCase();
    const body = block[2] ?? "";
    if (language !== "" && !language.startsWith("goal") && language !== "json") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const report = parseReportBody(parsed);
    if (report !== null) return report;
  }
  return null;
}

/** Strip report blocks before a turn is summarized for a person. */
export function stripGoalReport(message: string): string {
  return message.replace(REPORT_FENCE, "").trim();
}

export interface GoalReportTaskChange {
  readonly kind: Extract<
    GoalActivityKind,
    "plan" | "task_started" | "task_completed" | "task_failed" | "task_blocked"
  >;
  readonly summary: string;
  readonly taskId: string | null;
}

export interface GoalReportApplication {
  readonly tasks: ReadonlyArray<GoalTask>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly status: GoalStatus;
  readonly currentTaskId: string | null;
  readonly changes: ReadonlyArray<GoalReportTaskChange>;
  /** The agent reported completion but tasks remain; the UI should say so. */
  readonly prematureCompletion: boolean;
}

function normalizedTitle(title: string): string {
  return title.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

/**
 * How a turn's plan may change the stored one. Only the planning turn may
 * replace a plan; an edit or repair extends it; an execution turn's echoed
 * plan is ignored so slightly reworded titles cannot duplicate tasks.
 */
export type GoalPlanHandling = "replace" | "extend" | "ignore";

/**
 * Folds a report into the stored plan. Started and finished tasks are never
 * rewritten by a new plan: an edit changes what remains, not what was done.
 */
export function applyGoalReport(input: {
  readonly tasks: ReadonlyArray<GoalTask>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly report: GoalReport;
  /** Deterministic ids keep retries from duplicating tasks. */
  readonly makeTaskId: () => string;
  readonly nowIso: string;
  readonly planHandling?: GoalPlanHandling;
}): GoalReportApplication {
  const { report, nowIso } = input;
  const changes: GoalReportTaskChange[] = [];
  let nextOrder = input.tasks.reduce((max, task) => Math.max(max, task.order + 1), 0);
  let tasks: GoalTask[] = [...input.tasks];

  const replaceable = (task: GoalTask) =>
    task.status === "pending" && task.attempts === 0 && task.startedAt === null;

  const planHandling = input.planHandling ?? "replace";
  if (
    report.plan.length > 0 &&
    planHandling !== "ignore" &&
    (tasks.length === 0 || planHandling === "extend" || tasks.some(replaceable))
  ) {
    if (planHandling === "replace") {
      const plannedTitles = new Set(report.plan.map((item) => normalizedTitle(item.title)));
      // Tasks that never started make way for the new plan; started work stays.
      tasks = tasks.filter(
        (task) => !replaceable(task) || plannedTitles.has(normalizedTitle(task.title)),
      );
    }
    for (const item of report.plan) {
      if (tasks.length >= GOAL_MAX_TASKS) break;
      const key = normalizedTitle(item.title);
      const existing = tasks.find((task) => normalizedTitle(task.title) === key);
      if (existing !== undefined) {
        const index = tasks.indexOf(existing);
        tasks[index] = { ...existing, detail: item.detail ?? existing.detail };
        continue;
      }
      tasks.push({
        id: input.makeTaskId(),
        title: item.title,
        detail: item.detail,
        status: "pending",
        order: nextOrder,
        startedAt: null,
        completedAt: null,
        evidence: null,
        attempts: 0,
      });
      nextOrder += 1;
    }
    changes.push({
      kind: "plan",
      summary: `Plan set: ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      taskId: null,
    });
  }

  for (const update of report.tasks) {
    const key = normalizedTitle(update.title);
    const index = tasks.findIndex((task) => normalizedTitle(task.title) === key);
    if (index === -1) {
      if (tasks.length >= GOAL_MAX_TASKS) continue;
      tasks.push({
        id: input.makeTaskId(),
        title: update.title,
        detail: null,
        status: update.status,
        order: nextOrder,
        startedAt: update.status === "completed" ? nowIso : null,
        completedAt: update.status === "completed" ? nowIso : null,
        evidence: update.evidence,
        attempts: 1,
      });
      nextOrder += 1;
      continue;
    }
    const current = tasks[index]!;
    // A completed task is terminal until the user retries it explicitly, so a
    // sloppy later report cannot un-complete verified work.
    if (current.status === "completed" && update.status !== "completed") continue;
    const next: GoalTask =
      update.status === "completed"
        ? {
            ...current,
            status: "completed",
            completedAt: current.completedAt ?? nowIso,
            startedAt: current.startedAt ?? nowIso,
            evidence: update.evidence ?? current.evidence,
            attempts: Math.max(current.attempts, 1),
          }
        : update.status === "in_progress"
          ? {
              ...current,
              status: "in_progress",
              startedAt: current.startedAt ?? nowIso,
              attempts: current.attempts + 1,
            }
          : { ...current, status: update.status, evidence: update.evidence ?? current.evidence };
    tasks[index] = next;
    if (next.status !== current.status) {
      changes.push({
        kind:
          next.status === "completed"
            ? "task_completed"
            : next.status === "failed"
              ? "task_failed"
              : next.status === "blocked"
                ? "task_blocked"
                : "task_started",
        summary:
          next.status === "completed"
            ? `Completed: ${next.title}`
            : next.status === "failed"
              ? `Failed: ${next.title}`
              : next.status === "blocked"
                ? `Blocked: ${next.title}`
                : `Started: ${next.title}`,
        taskId: next.id,
      });
    }
  }

  tasks = tasks.toSorted((left, right) => left.order - right.order);
  const allCompleted = tasks.length > 0 && tasks.every((task) => task.status === "completed");
  const active = tasks.find((task) => task.status === "in_progress") ?? null;
  const acceptanceCriteria =
    input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : report.acceptanceCriteria.length > 0
        ? [...report.acceptanceCriteria]
        : [];

  let status: GoalStatus = "running";
  if (report.status === "needs_input") status = "needs_input";
  else if (report.status === "blocked") status = "blocked";
  else if (report.status === "completed") status = allCompleted ? "verifying" : "running";

  return {
    tasks,
    acceptanceCriteria,
    status,
    currentTaskId: active?.id ?? null,
    changes,
    prematureCompletion: report.status === "completed" && !allCompleted,
  };
}

const REPORT_SHAPE = `{"goal_report":{"status":"running|completed|blocked|needs_input","summary":"one short sentence about what you actually did, max 160 characters","plan":[{"title":"short task title","detail":"what this task covers"}],"tasks":[{"title":"exact existing task title","status":"completed|in_progress|failed|blocked","evidence":"files changed, commands run, or test output that proves it"}],"acceptanceCriteria":["condition that must hold to call the goal complete"],"question":"only when status is needs_input"}}`;

function criteriaSection(goal: Goal): string {
  if (goal.acceptanceCriteria.length === 0) {
    return "Acceptance criteria: none were given by the user. Propose 1-4 concrete, checkable criteria in this turn's report (acceptanceCriteria) before you start work.";
  }
  return `Acceptance criteria:\n${goal.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`;
}

function progressSection(goal: Goal): string {
  if (goal.tasks.length === 0) return "Plan: not created yet.";
  const lines = goal.tasks.map((task) => {
    const evidence = task.evidence === null ? "" : ` — evidence: ${task.evidence}`;
    return `- [${task.status}] ${task.title}${evidence}`;
  });
  return `Plan so far (server-tracked, authoritative):\n${lines.join("\n")}`;
}

const RULES = `Rules:
- Do the work in this workspace with your tools. Do not only describe what you would do.
- Keep the chat update short: one plain sentence about what you changed and what happens next, no headings or bullet lists unless the task itself needs them. Put proof in the report evidence, not in prose.
- Never report a task completed unless it is actually done, and never invent test results, file changes, or command output.
- Report real evidence: the files you changed, the commands you ran, and what they printed.
- Ask for clarification only when you cannot proceed without information only the user has; then set status "needs_input" with a single question.
- If you are blocked (missing access, failing dependency, contradictory requirement), set status "blocked" and explain precisely what stopped you. Do not retry the same failing action forever.
- End your reply with exactly one fenced JSON block tagged goal, in this shape:
\`\`\`goal
${REPORT_SHAPE}
\`\`\``;

export function buildGoalPlanningPrompt(goal: Goal): string {
  return `You are executing a persistent goal in Goal Mode.

Objective from the user:
${goal.objective}

${criteriaSection(goal)}

This is the planning turn. First inspect the project well enough to make a real plan. Then:
1. Break the objective into the smallest number of concrete, verifiable tasks (3-8 for most work, fewer for small work). Order them so each builds on the previous one.
2. Start the first task in this same turn if it fits, and report it as in_progress or completed with evidence.

${RULES}`;
}

export function buildGoalExecutionPrompt(input: {
  readonly goal: Goal;
  readonly task: GoalTask;
  readonly edited: boolean;
}): string {
  const { goal, task } = input;
  const remaining = goal.tasks.filter((candidate) => candidate.status !== "completed");
  return `You are executing a persistent goal in Goal Mode.

Objective from the user:
${goal.objective}

${criteriaSection(goal)}

${progressSection(goal)}

${input.edited ? "The user edited this goal since the last turn. Keep every completed task as done, revise only what remains, and follow the updated objective above.\n" : ""}Your task this turn: "${task.title}"${task.detail === null ? "" : `\nWhat it covers: ${task.detail}`}

Do the actual work now. When you finish it, report it completed with evidence; if it fails, report it failed with the error; if it needs the user, report needs_input with the question. Do not start other tasks in this turn beyond what this one requires.
Still open after this: ${remaining.length === 0 ? "nothing" : remaining.map((candidate) => candidate.title).join("; ")}

${RULES}`;
}

export function buildGoalVerificationPrompt(goal: Goal): string {
  const criteria =
    goal.acceptanceCriteria.length === 0
      ? "No acceptance criteria were recorded; derive them from the objective and check each one."
      : goal.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n");
  return `You are verifying a persistent goal in Goal Mode. Do not start new work unless verification fails.

Objective from the user:
${goal.objective}

Check every acceptance criterion against the actual workspace. Run the tests, typecheck, build, or commands that prove the behaviour. Reading code is not proof when a check can be run.

Acceptance criteria:
${criteria}

${progressSection(goal)}

Set "verified": true only if every criterion is demonstrably satisfied right now. Otherwise set "verified": false, list each criterion with met: false and the reason, and set status "running" so the server can dispatch one repair turn.

${RULES}`;
}

export function buildGoalRepairPrompt(goal: Goal): string {
  const reason =
    goal.verification.summary ??
    "Verification did not confirm that the acceptance criteria are satisfied.";
  return `You are repairing a persistent goal in Goal Mode. The verification pass did not pass.

Objective from the user:
${goal.objective}

Why verification failed: ${reason}

${criteriaSection(goal)}

${progressSection(goal)}

Fix only what is needed to satisfy the criteria, then re-run the checks that prove it. Report what you changed with real evidence. Do not claim success without proof.

${RULES}`;
}

export function buildGoalAnswerPrompt(input: {
  readonly goal: Goal;
  readonly question: string;
  readonly answer: string;
}): string {
  return `You are continuing a persistent goal in Goal Mode.

Objective from the user:
${input.goal.objective}

You previously asked: ${input.question}
The user answered: ${input.answer}

Continue the plan with that answer. Do not repeat completed work.

${progressSection(input.goal)}

${RULES}`;
}

export function buildGoalEditPrompt(goal: Goal): string {
  return `You are revising a persistent goal in Goal Mode.

Updated objective from the user:
${goal.objective}

${criteriaSection(goal)}

${progressSection(goal)}

Keep every completed task as completed. Update the remaining plan if the change requires it, then continue with the next open task. Do not restart finished work.

${RULES}`;
}
