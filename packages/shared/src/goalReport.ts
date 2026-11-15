import {
  GOAL_MAX_TASKS,
  type GoalBlocker,
  type GoalProof,
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

export type GoalReportStatus = "running" | "recovering" | "needs_input" | "completed" | "planning";

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

/**
 * A report that asks to be blocked lands in recovery.
 *
 * There is no blocked state to land in: the agent works the obstacle in as
 * many turns as it needs, so an older report asking for a block is an
 * obstacle like any other.
 */
function asReportStatus(value: unknown): GoalReportStatus | null {
  if (typeof value !== "string") return null;
  if ((REPORT_STATUSES as ReadonlyArray<string>).includes(value)) {
    return value as GoalReportStatus;
  }
  return value === "blocked" || value === "failed" ? "recovering" : null;
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
  // No toReversed: shared ships to Hermes, which does not implement it.
  return closers.length === 0 ? trimmed : trimmed + [...closers].reverse().join("");
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

export interface GoalReportSplit {
  /** The message with the report's own fence taken out. Every other code block stays. */
  readonly prose: string;
  readonly report: GoalReport | null;
  /** The report is still being written: an unclosed fence that looks like one was held back. */
  readonly pending: boolean;
}

const REPORT_FENCE_LANGUAGES = new Set(["", "json"]);

const isReportLanguage = (language: string): boolean =>
  REPORT_FENCE_LANGUAGES.has(language) || language.startsWith("goal");

/**
 * Splits an agent message into what a person reads and the report Goal Mode reads.
 *
 * `stripGoalReport` takes out every fenced block, which is right for a one-line summary and wrong
 * for a message a person reads: a code sample in the agent's prose would vanish. This removes only
 * the fences that parse as a report.
 *
 * While a message streams, the report's fence is open until the last token arrives; with
 * `streaming` that unfinished fence is held back (`pending`) instead of showing half a JSON block.
 */
export function splitGoalReport(
  message: string,
  options?: { readonly streaming?: boolean },
): GoalReportSplit {
  const report = parseGoalReport(message);
  let prose = message;
  if (report !== null) {
    for (const match of message.matchAll(REPORT_FENCE)) {
      if (parseGoalReport(match[0]) !== null) prose = prose.replace(match[0], "");
    }
  }

  let pending = false;
  if (options?.streaming === true) {
    const fences = Array.from(prose.matchAll(/```/g));
    if (fences.length % 2 === 1) {
      const start = fences.at(-1)!.index;
      const opened = /^```([A-Za-z0-9_-]*)[ \t]*\n?([\s\S]*)$/.exec(prose.slice(start));
      const language = (opened?.[1] ?? "").toLowerCase();
      const body = (opened?.[2] ?? "").trim();
      if (
        opened !== null &&
        isReportLanguage(language) &&
        (body === "" ||
          (body.startsWith("{") && (body.includes('"goal_report"') || body.length < 24)))
      ) {
        prose = prose.slice(0, start);
        pending = true;
      }
    }
  }

  return { prose: prose.replace(/\n{3,}/g, "\n\n").trim(), report, pending };
}
