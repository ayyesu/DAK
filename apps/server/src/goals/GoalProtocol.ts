import {
  GOAL_MAX_TASKS,
  type Goal,
  type GoalActivityKind,
  type GoalBlocker,
  type GoalProof,
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

export type GoalReportStatus =
  | "running"
  | "recovering"
  | "needs_input"
  | "blocked"
  | "completed"
  | "planning";

export interface GoalReportPlanItem {
  readonly title: string;
  readonly detail: string | null;
  /**
   * Titles of earlier plan items this one needs. The server resolves them to
   * task ids, so a task waiting on the user never holds up independent work.
   */
  readonly dependsOn: ReadonlyArray<string>;
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
  /** Rich proof backing this criterion: images, screenshots, canvas, test results, etc. */
  readonly proof: ReadonlyArray<GoalProof>;
}

/**
 * What the agent needs from the user. The question alone is not enough to
 * act on: the reason, what was already tried, and the recommendation tell the
 * user whether they can answer without reading the thread.
 */
export interface GoalReportInput {
  readonly question: string;
  readonly reason: string | null;
  readonly attempted: string | null;
  readonly recommendation: string | null;
}

export interface GoalReport {
  readonly plan: ReadonlyArray<GoalReportPlanItem>;
  readonly tasks: ReadonlyArray<GoalReportTaskUpdate>;
  readonly status: GoalReportStatus;
  readonly summary: string | null;
  readonly question: string | null;
  /** The structured ask, when the agent explained what it needs. */
  readonly input: GoalReportInput | null;
  readonly acceptance: ReadonlyArray<GoalReportAcceptance>;
  readonly verified: boolean | null;
  /** Conditions the agent proposes when the user gave none. */
  readonly acceptanceCriteria: ReadonlyArray<string>;
  /** The agent's own progress estimate, 0-100. Null when not reported. */
  readonly progress: number | null;
  /** Human-readable label for the reported progress. */
  readonly progressLabel: string | null;
  /** The evidence behind a deadlock, when the agent reports one. */
  readonly blocker: GoalBlocker | null;
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

/**
 * The statuses an agent may report for a task.
 *
 * There is no "failed" here: an agent that hits an obstacle reports
 * `recovering` and lets the server decide whether to try again. The server
 * owns the terminal states, so an agent cannot strand a task.
 */
const TASK_STATUSES: ReadonlyArray<GoalTaskStatus> = [
  "pending",
  "in_progress",
  "recovering",
  "waiting_input",
  "completed",
];

const REPORT_STATUSES: ReadonlyArray<GoalReportStatus> = [
  "running",
  "recovering",
  "needs_input",
  "blocked",
  "completed",
  "planning",
];

/**
 * Both "failed" and "blocked" describe an obstacle the agent ran into, which
 * is exactly what `recovering` means: work that continues. Reports written
 * before this vocabulary existed still land in the right state.
 */
function asTaskStatus(value: unknown): GoalTaskStatus | null {
  if (typeof value !== "string") return null;
  if ((TASK_STATUSES as ReadonlyArray<string>).includes(value)) {
    return value as GoalTaskStatus;
  }
  return value === "failed" || value === "blocked" ? "recovering" : null;
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
          if (title === null) return [];
          const dependsOn = Array.isArray(item.dependsOn)
            ? item.dependsOn.flatMap((dependency): ReadonlyArray<string> => {
                if (typeof dependency !== "string") return [];
                const trimmed = dependency.trim();
                return trimmed === "" ? [] : [trimmed.slice(0, MAX_REPORT_TEXT)];
              })
            : [];
          return [{ title, detail: text(item.detail), dependsOn }];
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
          if (criterion === null) return [];
          const proof = Array.isArray(item.proof)
            ? item.proof.flatMap((p): ReadonlyArray<GoalProof> => {
                if (!isRecord(p)) return [];
                const type =
                  p.type === "image" ||
                  p.type === "screenshot" ||
                  p.type === "canvas" ||
                  p.type === "test" ||
                  p.type === "check" ||
                  p.type === "run" ||
                  p.type === "text"
                    ? p.type
                    : null;
                const url = text(p.url);
                if (type === null || url === null) return [];
                return [
                  {
                    type,
                    url,
                    thumbnailUrl: text(p.thumbnailUrl) ?? null,
                    caption: text(p.caption) ?? null,
                    createdAt: typeof p.createdAt === "string" ? p.createdAt : null,
                  },
                ];
              })
            : [];
          return [{ criterion, met: item.met === true, evidence: text(item.evidence), proof }];
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
  const input = parseInput(report.input);
  const verified = typeof report.verified === "boolean" ? report.verified : null;
  const blocker = parseBlocker(report.blocker);
  const progress =
    typeof report.progress === "number" && Number.isFinite(report.progress)
      ? Math.min(100, Math.max(0, Math.round(report.progress)))
      : null;
  const progressLabel = text(report.progressLabel);

  // An empty object must not count as a report: it would look like a turn that
  // ran and reported nothing, which the runner treats as idle progress.
  if (
    plan.length === 0 &&
    tasks.length === 0 &&
    acceptance.length === 0 &&
    acceptanceCriteria.length === 0 &&
    summary === null &&
    verified === null &&
    progress === null &&
    progressLabel === null &&
    blocker === null &&
    input === null &&
    valueHasStatus(report) === false
  ) {
    return null;
  }

  return {
    plan,
    tasks,
    status,
    summary,
    question: input?.question ?? question,
    input,
    acceptance,
    verified,
    acceptanceCriteria,
    progress,
    progressLabel,
    blocker,
  };
}

/**
 * Reads the agent's structured ask. A question without the surrounding
 * context is still usable, so the missing parts stay null rather than
 * discarding the whole thing.
 */
function parseInput(value: unknown): GoalReportInput | null {
  if (!isRecord(value)) return null;
  const question = text(value.question);
  if (question === null) return null;
  return {
    question,
    reason: text(value.reason),
    attempted: text(value.attempted),
    recommendation: text(value.recommendation),
  };
}

/**
 * Reads the evidence behind a reported deadlock. A partial assessment is
 * dropped: without every part, the server cannot tell a real deadlock from a
 * shrug, and the goal stays in recovery instead.
 */
function parseBlocker(value: unknown): GoalBlocker | null {
  if (!isRecord(value)) return null;
  const reason = text(value.reason);
  const rootCause = text(value.rootCause);
  const investigation = text(value.investigation);
  const intervention = text(value.intervention);
  if (reason === null || rootCause === null || investigation === null || intervention === null) {
    return null;
  }
  const strings = (input: unknown): ReadonlyArray<string> =>
    Array.isArray(input)
      ? input.flatMap((item) => {
          const parsed = text(item);
          return parsed === null ? [] : [parsed];
        })
      : [];
  return {
    reason,
    rootCause,
    investigation,
    attempts: strings(value.attempts),
    alternatives: strings(value.alternatives),
    intervention,
    otherTasksCanContinue: value.otherTasksCanContinue !== false,
  };
}

function valueHasStatus(report: Record<string, unknown>): boolean {
  return typeof report.status === "string";
}

/**
 * A report block can lose its closing brackets when the model's output is cut
 * short, which used to drop the whole turn as "no report". Counting brackets
 * outside strings and closing what is still open recovers those reports; a
 * block that was never closeable is returned unchanged and still fails.
 */
function closeTruncatedJson(body: string): string {
  const trimmed = body.trimEnd();
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of trimmed) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") closers.push("}");
    else if (char === "[") closers.push("]");
    else if (char === "}" || char === "]") closers.pop();
  }
  return closers.length === 0 ? trimmed : trimmed + closers.toReversed().join("");
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
      // Only ever applied after JSON.parse already failed, so a well-formed
      // report can never be rewritten by these repairs.
      try {
        parsed = JSON.parse(closeTruncatedJson(body).replace(/,\s*([}\]])/g, "$1"));
      } catch {
        continue;
      }
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
    | "plan"
    | "task_started"
    | "task_completed"
    | "task_failed"
    | "task_recovering"
    | "task_waiting_input"
    | "task_blocked"
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
  /** The agent asked the user a question; only the affected task pauses. */
  readonly question: string | null;
  /** The task the agent asked about, when the report named one. */
  readonly questionTaskTitle: string | null;
  /** The evidence the agent supplied for a deadlock, when it supplied any. */
  readonly blocker: GoalBlocker | null;
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
  // The dependencies a plan declared, by task title. They are resolved to ids
  // once every task exists, so a plan may depend on a later item.
  const plannedDependencies = new Map<string, ReadonlyArray<string>>();
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
        plannedDependencies.set(key, item.dependsOn);
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
        question: null,
        blocker: null,
        attempts: 0,
        recoveryAttempts: 0,
        reassessments: 0,
        dependsOn: [],
      });
      plannedDependencies.set(key, item.dependsOn);
      nextOrder += 1;
    }
    changes.push({
      kind: "plan",
      summary: `Plan set: ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      taskId: null,
    });

    // Resolve declared dependencies to task ids now that the plan exists. A
    // dependency on a task that is not in the plan is dropped rather than
    // stranding the task that waits on it.
    const idByTitle = new Map(tasks.map((task) => [normalizedTitle(task.title), task.id]));
    tasks = tasks.map((task) => {
      const declared = plannedDependencies.get(normalizedTitle(task.title));
      if (declared === undefined) return task;
      const dependsOn = declared
        .map((title) => idByTitle.get(normalizedTitle(title)))
        .filter((id): id is string => id !== undefined && id !== task.id);
      return dependsOn.length === 0 ? task : { ...task, dependsOn };
    });
  }

  for (const update of report.tasks) {
    const key = normalizedTitle(update.title);
    const index = tasks.findIndex((task) => normalizedTitle(task.title) === key);
    if (index === -1) {
      if (tasks.length >= GOAL_MAX_TASKS) continue;
      // A task introduced by a report has never been attempted, so it cannot
      // already be recovering or waiting on the user: it stays runnable work.
      const stranded = update.status === "recovering" || update.status === "waiting_input";
      tasks.push({
        id: input.makeTaskId(),
        title: update.title,
        detail: null,
        status: stranded ? "pending" : update.status,
        order: nextOrder,
        startedAt: update.status === "completed" ? nowIso : null,
        completedAt: update.status === "completed" ? nowIso : null,
        evidence: update.evidence,
        question: null,
        blocker: null,
        attempts: stranded ? 0 : 1,
        recoveryAttempts: 0,
        reassessments: 0,
        dependsOn: [],
      });
      nextOrder += 1;
      continue;
    }
    const current = tasks[index]!;
    // A completed task is terminal until the user retries it explicitly, so a
    // sloppy later report cannot un-complete verified work.
    if (current.status === "completed" && update.status !== "completed") continue;
    // Work nobody started cannot have hit an obstacle. Reporting it that way
    // would strand a task the loop never ran, leaving no runnable task while
    // the plan still has work to do.
    if (
      replaceable(current) &&
      (update.status === "recovering" || update.status === "waiting_input")
    ) {
      continue;
    }
    const next: GoalTask =
      update.status === "completed"
        ? {
            ...current,
            status: "completed",
            completedAt: current.completedAt ?? nowIso,
            startedAt: current.startedAt ?? nowIso,
            evidence: update.evidence ?? current.evidence,
            attempts: Math.max(current.attempts, 1),
            recoveryAttempts: 0,
            reassessments: 0,
          }
        : update.status === "in_progress"
          ? {
              ...current,
              status: "in_progress",
              startedAt: current.startedAt ?? nowIso,
            }
          : update.status === "recovering"
            ? {
                ...current,
                status: "recovering",
                startedAt: current.startedAt ?? nowIso,
                evidence: update.evidence ?? current.evidence,
              }
            : {
                ...current,
                status: update.status,
                evidence: update.evidence ?? current.evidence,
                // Re-entering a state the task is already in is a progress
                // report, not another attempt.
                startedAt:
                  update.status === "waiting_input"
                    ? (current.startedAt ?? nowIso)
                    : current.startedAt,
              };
    tasks[index] = next;
    if (next.status !== current.status) {
      changes.push({
        kind:
          next.status === "completed"
            ? "task_completed"
            : next.status === "recovering"
              ? "task_recovering"
              : next.status === "waiting_input"
                ? "task_waiting_input"
                : "task_started",
        summary:
          next.status === "completed"
            ? `Completed: ${next.title}`
            : next.status === "recovering"
              ? `Recovering: ${next.title}`
              : next.status === "waiting_input"
                ? `Waiting for input: ${next.title}`
                : `Started: ${next.title}`,
        taskId: next.id,
      });
    }
  }

  tasks = tasks.toSorted((left, right) => left.order - right.order);
  const allCompleted = tasks.length > 0 && tasks.every((task) => task.status === "completed");
  const active =
    tasks.find((task) => task.status === "in_progress") ??
    tasks.find((task) => task.status === "recovering") ??
    null;
  const acceptanceCriteria =
    input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : report.acceptanceCriteria.length > 0
        ? [...report.acceptanceCriteria]
        : [];

  // The server owns the goal-level state. A report that asks for input or
  // declares a blocker is handled by the drive loop, which pauses the task
  // and keeps the rest of the plan moving, so it never maps straight onto a
  // goal status here.
  let status: GoalStatus = "running";
  if (report.status === "planning") status = "planning";
  else if (report.status === "completed") status = allCompleted ? "verifying" : "running";

  return {
    tasks,
    acceptanceCriteria,
    status,
    currentTaskId: active?.id ?? null,
    changes,
    prematureCompletion: report.status === "completed" && !allCompleted,
    question: report.status === "needs_input" ? (report.question ?? null) : null,
    questionTaskTitle:
      report.status === "needs_input"
        ? (report.tasks.find((task) => task.status === "waiting_input")?.title ?? null)
        : null,
    blocker: report.blocker,
  };
}

const REPORT_SHAPE = `{"goal_report":{"status":"running|recovering|completed|blocked|needs_input|planning","summary":"one short sentence about what you actually did, max 160 characters","plan":[{"title":"short task title","detail":"what this task covers","dependsOn":["title of a task that must finish first"]}],"tasks":[{"title":"exact existing task title","status":"pending|in_progress|recovering|waiting_input|completed|failed","evidence":"files changed, commands run, or test output that proves it"}],"acceptance":[{"criterion":"exact acceptance criterion text","met":true,"evidence":"the command you ran and what it proved","proof":[{"type":"image|screenshot|canvas|test|check|run|text","url":"https://...","thumbnailUrl":"https://...","caption":"what this proof shows","createdAt":"ISO timestamp"}]}],"verified":false,"acceptanceCriteria":["condition that must hold to call the goal complete"],"progress":0,"progressLabel":"short phrase describing progress","input":{"question":"the one thing you need from the user","reason":"why you cannot proceed without it","attempted":"what you already tried","recommendation":"the option you suggest"},"question":"only when status is needs_input","blocker":{"reason":"the exact thing that stopped you","rootCause":"why it is true","investigation":"what you inspected to find it","attempts":["what you tried"],"alternatives":["what else you considered and why it did not work"],"intervention":"the one thing only the user or an external system can provide","otherTasksCanContinue":true}}`;

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
- Keep the chat update short: one plain sentence about what you changed and what happens next, no headings or bullet lists unless the task itself needs them. Put proof in the report evidence and proof array, not in prose.
- Report real progress every turn: set "progress" to a number 0-100 for how far along the whole goal is, and "progressLabel" to a short phrase (e.g. "Planning the work", "Working on task 2 of 5", "Verifying the result"). The card shows this instead of guessing.
- Never report a task completed unless it is actually done, and never invent test results, file changes, or command output.
- Report real evidence: the files you changed, the commands you ran, and what they printed.
- A task you have not started yet is "pending". Never report a task you did not attempt as "failed": that is only for work you actually tried this turn.
- Work through obstacles yourself. When something fails, read the output, find the cause, fix it, and run it again in this same turn. A build error, a failing test, a missing import, or a bad assumption is your problem to solve, not the user's.
- Set a task to "recovering" when you hit an obstacle you are actively working through: say what failed, what you found, and what you are trying next. Keep working on it in the same turn when you can.
- A retry must first say why the previous attempt failed, then take a different approach. Never repeat the same failing operation unchanged. If the evidence says your approach is wrong, change the approach.
- When you report "verified", every entry in "acceptance" must carry proof that proves it. Proof can be images, screenshots, canvas output, test results, check output, or run output. A criterion without proof counts as not met. Attach screenshots, images, or canvas exports with a URL and a caption describing what they show.
- Ask for clarification only when you cannot proceed without information only the user has (a credential, a business decision, access you cannot get yourself); then set status "needs_input" with one specific question and say what you already tried. Everything else is yours to solve.
- Set status "planning" only while you are still deciding what to do; use "running" once you are executing the plan, so the card shows what is happening.
- Use status "blocked" only as a last resort, after you have already tried and ruled out the reasonable approaches: set the task to "recovering" and describe the exact blocker, its root cause, what you investigated, what you tried, which alternatives you rejected and why, and what only the user can unblock. A vague reason is not accepted and the goal will be sent back to you.
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
  const recovery =
    task.attempts <= 1
      ? ""
      : `This is attempt ${task.attempts} at this task.${
          task.evidence === null
            ? " The earlier attempt recorded no reason, so establish first why it did not finish."
            : ` The previous attempt failed with: ${task.evidence}`
        }\nDiagnose that failure, then take a different approach. Do not repeat the same failing operation unchanged.\n`;
  return `You are executing a persistent goal in Goal Mode.

Objective from the user:
${goal.objective}

${criteriaSection(goal)}

${progressSection(goal)}

${input.edited ? "The user edited this goal since the last turn. Keep every completed task as done, revise only what remains, and follow the updated objective above.\n" : ""}Your task this turn: "${task.title}"${task.detail === null ? "" : `\nWhat it covers: ${task.detail}`}

${recovery}Do the actual work now. When you finish it, report it completed with evidence. If you hit an obstacle, work through it in this turn: report the task as "recovering" with what failed, what you found, and what you changed, then keep going. If it truly cannot move without the user, report needs_input with the question. Do not start other tasks in this turn beyond what this one requires.
Still open after this: ${remaining.length === 0 ? "nothing" : remaining.map((candidate) => candidate.title).join("; ")}

${RULES}`;
}

/**
 * The turn that follows a failed attempt. It hands the agent the evidence of
 * what failed and asks for a diagnosis and a different approach, because the
 * default reaction to a failure is to repeat it.
 */
export function buildGoalRecoveryPrompt(input: {
  readonly goal: Goal;
  readonly task: GoalTask | null;
  /** What the previous attempt reported as the cause. */
  readonly failure: string | null;
  /** Which recovery attempt this is, counting from one. */
  readonly recoveryAttempt: number;
}): string {
  const { goal, task } = input;
  const failure =
    input.failure === null || input.failure.trim() === ""
      ? "The previous attempt failed without recording a reason."
      : `The previous attempt failed with: ${input.failure}`;
  const taskLine =
    task === null
      ? "The goal as a whole could not make progress."
      : `Your task this turn: "${task.title}"${task.detail === null ? "" : `\nWhat it covers: ${task.detail}`}`;
  const remaining = goal.tasks.filter((candidate) => candidate.status !== "completed");
  return `You are recovering a persistent goal in Goal Mode.

Objective from the user:
${goal.objective}

${criteriaSection(goal)}

${progressSection(goal)}

${taskLine}

${failure}

This is recovery attempt ${input.recoveryAttempt}. Work the problem before asking anyone:
1. Read the actual output and locate the cause. Do not guess from the summary.
2. Decide whether you can fix it yourself. Missing details, a wrong assumption, a broken build, a failing test, or a dependency conflict are yours to resolve.
3. Try a different approach than the one that failed, and validate it by running the check again.
4. Only if you truly cannot proceed without the user, report needs_input with one specific question naming what you need and what you already tried.

Do not repeat the same failing operation unchanged. Report the task as "recovering" while you work on it, and "completed" with evidence when the check passes.
Still open after this: ${remaining.length === 0 ? "nothing" : remaining.map((candidate) => candidate.title).join("; ")}

${RULES}`;
}

/**
 * The turn that follows an exhausted recovery budget. It asks for an
 * evidence-based assessment instead of another attempt, so the goal only
 * stops when the reason is a real deadlock.
 */
export function buildGoalReassessmentPrompt(input: {
  readonly goal: Goal;
  readonly task: GoalTask | null;
  /** Why the server asked for a reassessment. */
  readonly reason: string;
  /** The failure evidence collected so far. */
  readonly failure: string | null;
}): string {
  const { goal } = input;
  const taskLine =
    input.task === null
      ? "The whole goal is being reassessed."
      : `The task being reassessed is "${input.task.title}"${input.task.detail === null ? "" : ` (${input.task.detail})`}.`;
  const failure =
    input.failure === null || input.failure.trim() === ""
      ? ""
      : `\nWhat failed so far:\n${input.failure}\n`;
  return `You are reassessing a persistent goal in Goal Mode.

Objective from the user:
${goal.objective}

${criteriaSection(goal)}

${progressSection(goal)}

${taskLine}

Why the server asked for this: ${input.reason}
${failure}
Recovery attempts have not produced a result, so repeating them is not useful. Assess the situation and pick one of these outcomes:

1. A different approach exists. Describe it concretely and start it now in this same turn: report the task as "in_progress" or "recovering" with the new approach in the evidence, and keep working.
2. The goal needs the user. Report needs_input with one specific question, and say what you already tried and what the answer unblocks.
3. This is a real deadlock. Report status "blocked" and the task as "recovering", and state all of it in the evidence: the exact blocker, its root cause, what you investigated, what you tried, the alternatives you rejected and why, and the one thing only the user or an external system can provide. A vague reason is rejected and the goal comes straight back to you.

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

Check every acceptance criterion against the actual workspace. Run the tests, typecheck, build, or commands that prove the behaviour. Reading code is not proof when a check can be run. Capture screenshots, images, canvas output, test results, or run output as proof attached to each criterion.

Acceptance criteria:
${criteria}

${progressSection(goal)}

Set "verified": true only if every criterion is demonstrably satisfied right now, and set status "completed". Otherwise set "verified": false, set status "running" so the server can dispatch a repair turn, and list every criterion in "acceptance" with its exact text, met: false, and what is missing. Every criterion that is met must carry proof in its "proof" array: images, screenshots, canvas exports, test results, check output, or run output with a URL and caption. A criterion without proof counts as not met.

${RULES}`;
}

export function buildGoalRepairPrompt(goal: Goal): string {
  const reason =
    goal.verification.summary ??
    "Verification did not confirm that the acceptance criteria are satisfied.";
  const criteria = goal.verification.criteria ?? [];
  const unmet = criteria.filter((result) => !result.met);
  const unmetSection =
    unmet.length === 0
      ? ""
      : `Criteria verification did not accept:\n${unmet.map((result) => `- ${result.criterion}`).join("\n")}\n\n`;
  return `You are repairing a persistent goal in Goal Mode. The verification pass did not pass.

Objective from the user:
${goal.objective}

Why verification failed: ${reason}

${unmetSection}${criteriaSection(goal)}

${progressSection(goal)}

Fix only what is needed to satisfy the criteria, then re-run the checks that prove it. Report what you changed with real evidence. Every criterion you claim is met must carry proof in its "proof" array: images, screenshots, canvas exports, test results, check output, or run output with a URL and caption. Do not claim success without proof.
If a check keeps failing, find out why and fix the cause instead of re-running the same command: report the task as "recovering" with what the failure actually is and what you changed.

${RULES}`;
}

export function buildGoalAnswerPrompt(input: {
  readonly goal: Goal;
  readonly question: string;
  readonly answer: string;
  /** The task the question belongs to, when the goal named one. */
  readonly task: GoalTask | null;
}): string {
  const taskLine =
    input.task === null ? "" : `\nThe task you asked about is "${input.task.title}".\n`;
  return `You are continuing a persistent goal in Goal Mode.

Objective from the user:
${input.goal.objective}

You previously asked: ${input.question}
The user answered: ${input.answer}
${taskLine}
Continue the plan with that answer. Do not repeat completed work. Everything else in the plan stayed as it was, so pick up where you left off.

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
