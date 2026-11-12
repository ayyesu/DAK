import {
  CommandId,
  GOAL_ACTIVITY_LIMIT,
  GOAL_IDLE_ESCALATION_CYCLES,
  GOAL_RECOVERY_ATTEMPTS,
  GoalBlocker,
  GoalError,
  GoalId,
  GoalStatus,
  GoalTaskStatus,
  GoalVerification,
  MessageId,
  ModelSelection,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2Run,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ThreadId,
  type Goal,
  type GoalActivity,
  type GoalActivityKind,
  type GoalAnswerInput,
  type GoalCancelInput,
  type GoalCreateInput,
  type GoalGetInput,
  type GoalListInput,
  type GoalListResult,
  type GoalMutationResult,
  type GoalPauseInput,
  type GoalResumeInput,
  type GoalRetryTaskInput,
  type GoalSummary,
  type GoalTask,
  type GoalUpdateInput,
  type GoalWatchInput,
  type RunId,
} from "@dak/contracts";
import { latestRootProviderFailure } from "@dak/shared/orchestrationV2ThreadError";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import {
  applyGoalReport,
  buildGoalAnswerPrompt,
  buildGoalEditPrompt,
  buildGoalExecutionPrompt,
  buildGoalPlanningPrompt,
  buildGoalReassessmentPrompt,
  buildGoalRecoveryPrompt,
  buildGoalRepairPrompt,
  buildGoalVerificationPrompt,
  parseGoalReport,
  type GoalPlanHandling,
  type GoalReport,
} from "./GoalProtocol.ts";

/** One agent turn may take a long time; this is when the server stops waiting. */
const GOAL_TURN_TIMEOUT_MS = 20 * 60 * 1_000;
/**
 * How often a turn in flight re-notifies goal subscribers. The record itself
 * does not change while a turn runs, so without this a client cannot tell a
 * live turn from a stalled one. Exported for the heartbeat test.
 */
export const GOAL_TURN_HEARTBEAT_MS = 25_000;
/** Boot delay before interrupted goals resume, so provider runtimes are up. */
const GOAL_RECOVERY_DELAY = Duration.seconds(15);
/** A driven goal this old with no driver is stuck, not waiting for a turn. */
const GOAL_STUCK_THRESHOLD = Duration.seconds(10);
/** How often the sweep looks for driven goals whose driver died. */
const GOAL_STUCK_SWEEP_INTERVAL = Duration.seconds(60);
const ACTIVITY_DETAIL_LIMIT = 2_000;

const DRIVEN_STATUSES: ReadonlySet<Goal["status"]> = new Set([
  "planning",
  "running",
  "recovering",
  "verifying",
]);
/** Terminal states. `failed` is deliberately absent: resume or edit recovers it. */
const ENDED_STATUSES: ReadonlySet<Goal["status"]> = new Set(["completed", "cancelled"]);

/**
 * Failure classes the environment caused.
 *
 * A provider that is not installed, not signed in, rate limited or briefly
 * unreachable is not the agent's fault, so these failures park the goal
 * instead of counting against the agent's attempts. Everything else is the
 * agent's own obstacle and goes through the recovery ladder.
 */
const PROVIDER_FAULT_CLASSES: ReadonlySet<OrchestrationV2ProviderFailure["class"]> = new Set([
  "usage_limit",
  "provider_error",
  "transport_error",
]);
/** First delay before a parked goal tries again. */
const PROVIDER_RETRY_BASE_MS = 30_000;
/** Longest the server waits before trying a parked goal again. */
const PROVIDER_RETRY_MAX_MS = 15 * 60_000;
/** How often the sweep looks for a parked goal whose moment has come. */
const GOAL_PARKED_SWEEP_INTERVAL = Duration.seconds(5);

/**
 * How long the server waits before repeating a turn that produced nothing.
 *
 * A confused agent answers fast, so the pause grows with every idle turn:
 * the goal keeps trying, but it stops burning a turn every few seconds.
 */
const stallDelay = (idleCycles: number) =>
  Duration.millis(Math.min(15_000 * 2 ** Math.max(0, idleCycles - 1), 5 * 60_000));

type TurnPhase = "plan" | "task" | "verify" | "repair" | "answer" | "edit" | "recover" | "reassess";

/**
 * What one dispatched turn produced.
 *
 * `failed` carries the provider failure when there was one, because that
 * failure decides whether the goal parks or the agent recovers.
 */
type GoalTurnOutcome =
  | { readonly kind: "report"; readonly record: GoalRecord; readonly report: GoalReport }
  | { readonly kind: "no_report"; readonly record: GoalRecord; readonly report: null }
  | {
      readonly kind: "failed";
      readonly record: GoalRecord;
      readonly report: null;
      readonly providerFailure: OrchestrationV2ProviderFailure | null;
    }
  | { readonly kind: "interrupted"; readonly record: GoalRecord; readonly report: null }
  | { readonly kind: "relaunch"; readonly record: GoalRecord; readonly report: null }
  | { readonly kind: "stopped"; readonly record: GoalRecord; readonly report: null }
  | { readonly kind: "parked"; readonly record: GoalRecord; readonly report: null };

/**
 * Which kind of turn produced a report. It decides how the report is read: a
 * blocker only counts as evidence when it came from a reassessment.
 */
type GoalTurnMode =
  | "plan"
  | "task"
  | "verify"
  | "repair"
  | "answer"
  | "edit"
  | "recover"
  | "reassess";

interface GoalRow {
  readonly goal_id: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly title: string;
  readonly objective: string;
  readonly acceptance_criteria_json: string;
  readonly status: string;
  readonly current_task_id: string | null;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly workspace_strategy_json: string;
  readonly revision: number;
  readonly cycle_count: number;
  readonly verification_json: string;
  readonly blocked_reason: string | null;
  readonly failure_reason: string | null;
  readonly question: string | null;
  readonly question_task_id: string | null;
  readonly blocker_json: string | null;
  readonly progress: number | null;
  readonly progress_label: string | null;
  readonly pending_edit: number;
  readonly pending_answer: string | null;
  readonly provider_wait_json: string | null;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly turn_started_at: string | null;
  readonly completed_at: string | null;
  readonly last_activity_at: string;
}

interface GoalTaskRow {
  readonly goal_id: string;
  readonly task_id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly status: string;
  readonly task_order: number;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly evidence: string | null;
  readonly question: string | null;
  readonly blocker_json: string | null;
  readonly attempts: number;
  readonly recovery_attempts: number;
  readonly reassessments: number;
  readonly depends_on_json: string;
}

interface GoalActivityRow {
  readonly activity_id: string;
  readonly goal_id: string;
  readonly at: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly task_id: string | null;
}

/** The goal columns a summary needs; the activities are not among them. */
interface GoalSummaryRow {
  readonly goal_id: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly title: string;
  readonly status: string;
  readonly current_task_id: string | null;
  readonly blocked_reason: string | null;
  readonly failure_reason: string | null;
  readonly question: string | null;
  readonly progress: number | null;
  readonly progress_label: string | null;
  readonly turn_started_at: string | null;
  readonly updated_at: string;
  readonly last_activity_at: string;
  readonly completed_at: string | null;
}

/** The task columns a summary needs. */
interface GoalSummaryTaskRow {
  readonly goal_id: string;
  readonly task_id: string;
  readonly title: string;
  readonly status: string;
}

/**
 * What a watcher compares to decide whether a goal actually changed.
 *
 * The newest activity's id is part of it because activities are written
 * after the goal row, so two reads of an unchanged row can still differ in
 * the activity log.
 */
function goalFingerprint(goal: Goal): string {
  const newestActivity = goal.activities.at(-1);
  return [
    goal.updatedAt,
    goal.cycleCount,
    goal.revision,
    goal.status,
    goal.activities.length,
    newestActivity?.id ?? "",
  ].join("|");
}

/**
 * A goal plus the driver state that never crosses the wire. Rows are read as
 * one record so a mutation and the loop cannot disagree about the plan.
 */
interface GoalRecord {
  readonly goal: Goal;
  readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  readonly pendingEdit: boolean;
  readonly pendingAnswer: string | null;
  /**
   * Why the goal is parked and when it may try again. It is driver state: the
   * wire only learns that the goal is waiting for the provider.
   */
  readonly providerWait: GoalProviderWait | null;
}

/** A parked goal's provider fault and the moment the server tries again. */
interface GoalProviderWait {
  /** The provider failure class that parked the goal. */
  readonly class: OrchestrationV2ProviderFailure["class"];
  /** What the provider reported, in its own words. */
  readonly message: string;
  /** When the server tries the turn again. */
  readonly resumeAt: string;
  /** Consecutive provider faults; the delay grows with it. */
  readonly attempt: number;
}

interface GoalActivityInput {
  readonly kind: GoalActivityKind;
  readonly summary: string;
  readonly detail?: string | null;
  readonly taskId?: string | null;
}

const decodeCriteria = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeCriteria = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const decodeWorkspaceStrategy = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ThreadLaunchWorkspaceStrategy),
);
const encodeWorkspaceStrategy = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationV2ThreadLaunchWorkspaceStrategy),
);
const decodeVerification = Schema.decodeUnknownEffect(Schema.fromJsonString(GoalVerification));
const encodeVerification = Schema.encodeSync(Schema.fromJsonString(GoalVerification));
const decodeBlocker = Schema.decodeUnknownOption(Schema.fromJsonString(GoalBlocker));
const encodeBlocker = Schema.encodeSync(Schema.fromJsonString(GoalBlocker));
const decodeDependsOn = (value: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => (typeof item === "string" && item !== "" ? [item] : []));
  } catch {
    return [];
  }
};
const encodeDependsOn = (value: ReadonlyArray<string>): string => JSON.stringify([...value]);
const GoalProviderWaitSchema = Schema.Struct({
  class: OrchestrationV2ProviderFailureClass,
  message: Schema.String,
  resumeAt: Schema.String,
  attempt: Schema.Int,
});
const decodeProviderWait = Schema.decodeUnknownOption(Schema.fromJsonString(GoalProviderWaitSchema));
const encodeProviderWait = Schema.encodeSync(Schema.fromJsonString(GoalProviderWaitSchema));
const decodeGoalStatus = Schema.decodeUnknownOption(GoalStatus);
const decodeTaskStatus = Schema.decodeUnknownOption(GoalTaskStatus);
const decodeActor = Schema.decodeUnknownOption(
  Schema.Literals(["user", "agent", "system"] as const),
);
const decodeCreationSource = Schema.decodeUnknownOption(
  Schema.Literals(["web", "mobile", "mcp", "provider", "server"] as const),
);
const decodeActivityKind = Schema.decodeUnknownOption(
  Schema.Literals([
    "created",
    "plan",
    "task_started",
    "task_completed",
    "task_failed",
    "task_recovering",
    "task_waiting_input",
    "task_blocked",
    "status",
    "prompt",
    "user",
    "recovery",
    "reassessment",
    "verification",
    "error",
  ] as const),
);

const nowIso = Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));

const isGoalError = Schema.is(GoalError);

function toGoalError(cause: unknown, goalId?: string): GoalError {
  if (isGoalError(cause)) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new GoalError({
    message: detail,
    ...(goalId === undefined ? {} : { goalId: GoalId.make(goalId) }),
    cause,
  });
}

function deriveTitle(objective: string): string {
  const singleLine = objective.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= 60) return singleLine;
  const cut = singleLine.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function clipDetail(value: string): string {
  return value.length <= ACTIVITY_DETAIL_LIMIT
    ? value
    : `${value.slice(0, ACTIVITY_DETAIL_LIMIT)}…`;
}

function normalizedCriterion(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function normalizedTitle(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function isDriven(status: Goal["status"]): boolean {
  return DRIVEN_STATUSES.has(status);
}

function hasEnded(status: Goal["status"]): boolean {
  return ENDED_STATUSES.has(status);
}

/**
 * What the driver does with a task that reported an obstacle.
 *
 * `recover` sends another turn with the failure as context, `reassess` asks
 * the agent for an evidence-based assessment before anything is given up on.
 * A reassessment that comes back without usable evidence is treated as another
 * failure, so a vague answer never ends the loop.
 */
export type GoalTaskRecovery =
  | { readonly kind: "recover"; readonly attempt: number }
  | { readonly kind: "reassess"; readonly attempt: number };

/**
 * The recovery ladder for one task.
 *
 * The first few failures get a recovery turn: the agent is told what broke
 * and asked to work it out. Past that budget every further attempt is a
 * reassessment, and reassessments never run out. The ladder has no last rung:
 * a task is only stopped by an assessment that names a real external blocker
 * or by the user, never by a counter. Every rung here re-tries the work, so
 * the ladder never turns a hard problem into a surrender.
 */
function planGoalTaskRecovery(input: {
  readonly recoveryAttempts: number;
  readonly reassessments: number;
}): GoalTaskRecovery {
  if (input.recoveryAttempts < GOAL_RECOVERY_ATTEMPTS) {
    return { kind: "recover", attempt: input.recoveryAttempts + 1 };
  }
  return { kind: "reassess", attempt: input.reassessments + 1 };
}

export { GOAL_RECOVERY_ATTEMPTS };

/**
 * The task the loop works on next.
 *
 * A task waiting on the user is skipped, so an open question never stops
 * independent work. A task whose prerequisites are unresolved is skipped too,
 * and becomes runnable again the moment they are satisfied. Work already in
 * flight wins over untouched work, which wins over a task that is being
 * recovered: an obstacle does not hold up the rest of the plan.
 */
function selectNextTask(tasks: ReadonlyArray<GoalTask>): GoalTask | undefined {
  const completed = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );
  const runnable = tasks.filter(
    (task) =>
      task.status !== "completed" &&
      task.status !== "waiting_input" &&
      task.status !== "failed" &&
      task.dependsOn.every((dependency) => completed.has(dependency)),
  );
  return (
    runnable.find((task) => task.status === "in_progress") ??
    runnable.find((task) => task.status === "pending" && task.startedAt === null) ??
    runnable.find((task) => task.status === "recovering") ??
    runnable.find((task) => task.status === "pending")
  );
}

export class GoalService extends Context.Service<
  GoalService,
  {
    readonly list: (input: GoalListInput) => Effect.Effect<GoalListResult, GoalError>;
    /** Snapshot on subscribe, then a fresh list after every goal change. */
    readonly subscribeList: (input: GoalListInput) => Stream.Stream<GoalListResult, GoalError>;
    /**
     * One goal's live detail. Clients open this while the user is looking at
     * the goal, so the detail payload is built for that goal alone.
     */
    readonly watchGoal: (input: GoalWatchInput) => Stream.Stream<GoalMutationResult, GoalError>;
    readonly get: (input: GoalGetInput) => Effect.Effect<GoalMutationResult, GoalError>;
    readonly create: (input: GoalCreateInput) => Effect.Effect<GoalMutationResult, GoalError>;
    readonly update: (input: GoalUpdateInput) => Effect.Effect<GoalMutationResult, GoalError>;
    readonly pause: (input: GoalPauseInput) => Effect.Effect<GoalMutationResult, GoalError>;
    readonly resume: (input: GoalResumeInput) => Effect.Effect<GoalMutationResult, GoalError>;
    readonly cancel: (input: GoalCancelInput) => Effect.Effect<GoalMutationResult, GoalError>;
    readonly answer: (input: GoalAnswerInput) => Effect.Effect<GoalMutationResult, GoalError>;
    readonly retryTask: (input: GoalRetryTaskInput) => Effect.Effect<GoalMutationResult, GoalError>;
    /**
     * Blocks driven goals nobody is driving. Runs on a timer; tests call it
     * directly instead of waiting for the clock.
     */
    readonly sweepStuckGoals: () => Effect.Effect<void, GoalError>;
    /** Brings back the goals whose provider wait is over. */
    readonly sweepParkedGoals: () => Effect.Effect<void, GoalError>;
  }
>()("dak/goals/GoalService") {}

export const layer = Layer.effect(
  GoalService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const scope = yield* Effect.scope;
    const changes = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    // One driver per goal. The ref is the duplicate-execution guard: a second
    // start for a goal already driving is a no-op, not a second loop.
    const drivers = yield* Ref.make<ReadonlySet<string>>(new Set());
    // Drive attempts that arrive while a driver is already active. Consumed on
    // driver exit so a driven state committed in that window gets a driver again.
    const pendingDrives = yield* Ref.make<ReadonlySet<string>>(new Set());

    const readTaskRows = (goalId: string) => sql<GoalTaskRow>`
      SELECT * FROM goal_tasks WHERE goal_id = ${goalId} ORDER BY task_order ASC, task_id ASC
    `;

    const readActivityRows = (goalId: string) => sql<GoalActivityRow>`
      SELECT * FROM goal_activities
      WHERE goal_id = ${goalId}
      ORDER BY at DESC, activity_id DESC
      LIMIT ${GOAL_ACTIVITY_LIMIT}
    `;

    const decodeTask = (row: GoalTaskRow): GoalTask => ({
      id: row.task_id,
      title: row.title,
      detail: row.detail,
      status: Option.getOrElse(decodeTaskStatus(row.status), () => "pending" as const),
      order: row.task_order,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      evidence: row.evidence,
      question: row.question,
      blocker: Option.getOrElse(decodeBlocker(row.blocker_json), () => null),
      attempts: row.attempts,
      recoveryAttempts: row.recovery_attempts,
      reassessments: row.reassessments,
      dependsOn: decodeDependsOn(row.depends_on_json),
    });

    const decodeActivity = (row: GoalActivityRow): GoalActivity => ({
      id: row.activity_id,
      at: row.at,
      kind: Option.getOrElse(decodeActivityKind(row.kind), () => "status" as const),
      summary: row.summary,
      detail: row.detail,
      taskId: row.task_id,
    });

    const decodeRecord = Effect.fn("GoalService.decodeRecord")(function* (row: GoalRow) {
      const taskRows = yield* readTaskRows(row.goal_id);
      const activityRows = yield* readActivityRows(row.goal_id);
      const acceptanceCriteria = yield* decodeCriteria(row.acceptance_criteria_json);
      const modelSelection = yield* decodeModelSelection(row.model_selection_json);
      const workspaceStrategy = yield* decodeWorkspaceStrategy(row.workspace_strategy_json);
      const verification = yield* decodeVerification(row.verification_json);
      const goal: Goal = {
        id: GoalId.make(row.goal_id),
        projectId: row.project_id as Goal["projectId"],
        threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
        title: row.title,
        objective: row.objective,
        acceptanceCriteria,
        status: Option.getOrElse(decodeGoalStatus(row.status), () => "failed" as const),
        tasks: taskRows.map(decodeTask),
        activities: activityRows.map(decodeActivity).toReversed(),
        currentTaskId: row.current_task_id,
        modelSelection,
        runtimeMode: row.runtime_mode as Goal["runtimeMode"],
        interactionMode: row.interaction_mode as Goal["interactionMode"],
        revision: row.revision,
        cycleCount: row.cycle_count,
        verification,
        blockedReason: row.blocked_reason,
        failureReason: row.failure_reason,
        question: row.question,
        questionTaskId: row.question_task_id,
        blocker: Option.getOrElse(decodeBlocker(row.blocker_json), () => null),
        progress: row.progress,
        progressLabel: row.progress_label,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        turnStartedAt: row.turn_started_at,
        completedAt: row.completed_at,
        lastActivityAt: row.last_activity_at,
        createdBy: Option.getOrElse(decodeActor(row.created_by), () => "system" as const),
        creationSource: Option.getOrElse(
          decodeCreationSource(row.creation_source),
          () => "server" as const,
        ),
      };
      return {
        goal,
        workspaceStrategy,
        pendingEdit: row.pending_edit === 1,
        pendingAnswer: row.pending_answer,
        providerWait: Option.getOrElse(decodeProviderWait(row.provider_wait_json), () => null),
      } satisfies GoalRecord;
    });

    const decodeRecordError = (goalId: string, cause: unknown) =>
      new GoalError({
        message: "Could not read the stored goal.",
        goalId: GoalId.make(goalId),
        cause,
      });

    const readRecord = Effect.fn("GoalService.readRecord")(function* (goalId: GoalId) {
      const rows = yield* sql<GoalRow>`SELECT * FROM goals WHERE goal_id = ${goalId}`;
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeRecord(row).pipe(
        Effect.mapError((cause) => decodeRecordError(goalId, cause)),
      );
    });

    const readRecordOrFail = (goalId: GoalId) =>
      Effect.flatMap(readRecord(goalId), (record) =>
        record === null
          ? Effect.fail(new GoalError({ message: "Goal not found.", goalId }))
          : Effect.succeed(record),
      );

    const writeRecord = Effect.fn("GoalService.writeRecord")(function* (record: GoalRecord) {
      const { goal } = record;
      // The goal row and its tasks are one fact. Writing them in a single
      // transaction keeps a reader from seeing a goal with no tasks, and stops
      // two writers from dropping each other's task rows.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
        INSERT INTO goals (
          goal_id, project_id, thread_id, title, objective, acceptance_criteria_json, status,
          current_task_id, model_selection_json, runtime_mode, interaction_mode,
          workspace_strategy_json, revision, cycle_count, verification_json, blocked_reason,
          failure_reason, question, question_task_id, blocker_json, pending_edit, pending_answer,
          provider_wait_json,
          created_by, creation_source, created_at, updated_at, started_at, turn_started_at,
          completed_at, last_activity_at, progress, progress_label
        ) VALUES (
          ${goal.id}, ${goal.projectId}, ${goal.threadId}, ${goal.title}, ${goal.objective},
          ${encodeCriteria([...goal.acceptanceCriteria])}, ${goal.status}, ${goal.currentTaskId},
          ${encodeModelSelection(goal.modelSelection)}, ${goal.runtimeMode},
          ${goal.interactionMode}, ${encodeWorkspaceStrategy(record.workspaceStrategy)},
          ${goal.revision}, ${goal.cycleCount}, ${encodeVerification(goal.verification)},
          ${goal.blockedReason}, ${goal.failureReason}, ${goal.question}, ${goal.questionTaskId},
          ${goal.blocker === null ? null : encodeBlocker(goal.blocker)},
          ${record.pendingEdit ? 1 : 0},
          ${record.pendingAnswer},
          ${record.providerWait === null ? null : encodeProviderWait(record.providerWait)},
          ${goal.createdBy},
          ${goal.creationSource}, ${goal.createdAt}, ${goal.updatedAt}, ${goal.startedAt},
          ${goal.turnStartedAt}, ${goal.completedAt}, ${goal.lastActivityAt},
          ${goal.progress}, ${goal.progressLabel}
        )
        ON CONFLICT(goal_id) DO UPDATE SET
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          title = excluded.title,
          objective = excluded.objective,
          acceptance_criteria_json = excluded.acceptance_criteria_json,
          status = excluded.status,
          current_task_id = excluded.current_task_id,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          workspace_strategy_json = excluded.workspace_strategy_json,
          revision = excluded.revision,
          cycle_count = excluded.cycle_count,
          verification_json = excluded.verification_json,
          blocked_reason = excluded.blocked_reason,
          failure_reason = excluded.failure_reason,
          question = excluded.question,
          question_task_id = excluded.question_task_id,
          blocker_json = excluded.blocker_json,
          pending_edit = excluded.pending_edit,
          pending_answer = excluded.pending_answer,
          provider_wait_json = excluded.provider_wait_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          started_at = excluded.started_at,
          turn_started_at = excluded.turn_started_at,
          completed_at = excluded.completed_at,
          last_activity_at = excluded.last_activity_at,
          progress = excluded.progress,
          progress_label = excluded.progress_label
      `;

          yield* sql`DELETE FROM goal_tasks WHERE goal_id = ${goal.id}`;
          yield* Effect.forEach(
            goal.tasks,
            (task) => sql`
          INSERT INTO goal_tasks (
            goal_id, task_id, title, detail, status, task_order, started_at, completed_at,
            evidence, question, blocker_json, attempts, recovery_attempts, reassessments,
            depends_on_json
          ) VALUES (
            ${goal.id}, ${task.id}, ${task.title}, ${task.detail}, ${task.status},
            ${task.order}, ${task.startedAt}, ${task.completedAt}, ${task.evidence},
            ${task.question}, ${task.blocker === null ? null : encodeBlocker(task.blocker)},
            ${task.attempts},
            ${task.recoveryAttempts}, ${task.reassessments}, ${encodeDependsOn(task.dependsOn)}
          )
        `,
            { discard: true, concurrency: 1 },
          );
        }),
      );
    });

    const appendActivity = Effect.fn("GoalService.appendActivity")(function* (
      goalId: GoalId,
      input: GoalActivityInput,
    ) {
      const at = yield* nowIso;
      const activityId = `activity:${yield* randomUuidV4}`;
      yield* sql`
        INSERT INTO goal_activities (activity_id, goal_id, at, kind, summary, detail, task_id)
        VALUES (
          ${activityId}, ${goalId}, ${at}, ${input.kind}, ${input.summary},
          ${input.detail ?? null}, ${input.taskId ?? null}
        )
      `;
      yield* sql`
        DELETE FROM goal_activities
        WHERE goal_id = ${goalId}
          AND activity_id NOT IN (
            SELECT activity_id FROM goal_activities
            WHERE goal_id = ${goalId}
            ORDER BY at DESC, activity_id DESC
            LIMIT ${GOAL_ACTIVITY_LIMIT}
          )
      `;
      return {
        id: activityId,
        at,
        kind: input.kind,
        summary: input.summary,
        detail: input.detail ?? null,
        taskId: input.taskId ?? null,
      } satisfies GoalActivity;
    });

    /** Writes the goal and appends one activity, then tells subscribers. */
    const commit = Effect.fn("GoalService.commit")(function* (
      record: GoalRecord,
      activity: GoalActivityInput | null,
    ) {
      const at = yield* nowIso;
      const goal: Goal = {
        ...record.goal,
        updatedAt: at,
        lastActivityAt: at,
        // A goal that stopped being driven has no turn in flight; the dispatch
        // marker leaves with it so the card never counts a finished turn.
        turnStartedAt: isDriven(record.goal.status) ? record.goal.turnStartedAt : null,
      };
      yield* writeRecord({ ...record, goal });
      if (activity === null) {
        yield* notifyChanged;
        return { ...record, goal };
      }
      yield* appendActivity(goal.id, activity);
      // Re-read so the caller (and the wire) sees the activity it just wrote.
      const fresh = yield* readRecord(goal.id);
      yield* notifyChanged;
      return fresh ?? { ...record, goal };
    });

    const setStatus = Effect.fn("GoalService.setStatus")(function* (
      record: GoalRecord,
      status: Goal["status"],
      summary: string,
      options?: {
        readonly detail?: string | null;
        readonly blockedReason?: string | null;
        readonly failureReason?: string | null;
        readonly blocker?: GoalBlocker | null;
      },
    ) {
      return yield* commit(
        {
          ...record,
          goal: {
            ...record.goal,
            status,
            blockedReason: options?.blockedReason ?? null,
            failureReason: options?.failureReason ?? null,
            blocker: options?.blocker ?? null,
            // The open question survives every status change: it belongs to the
            // task that asked it, and the user still has to answer it.
            completedAt: status === "completed" ? yield* nowIso : record.goal.completedAt,
            currentTaskId:
              status === "completed" || status === "cancelled" ? null : record.goal.currentTaskId,
          },
        },
        { kind: "status", summary, detail: options?.detail ?? null },
      );
    });

    /**
     * Ends the goal when nothing else can move it.
     *
     * A goal is only blocked when a task produced a full assessment of the
     * deadlock; without one the goal failed, because a conclusion without
     * evidence is not a conclusion.
     */
    const concludeBlocked = (record: GoalRecord, blocker: GoalBlocker | null) =>
      Effect.gen(function* () {
        const goal = record.goal;
        const stuck = goal.tasks.filter((task) => task.status === "failed");
        const evidence =
          blocker ?? goal.blocker ?? stuck.find((task) => task.blocker !== null)?.blocker ?? null;
        if (evidence !== null) {
          yield* setStatus(
            record,
            "blocked",
            `Blocked: ${stuck.map((task) => task.title).join(", ") || "the goal"}`,
            {
              blockedReason: evidence.reason,
              detail: [
                evidence.rootCause,
                evidence.investigation,
                evidence.attempts.length > 0 ? `Tried: ${evidence.attempts.join("; ")}` : null,
                evidence.alternatives.length > 0
                  ? `Also considered: ${evidence.alternatives.join("; ")}`
                  : null,
                `Needs: ${evidence.intervention}`,
              ]
                .filter((part): part is string => part !== null)
                .join("\n"),
              blocker: evidence,
            },
          );
          return;
        }
        yield* setStatus(record, "failed", "No runnable task remains", {
          failureReason:
            stuck.length === 0
              ? "Every task ended without a runnable next step. Edit the goal to describe what should happen."
              : `No runnable task remains on: ${stuck.map((task) => task.title).join("; ")}. Retry a task or edit the goal.`,
        });
      });

    const interruptGoal = (record: GoalRecord, reason: string) =>
      record.goal.threadId === null
        ? Effect.void
        : threads
            .interruptThread({
              projectId: record.goal.projectId,
              commandId: CommandId.make(
                `goal:${record.goal.id}:interrupt:${record.goal.cycleCount}`,
              ),
              threadId: record.goal.threadId,
              reason,
            })
            .pipe(
              Effect.asVoid,
              Effect.catch((cause) =>
                Effect.logWarning("Could not interrupt the goal's running turn", {
                  goalId: record.goal.id,
                  cause,
                }),
              ),
            );

    const assistantTextForRun = Effect.fn("GoalService.assistantTextForRun")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: string;
    }) {
      const projection = yield* threads.getThreadProjection(input.threadId);
      return projection.messages
        .filter((message) => message.role === "assistant" && message.runId === input.runId)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        )
        .map((message) => message.text)
        .join("\n\n");
    });

    /**
     * The provider failure behind a failed run, when there is one.
     *
     * A turn that failed because the provider could not start, was rate
     * limited or lost its session reports a failure class; a turn the agent
     * gave up on reports nothing. The class is what separates "the
     * environment broke" from "the agent got stuck".
     */
    const providerFailureForRun = (threadId: ThreadId, run: OrchestrationV2Run | null) =>
      threads
        .getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["error"],
          turnItemRunIds: run === null ? [] : [run.id],
        })
        .pipe(
          Effect.map((records) => latestRootProviderFailure(run, records.turnItems)),
          // A projection read must not fail the turn: without the
          // classification the failure stays the agent's own obstacle.
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not read the provider failure of a failed turn", {
              cause,
            }).pipe(Effect.as(null)),
          ),
        );

    /**
     * One dispatched turn, from writing the cycle through reading its report.
     *
     * Besides `report`/`no_report`/`stopped`, the outcome can be `interrupted`
     * (the run ended while the goal is still driven), `relaunch` (the thread
     * vanished) or `failed` (the turn did not produce a usable result). The
     * drive loop recovers from all of them instead of blocking. Pause and
     * cancel set the goal's status before they end the run, so they are
     * filtered by the authoritative read and surface as `stopped`.
     */
    const runTurn = (
      record: GoalRecord,
      prompt: string,
      phase: TurnPhase,
      options?: { readonly taskId?: string | null; readonly status?: Goal["status"] },
    ): Effect.Effect<GoalTurnOutcome, GoalError> =>
      Effect.gen(function* () {
        const goal = record.goal;
        const cycle = goal.cycleCount + 1;
        const at = yield* nowIso;
        const started: GoalRecord = {
          ...record,
          goal: {
            ...goal,
            status: options?.status ?? goal.status,
            cycleCount: cycle,
            startedAt: goal.startedAt ?? at,
            turnStartedAt: at,
          },
        };
        yield* writeRecord(started);
        yield* notifyChanged;

        const commandId = CommandId.make(`goal:${goal.id}:${cycle}:${phase}`);
        const messageId = MessageId.make(`goal-message:${goal.id}:${cycle}:${phase}`);
        const text = prompt;

        const dispatched:
          | { readonly threadId: ThreadId; readonly runId: RunId | null }
          | null
          | "archived" = yield* Effect.gen(function* () {
          if (started.goal.threadId === null) {
            const result = yield* threadLaunch.launch({
              commandId,
              projectId: started.goal.projectId,
              title: started.goal.title,
              modelSelection: started.goal.modelSelection,
              runtimeMode: started.goal.runtimeMode,
              interactionMode: started.goal.interactionMode,
              workspaceStrategy: started.workspaceStrategy,
              initialMessage: { messageId, text, attachments: [] },
              createdBy: "system",
              creationSource: "server",
            });
            const latest = result.projection.runs.toSorted(
              (left, right) => right.ordinal - left.ordinal,
            )[0];
            return {
              threadId: result.threadId,
              runId: latest?.id ?? null,
            } as const;
          }
          const sent = yield* threads.sendToThread({
            projectId: started.goal.projectId,
            commandId,
            threadId: started.goal.threadId,
            messageId,
            text,
            attachments: [],
            modelSelection: started.goal.modelSelection,
            // A goal turn must never interrupt tools still running in its thread.
            mode: "queue",
            createdBy: "system",
            creationSource: "server",
          });
          return { threadId: started.goal.threadId, runId: sent.run.id } as const;
        }).pipe(
          Effect.catchTags({
            ThreadManagementThreadNotFoundError: () =>
              Effect.gen(function* () {
                // The bound thread was deleted under us; forget it so the next
                // cycle launches a fresh one instead of failing forever.
                yield* commit(
                  { ...started, goal: { ...started.goal, threadId: null } },
                  {
                    kind: "error",
                    summary: "The goal's thread was deleted; starting a new one",
                    detail: null,
                  },
                );
                return null;
              }),
            ThreadManagementThreadArchivedError: () =>
              Effect.gen(function* () {
                // An archived thread cannot receive turns; drop the binding so
                // Resume continues in a fresh thread rather than re-hitting this.
                yield* commit(
                  { ...started, goal: { ...started.goal, threadId: null } },
                  { kind: "error", summary: "The goal's thread was archived", detail: null },
                );
                return "archived" as const;
              }),
          }),
        );

        if (dispatched === "archived") {
          // An archived thread cannot receive turns, but a new one can. Drop
          // the binding and let the loop launch a replacement instead of
          // parking the goal on something the server can fix on its own.
          const current = yield* readRecordOrFail(goal.id);
          return { kind: "relaunch" as const, record: current, report: null };
        }
        if (dispatched === null) {
          // The thread is gone; the drive loop dispatches again and launches
          // a replacement instead of parking on a dead goal.
          return { kind: "relaunch" as const, record: yield* readRecordOrFail(goal.id), report: null };
        }

        const launched =
          started.goal.threadId === null
            ? {
                ...started,
                goal: { ...started.goal, threadId: dispatched.threadId },
              }
            : started;
        if (launched !== started) {
          // Record the thread the launch created before waiting on it, so a
          // restart resumes the same thread rather than creating another —
          // even when the launch reported no run to wait on.
          yield* writeRecord(launched);
        }
        // A local binding keeps the non-null run id visible inside the
        // closures below; property narrowing does not survive them.
        const runId = dispatched.runId;

        if (runId === null) {
          // The thread launched but the turn never started. That is an
          // obstacle, not a dead end: the turn is retried as a recovery
          // attempt rather than parking the goal.
          return { kind: "failed" as const, record: launched, report: null, providerFailure: null };
        }

        const forgetThreadDuringTurn = (summary: string) =>
          Effect.gen(function* () {
            const current = yield* readRecordOrFail(goal.id);
            if (!isDriven(current.goal.status)) {
              return { kind: "stopped" as const, record: current, report: null };
            }
            const forgot = yield* commit(
              { ...current, goal: { ...current.goal, threadId: null } },
              { kind: "error", summary, detail: null },
            );
            return { kind: "relaunch" as const, record: forgot, report: null };
          });

        return yield* Effect.gen(function* () {
          // A running turn leaves the record untouched; heartbeat pushes keep
          // every subscriber informed that the goal is still alive while the
          // wait runs, so a client can tell a live turn from a stalled one.
          const heartbeat = yield* Effect.forkChild(
            Effect.sleep(GOAL_TURN_HEARTBEAT_MS).pipe(
              Effect.andThen(
                notifyChanged.pipe(
                  Effect.repeat(Schedule.spaced(Duration.millis(GOAL_TURN_HEARTBEAT_MS))),
                ),
              ),
            ),
          );
          const waited = yield* threads
            .waitForThread({
              projectId: started.goal.projectId,
              threadId: dispatched.threadId,
              runId,
              timeoutMs: GOAL_TURN_TIMEOUT_MS,
            })
            .pipe(Effect.ensuring(Fiber.interrupt(heartbeat)));

          if (waited.timedOut) {
            const timedOutRecord = yield* readRecordOrFail(goal.id);
            if (!isDriven(timedOutRecord.goal.status)) {
              return { kind: "stopped" as const, record: timedOutRecord, report: null };
            }
            // A turn that ran too long is an obstacle: the task goes into
            // recovery so the agent retries it with the timeout as context.
            return {
              kind: "failed" as const,
              record: timedOutRecord,
              report: null,
              providerFailure: null,
            };
          }

          const completed = waited.run?.status === "completed";
          // Only a completed turn produced text worth reading.
          const reply = completed
            ? yield* assistantTextForRun({
                threadId: dispatched.threadId,
                runId,
              })
            : "";

          // The authoritative read, after the turn's only I/O: a pause or
          // cancel that landed while the turn ended is visible here, because
          // both set the status before ending the run. A mutation landing in
          // the µs window between this read and the caller's write can still
          // be clobbered; closing that needs a version column we do not carry.
          const afterWait = yield* readRecordOrFail(goal.id);
          if (!isDriven(afterWait.goal.status)) {
            return { kind: "stopped" as const, record: afterWait, report: null };
          }

          if (!completed) {
            const runStatus = waited.run?.status ?? null;
            if (runStatus === "failed") {
              // The provider failed the turn. Whether that is the agent's
              // problem or the environment's depends on the failure class,
              // so the class is read before the drive loop reacts.
              const providerFailure = yield* providerFailureForRun(
                dispatched.threadId,
                waited.run ?? null,
              );
              return { kind: "failed" as const, record: afterWait, report: null, providerFailure };
            }
            if (
              runStatus === "interrupted" ||
              runStatus === "cancelled" ||
              runStatus === "rolled_back"
            ) {
              // Still driven, so whoever ended the turn (an update interrupting
              // for a new edit, or a stop in the thread) is answered by
              // re-dispatching on the next cycle rather than blocking.
              return { kind: "interrupted" as const, record: afterWait, report: null };
            }
            return { kind: "failed" as const, record: afterWait, report: null, providerFailure: null };
          }

          const report = parseGoalReport(reply);
          return report === null
            ? { kind: "no_report" as const, record: afterWait, report: null }
            : { kind: "report" as const, report, record: afterWait };
        }).pipe(
          Effect.catchTags({
            ThreadManagementThreadNotFoundError: () =>
              forgetThreadDuringTurn("The goal's thread was deleted; starting a new one"),
            ThreadManagementRunNotFoundError: () =>
              forgetThreadDuringTurn("The goal's run was lost; starting a new thread"),
            ThreadManagementThreadArchivedError: () =>
              Effect.gen(function* () {
                const current = yield* readRecordOrFail(goal.id);
                if (!isDriven(current.goal.status)) {
                  return { kind: "stopped" as const, record: current, report: null };
                }
                // Drop the binding so the next cycle launches a fresh thread
                // instead of re-hitting the archive on every attempt.
                const forgot = yield* commit(
                  { ...current, goal: { ...current.goal, threadId: null } },
                  {
                    kind: "error",
                    summary: "The goal's thread was archived; starting a new one",
                    detail: null,
                  },
                );
                return { kind: "relaunch" as const, record: forgot, report: null };
              }),
          }),
        );
      }).pipe(
        Effect.mapError((cause) => toGoalError(cause)),
        Effect.withSpan("GoalService.runTurn"),
      );

    /**
     * Parks the goal on a provider fault.
     *
     * The environment failed, so the agent gets no blame: the goal keeps its
     * plan, its work and the turn it was making, and the server tries that
     * turn again once the provider can serve it. The delay grows with every
     * consecutive fault, because a provider that just refused a turn will
     * refuse the next one too.
     */
    const parkForProvider = Effect.fn("GoalService.parkForProvider")(function* (
      record: GoalRecord,
      failure: OrchestrationV2ProviderFailure,
    ) {
      const attempt = (record.providerWait?.attempt ?? 0) + 1;
      const delayMs = Math.min(
        PROVIDER_RETRY_BASE_MS * 2 ** (attempt - 1),
        PROVIDER_RETRY_MAX_MS,
      );
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      // A usage limit names the moment it lifts, so the server waits for that
      // one instead of guessing when the provider is usable again.
      const resetMs =
        failure.class === "usage_limit" && failure.resetAt != null
          ? Date.parse(failure.resetAt)
          : Number.NaN;
      const resumeAtMs = Number.isFinite(resetMs)
        ? Math.max(resetMs, nowMs + delayMs)
        : nowMs + delayMs;
      const resumeAt = DateTime.formatIso(
        DateTime.toUtc(DateTime.add(now, { milliseconds: resumeAtMs - nowMs })),
      );
      const wait: GoalProviderWait = {
        class: failure.class,
        message: failure.message,
        resumeAt,
        attempt,
      };
      return yield* commit(
        {
          ...record,
          providerWait: wait,
          goal: {
            ...record.goal,
            status: "waiting_provider",
            // No turn is in flight while the goal waits.
            turnStartedAt: null,
            blockedReason: failure.message,
            failureReason: null,
            blocker: null,
          },
        },
        {
          kind: "error",
          summary: `Waiting for the provider: ${failure.message}`,
          detail: null,
        },
      );
    });

    /**
     * Puts a parked goal back to work once its moment has come.
     *
     * The goal resumes by itself: it does not need the user, and the turn it
     * was making is dispatched again with the plan intact. Called by the
     * parked sweep, and by the user when they resume a parked goal.
     */
    const resumeParkedGoal = Effect.fn("GoalService.resumeParkedGoal")(function* (
      record: GoalRecord,
    ) {
      if (record.goal.status !== "waiting_provider") return record;
      const current = yield* readRecordOrFail(record.goal.id);
      // The user may have paused or cancelled the goal while it waited.
      if (current.goal.status !== "waiting_provider") return current;
      const recovering = current.goal.tasks.some((task) => task.status === "recovering");
      return yield* commit(
        {
          ...current,
          providerWait: null,
          goal: {
            ...current.goal,
            status:
              current.goal.tasks.length === 0
                ? "planning"
                : recovering
                  ? "recovering"
                  : "running",
            blockedReason: null,
          },
        },
        { kind: "status", summary: "The provider is back; continuing", detail: null },
      );
    });

    /**
     * Runs a turn and parks the goal when the provider, not the agent, failed.
     *
     * A provider fault is the environment's problem, so the goal waits for
     * the provider and the same turn runs again. The agent's own recovery
     * budget is untouched: the turn was never the agent's fault. The driver
     * leaves the goal parked; the parked sweep brings it back.
     */
    const runTurnOrPark = (
      record: GoalRecord,
      prompt: string,
      phase: TurnPhase,
      options?: { readonly taskId?: string | null; readonly status?: Goal["status"] },
    ) =>
      Effect.gen(function* () {
        const outcome = yield* runTurn(record, prompt, phase, options);
        if (outcome.kind !== "failed" || outcome.providerFailure === null) return outcome;
        if (!PROVIDER_FAULT_CLASSES.has(outcome.providerFailure.class)) return outcome;
        yield* parkForProvider(outcome.record, outcome.providerFailure);
        return { ...outcome, kind: "parked" as const };
      });

    /**
     * Folds a turn's report into the stored plan.
     *
     * The server owns the outcome: a report that says a task failed is an
     * obstacle to recover from, not a dead end, so the task moves to
     * `recovering` and keeps its recovery budget. A report that asks a
     * question parks only the task that asked it.
     */
    const applyReport = Effect.fn("GoalService.applyReport")(function* (
      record: GoalRecord,
      report: GoalReport,
      options?: {
        readonly repair?: boolean;
        readonly planHandling?: GoalPlanHandling;
        /** Which kind of turn produced the report. */
        readonly mode?: GoalTurnMode;
      },
    ) {
      const at = yield* nowIso;
      let counter = 0;
      const applied = applyGoalReport({
        tasks: record.goal.tasks,
        acceptanceCriteria: record.goal.acceptanceCriteria,
        report,
        makeTaskId: () => {
          counter += 1;
          return `task:${at}:${counter}`;
        },
        nowIso: at,
        planHandling: options?.planHandling ?? "replace",
      });
      const allCompleted =
        applied.tasks.length > 0 && applied.tasks.every((task) => task.status === "completed");
      const verification: GoalVerification =
        options?.repair === true && allCompleted
          ? { status: "pending", summary: null, checkedAt: null }
          : applied.status === "verifying"
            ? { status: "pending", summary: null, checkedAt: null }
            : record.goal.verification;

      // The task this turn was about.
      const currentTaskId = record.goal.currentTaskId;

      // A question pauses one task, not the whole goal: the rest of the plan
      // keeps running while the user answers.
      const asksForInput = report.status === "needs_input";
      // An obstacle is not a dead end. The task goes into recovery and the
      // driver sends a recovery turn with the failure as its context.
      const hitObstacle = report.status === "blocked" || report.status === "recovering";

      const previous = new Map(record.goal.tasks.map((task) => [task.id, task]));
      const tasks = applied.tasks.map((task) => {
        const before = previous.get(task.id);
        // A task that made progress out of recovery starts a fresh budget: the
        // obstacle was worked through, so the next one does not inherit a
        // spent recovery allowance.
        if (
          before?.status === "recovering" &&
          (task.status === "in_progress" || task.status === "completed")
        ) {
          return { ...task, recoveryAttempts: 0, reassessments: 0 };
        }
        if (task.id !== currentTaskId) return task;
        if (task.status === "completed") return task;
        if (asksForInput) {
          return {
            ...task,
            status: "waiting_input" as const,
            question: task.question ?? applied.question,
          };
        }
        if (hitObstacle) {
          return { ...task, status: "recovering" as const };
        }
        return task;
      });
      // A task the agent named as waiting for the user carries the question
      // too, so several tasks can each be waiting without losing any of them.
      const withQuestions = tasks.map((task) =>
        task.status === "waiting_input" && task.question === null && applied.question !== null
          ? { ...task, question: applied.question }
          : task,
      );

      // The user is asked one question at a time. The first task waiting on
      // them owns it; the rest keep theirs for when it is answered.
      const asked = withQuestions.find(
        (task) => task.status === "waiting_input" && task.question !== null,
      );

      // The agent's own blocked verdict is a claim, not a conclusion: it
      // becomes another obstacle to recover from unless the turn was the
      // reassessment that was asked for a full assessment.
      const blocker =
        options?.mode === "reassess" && applied.blocker !== null ? applied.blocker : null;

      // A task that produced a full assessment carries it, so the reason a
      // task stopped is the task's own evidence.
      const withBlockers = withQuestions.map((task) =>
        blocker !== null && task.id === currentTaskId
          ? { ...task, blocker, evidence: blocker.reason }
          : task,
      );

      const goal: Goal = {
        ...record.goal,
        tasks: [...withBlockers],
        acceptanceCriteria: [...applied.acceptanceCriteria],
        currentTaskId: applied.currentTaskId,
        // A turn that reports no work yet leaves a task-less goal in planning
        // so the loop re-plans instead of giving up on an empty plan.
        status:
          applied.status === "running" && applied.tasks.length === 0 ? "planning" : applied.status,
        verification,
        blockedReason: null,
        failureReason: null,
        question: asked?.question ?? null,
        questionTaskId: asked?.id ?? null,
        blocker: record.goal.blocker ?? blocker,
        progress: report.progress ?? null,
        progressLabel: report.progressLabel ?? null,
      };
      const next = yield* commit({ ...record, goal }, null);
      for (const change of applied.changes) {
        yield* appendActivity(goal.id, {
          kind: change.kind,
          summary: change.summary,
          detail: change.kind === "task_completed" ? null : (report.summary ?? null),
          taskId: change.taskId,
        });
      }
      if (report.summary !== null) {
        yield* appendActivity(goal.id, {
          kind: "prompt",
          summary: clipDetail(report.summary),
          detail: null,
        });
      }
      if (applied.prematureCompletion) {
        yield* appendActivity(goal.id, {
          kind: "status",
          summary: "The agent reported completion, but tasks remain; continuing",
          detail: null,
        });
      }
      yield* notifyChanged;
      return {
        record: next,
        allCompleted,
        status: goal.status,
        question: goal.question,
        questionTaskId: goal.questionTaskId,
        blocker,
      };
    });

    const verifyCompletion = Effect.fn("GoalService.verifyCompletion")(function* (
      record: GoalRecord,
      report: GoalReport,
    ) {
      const goal = record.goal;
      // A criterion counts as met only when a matching entry claims it is met
      // and carries evidence or proof; a bare "met": true is the agent's word, not proof.
      const evidenced = (criterion: string) =>
        report.acceptance.some(
          (entry) =>
            entry.met &&
            ((entry.evidence !== null && entry.evidence.trim() !== "") || entry.proof.length > 0) &&
            normalizedCriterion(entry.criterion) === normalizedCriterion(criterion),
        );
      const unmet = goal.acceptanceCriteria.filter((criterion) => !evidenced(criterion));
      const allTasksCompleted =
        goal.tasks.length > 0 && goal.tasks.every((task) => task.status === "completed");
      const verified =
        report.verified === true &&
        unmet.length === 0 &&
        allTasksCompleted &&
        (goal.acceptanceCriteria.length === 0 || report.acceptance.length > 0);
      // Per-criterion results for the UI, including the proof that backs each one.
      const proofByCriterion = new Map(
        report.acceptance
          .filter((entry) => entry.met && entry.proof.length > 0)
          .map((entry) => [normalizedCriterion(entry.criterion), entry.proof]),
      );
      const criterionResults = goal.acceptanceCriteria.map((criterion) => ({
        criterion,
        met: !unmet.some((entry) => normalizedCriterion(entry) === normalizedCriterion(criterion)),
        proof: proofByCriterion.get(normalizedCriterion(criterion)) ?? [],
      }));
      const at = yield* nowIso;
      if (verified) {
        const completed = yield* commit(
          {
            ...record,
            goal: {
              ...goal,
              status: "completed",
              currentTaskId: null,
              completedAt: at,
              verification: {
                status: "passed",
                summary: report.summary ?? "Every acceptance criterion was verified.",
                checkedAt: at,
                criteria: criterionResults,
              },
            },
          },
          {
            kind: "verification",
            summary: `Verified: ${goal.tasks.length} of ${goal.tasks.length} tasks complete`,
            detail: report.summary,
          },
        );
        return { done: true as const, record: completed };
      }

      const summary =
        report.summary ??
        (unmet.length > 0
          ? `Unmet: ${unmet.join("; ")}`
          : "The agent did not confirm that the goal is satisfied.");

      // Always repair instead of giving up: the fix-and-verify loop runs until
      // the agent confirms every criterion is met, or the user stops the goal.
      const repair = yield* commit(
        {
          ...record,
          goal: {
            ...goal,
            status: "running",
            verification: { status: "failed", summary, checkedAt: at, criteria: criterionResults },
          },
        },
        { kind: "verification", summary: "Verification found work to fix", detail: summary },
      );
      return { done: false as const, record: repair };
    });

    /**
     * The goal's execution loop.
     *
     * The loop is autonomous: an obstacle sends the affected task through
     * recovery, and the recovery ladder escalates to a reassessment that has
     * to produce evidence before anything is called blocked. Nothing here
     * ends the goal by counting: a task is stopped by evidence or by the
     * user, and a provider that breaks parks the goal until it comes back.
     * Work the agent reported as recoverable never stops the goal; only a
     * task that waits on the user pauses, and only that task.
     */
    const drive = (goalId: GoalId) =>
      Effect.gen(function* () {
        let idleCycles = 0;
        while (true) {
          const record = yield* readRecordOrFail(goalId);
          const goal = record.goal;
          // A parked goal is not driven: it waits for the parked sweep to
          // bring it back, so this driver leaves it alone.
          if (!isDriven(goal.status)) return;

          if (record.pendingAnswer !== null) {
            const question = goal.question ?? "You asked the user for clarification.";
            const questionTask = goal.tasks.find((task) => task.id === goal.questionTaskId) ?? null;
            // The answer stays stored until its turn completes, so a pause or
            // an interrupted turn cannot swallow the user's reply.
            const outcome = yield* runTurnOrPark(
              record,
              buildGoalAnswerPrompt({
                goal,
                question,
                answer: record.pendingAnswer,
                task: questionTask,
              }),
              "answer",
            );
            if (outcome.kind === "stopped") return;
            if (outcome.kind === "parked") return;
            if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
            // The answered task resumes where it stopped: it goes back to
            // working, with everything it had already done kept.
            const answered = yield* commit(
              {
                ...outcome.record,
                pendingAnswer: null,
                goal: {
                  ...outcome.record.goal,
                  question: null,
                  questionTaskId: null,
                  status: "running",
                  currentTaskId: questionTask?.id ?? outcome.record.goal.currentTaskId,
                  tasks: outcome.record.goal.tasks.map((task) =>
                    task.id === questionTask?.id && task.status === "waiting_input"
                      ? { ...task, status: "in_progress" as const, question: null }
                      : task,
                  ),
                },
              },
              { kind: "user", summary: "Continued with the user's answer", detail: null },
            );
            if (outcome.report === null) {
              idleCycles += 1;
              continue;
            }
            idleCycles = 0;
            const applied = yield* applyReport(answered, outcome.report, {
              planHandling: "ignore",
              mode: "answer",
            });
            if (applied.status === "completed") return;
            continue;
          }

          if (record.pendingEdit) {
            const dispatchedRevision = record.goal.revision;
            const outcome = yield* runTurnOrPark(record, buildGoalEditPrompt(goal), "edit");
            if (outcome.kind === "stopped") return;
            if (outcome.kind === "parked") return;
            if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
            // The turn consumed this edit. A newer edit that landed mid-turn
            // keeps its flag and revision for the next cycle; only a mutation
            // in the µs window between this read and write can lose one.
            const fresh = yield* readRecordOrFail(goal.id);
            const cleared =
              fresh.goal.revision === dispatchedRevision
                ? yield* commit({ ...fresh, pendingEdit: false }, null)
                : fresh;
            if (outcome.report === null) {
              idleCycles += 1;
              continue;
            }
            idleCycles = 0;
            const applied = yield* applyReport(cleared, outcome.report, {
              planHandling: "extend",
              mode: "edit",
            });
            if (applied.status === "completed") return;
            continue;
          }

          if (goal.status === "planning" && goal.tasks.length === 0) {
            const outcome = yield* runTurnOrPark(record, buildGoalPlanningPrompt(goal), "plan");
            if (outcome.kind === "stopped") return;
            if (outcome.kind === "parked") return;
            if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
            if (outcome.report === null) {
              idleCycles += 1;
              if (idleCycles >= GOAL_IDLE_ESCALATION_CYCLES) {
                // Planning that keeps producing nothing is an obstacle, not a
                // dead end: the agent is asked why before anything is given up.
                const recovery = yield* runTurnOrPark(
                  outcome.record,
                  buildGoalRecoveryPrompt({
                    goal: outcome.record.goal,
                    task: null,
                    failure: "The planning turn produced no plan.",
                    recoveryAttempt: idleCycles,
                  }),
                  "recover",
                );
                if (recovery.kind === "stopped") return;
                if (recovery.kind === "parked") continue;
                if (recovery.kind === "interrupted" || recovery.kind === "relaunch") continue;
                if (recovery.report === null) {
                  // Still nothing. The goal waits and asks again: the agent
                  // gets more time rather than the goal being taken away.
                  yield* Effect.sleep(stallDelay(idleCycles));
                  continue;
                }
                // The recovery report is applied even when it names no plan:
                // the goal asks again with a growing pause rather than being
                // taken away for it.
                yield* applyReport(outcome.record, recovery.report, { mode: "recover" });
                idleCycles = 0;
                continue;
              }
              continue;
            }
            idleCycles = 0;
            const applied = yield* applyReport(outcome.record, outcome.report, { mode: "plan" });
            if (applied.record.goal.tasks.length === 0) {
              // A plan report with no tasks is not progress. The goal asks
              // again, with a growing pause, instead of being taken away.
              idleCycles += 1;
              yield* Effect.sleep(stallDelay(idleCycles));
            }
            continue;
          }

          if (goal.status === "verifying") {
            const outcome = yield* runTurnOrPark(
              record,
              buildGoalVerificationPrompt(goal),
              "verify",
            );
            if (outcome.kind === "stopped") return;
            if (outcome.kind === "parked") return;
            if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
            if (outcome.report === null) {
              idleCycles += 1;
              if (idleCycles >= GOAL_IDLE_ESCALATION_CYCLES) {
                // Verification that never reports is asked for again rather
                // than ending the goal.
                yield* Effect.sleep(stallDelay(idleCycles));
              }
              continue;
            }
            idleCycles = 0;
            const verified = yield* verifyCompletion(outcome.record, outcome.report);
            if (verified.done) return;
            continue;
          }

          if (goal.tasks.length === 0) {
            yield* setStatus(record, "failed", "This goal has no tasks", {
              failureReason: "The plan is empty. Edit the goal to define what should happen.",
            });
            return;
          }

          const allCompleted = goal.tasks.every((task) => task.status === "completed");
          if (allCompleted) {
            if (goal.verification.status === "failed") {
              const outcome = yield* runTurnOrPark(record, buildGoalRepairPrompt(goal), "repair");
              if (outcome.kind === "stopped") return;
              if (outcome.kind === "parked") return;
              if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
              if (outcome.report === null) {
                idleCycles += 1;
                if (idleCycles >= GOAL_IDLE_ESCALATION_CYCLES) {
                  // Repair that never reports is asked for again rather than
                  // ending the goal.
                  yield* Effect.sleep(stallDelay(idleCycles));
                }
                continue;
              }
              idleCycles = 0;
              const applied = yield* applyReport(outcome.record, outcome.report, {
                repair: true,
                planHandling: "extend",
                mode: "repair",
              });
              if (applied.status === "completed") return;
              continue;
            }
            yield* setStatus(record, "verifying", "Verifying the result against the goal", {
              detail: goal.acceptanceCriteria.join("\n") || null,
            });
            continue;
          }

          // The task the loop works on next. A task that waits for the user is
          // skipped, so one question never stops independent work; a task in
          // recovery is picked up again so its recovery turn happens.
          const nextTask = selectNextTask(goal.tasks);
          if (nextTask === undefined) {
            // Nothing is runnable. The only way out is the user: either a
            // question is open, or the goal needs a decision.
            const waiting = goal.tasks.find((task) => task.status === "waiting_input");
            if (waiting !== undefined) {
              yield* setStatus(record, "needs_input", "Waiting for your answer", {
                detail: waiting.question ?? goal.question ?? null,
              });
              return;
            }
            yield* concludeBlocked(record, null);
            return;
          }

          // A task that reported an obstacle is recovered from first: the
          // failure is the context, and the agent is asked to work it out
          // rather than to try the same thing again. The ladder escalates to
          // a reassessment and keeps going: only an assessment with evidence
          // behind it stops a task.
          const recovering = nextTask.status === "recovering";
          const ladder = recovering
            ? planGoalTaskRecovery({
                recoveryAttempts: nextTask.recoveryAttempts,
                reassessments: nextTask.reassessments,
              })
            : null;

          const markedAt = yield* nowIso;
          const marked: GoalRecord = {
            ...record,
            goal: {
              ...goal,
              // The goal reads as recovering while a task is being worked
              // through, so the card shows what is happening.
              status: recovering ? "recovering" : "running",
              tasks: goal.tasks.map((task) =>
                task.id === nextTask.id
                  ? {
                      ...task,
                      status: recovering ? ("recovering" as const) : ("in_progress" as const),
                      startedAt: task.startedAt ?? markedAt,
                      // Every turn spent on the task is an attempt, whether it
                      // did the work, recovered from a failure, or reassessed.
                      attempts: task.attempts + 1,
                      recoveryAttempts:
                        ladder?.kind === "recover"
                          ? task.recoveryAttempts + 1
                          : task.recoveryAttempts,
                      reassessments:
                        ladder?.kind === "reassess" ? task.reassessments + 1 : task.reassessments,
                    }
                  : task,
              ),
              currentTaskId: nextTask.id,
            },
          };
          yield* commit(marked, {
            kind: ladder?.kind === "reassess" ? "reassessment" : "task_started",
            summary:
              ladder?.kind === "reassess"
                ? `Reassessing: ${nextTask.title}`
                : ladder?.kind === "recover"
                  ? `Recovering: ${nextTask.title}`
                  : `Working on: ${nextTask.title}`,
            detail: nextTask.detail,
            taskId: nextTask.id,
          });

          const outcome = yield* runTurnOrPark(
            marked,
            ladder?.kind === "reassess"
              ? buildGoalReassessmentPrompt({
                  goal: marked.goal,
                  task: nextTask,
                  reason: nextTask.evidence ?? "The agent could not make progress on this task.",
                  failure: nextTask.evidence,
                })
              : ladder?.kind === "recover"
                ? buildGoalRecoveryPrompt({
                    goal: marked.goal,
                    task: nextTask,
                    failure: nextTask.evidence,
                    recoveryAttempt: nextTask.recoveryAttempts + 1,
                  })
                : buildGoalExecutionPrompt({
                    goal: marked.goal,
                    task: nextTask,
                    edited: false,
                  }),
            ladder?.kind === "reassess"
              ? "reassess"
              : ladder?.kind === "recover"
                ? "recover"
                : "task",
            { taskId: nextTask.id },
          );
          if (outcome.kind === "stopped") return;
          if (outcome.kind === "parked") return;
          if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
          if (outcome.report === null) {
            // A turn that produced no usable result is an obstacle like any
            // other: the task goes back into recovery rather than the goal
            // stopping. The recovery ladder escalates the next attempt.
            idleCycles += 1;
            yield* commit(
              {
                ...outcome.record,
                goal: {
                  ...outcome.record.goal,
                  tasks: outcome.record.goal.tasks.map((task) =>
                    task.id === nextTask.id
                      ? {
                          ...task,
                          status: "recovering" as const,
                          evidence:
                            task.evidence ??
                            (outcome.kind === "failed"
                              ? "The agent turn did not complete."
                              : "The turn finished without a goal report."),
                        }
                      : task,
                  ),
                },
              },
              {
                kind: "recovery",
                summary:
                  outcome.kind === "failed"
                    ? `The turn did not complete: ${nextTask.title}`
                    : `No progress report: ${nextTask.title}`,
                detail:
                  outcome.kind === "failed"
                    ? "The agent turn failed or never started, so the task went back into recovery."
                    : "The turn finished without a goal report, so the task went back into recovery.",
                taskId: nextTask.id,
              },
            );
            if (idleCycles >= GOAL_IDLE_ESCALATION_CYCLES) {
              // The task keeps trying, but not every few seconds: a confused
              // agent gets time before the next attempt.
              yield* Effect.sleep(stallDelay(idleCycles));
            }
            continue;
          }
          idleCycles = 0;
          const applied = yield* applyReport(outcome.record, outcome.report, {
            planHandling: "ignore",
            mode:
              ladder?.kind === "reassess"
                ? "reassess"
                : ladder?.kind === "recover"
                  ? "recover"
                  : "task",
          });
          if (applied.status === "completed") return;
          // A reassessment that produced a full assessment ends this task.
          // The task is finished as far as the plan is concerned, but the
          // goal keeps working whatever else it can.
          if (applied.blocker !== null) {
            const blocker = applied.blocker;
            yield* commit(
              {
                ...applied.record,
                goal: {
                  ...applied.record.goal,
                  currentTaskId: null,
                  tasks: applied.record.goal.tasks.map((task) =>
                    task.id === nextTask.id
                      ? { ...task, status: "failed" as const, evidence: blocker.reason }
                      : task,
                  ),
                },
              },
              {
                kind: "task_failed",
                summary: `Blocked: ${nextTask.title}`,
                detail: blocker.reason,
                taskId: nextTask.id,
              },
            );
          }
          continue;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("Goal execution stopped unexpectedly", { goalId, cause });
            const current = yield* Effect.option(readRecord(goalId));
            if (
              Option.isSome(current) &&
              current.value !== null &&
              isDriven(current.value.goal.status)
            ) {
              yield* setStatus(current.value, "failed", "The execution loop failed", {
                failureReason: Cause.pretty(cause),
              });
            }
          }),
        ),
        // A driver that cannot persist its own failure must not take the server
        // down; the goal stays in its last stored state and can be resumed.
        Effect.ignoreCause({ log: true }),
        Effect.withSpan("GoalService.drive"),
      );

    const startDriver = (goalId: GoalId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const reserved = yield* Ref.modify(drivers, (active) =>
          active.has(goalId)
            ? ([false, active] as const)
            : ([true, new Set([...active, goalId])] as const),
        );
        if (!reserved) {
          // Remember the attempt: if this driver exits without picking the
          // goal up (the answer-committed-mid-exit window), the exit must
          // start a replacement instead of leaving the goal driven and idle.
          yield* Ref.update(pendingDrives, (active) => new Set([...active, goalId]));
          return;
        }
        yield* drive(goalId).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Ref.update(drivers, (active) => {
                const next = new Set(active);
                next.delete(goalId);
                return next;
              });
              const pending = yield* Ref.modify(pendingDrives, (active) => {
                if (!active.has(goalId)) return [false, active] as const;
                const next = new Set(active);
                next.delete(goalId);
                return [true, next] as const;
              });
              if (!pending) return;
              // A read that fails must not fail the exiting driver; the sweep
              // blocks the goal later if it really is orphaned.
              const record = yield* readRecord(goalId).pipe(
                Effect.catch((cause) =>
                  Effect.map(
                    Effect.logWarning("Could not re-read a goal for a queued drive", {
                      goalId,
                      cause,
                    }),
                    () => null,
                  ),
                ),
              );
              if (record !== null && isDriven(record.goal.status)) {
                yield* startDriver(goalId);
              }
            }),
          ),
          Effect.forkIn(scope),
        );
      });

    /**
     * The summaries of the goals a client can see.
     *
     * A summary is built from the goal row and its task rows alone: the
     * activities are only needed by an open card, so a list of a hundred
     * goals does not decode four thousand activities to say what it needs.
     */
    const listSummaries = Effect.fn("GoalService.listSummaries")(function* (projectId?: string) {
      const scope =
        projectId === undefined ? sql`` : sql`WHERE project_id = ${projectId}`;
      const goalRows = yield* sql<GoalSummaryRow>`
        SELECT goal_id, project_id, thread_id, title, status, current_task_id, blocked_reason,
               failure_reason, question, progress, progress_label, turn_started_at, updated_at,
               last_activity_at, completed_at
        FROM goals
        ${scope}
        ORDER BY updated_at DESC, goal_id ASC
        LIMIT 100
      `;
      const taskRows = yield* sql<GoalSummaryTaskRow>`
        SELECT t.goal_id, t.task_id, t.title, t.status
        FROM goal_tasks t
        JOIN (
          SELECT goal_id FROM goals
          ${scope}
          ORDER BY updated_at DESC, goal_id ASC
          LIMIT 100
        ) listed ON listed.goal_id = t.goal_id
        ORDER BY t.task_order ASC, t.task_id ASC
      `;
      const tasksByGoal = new Map<string, Array<GoalSummaryTaskRow>>();
      for (const row of taskRows) {
        const existing = tasksByGoal.get(row.goal_id);
        if (existing === undefined) tasksByGoal.set(row.goal_id, [row]);
        else existing.push(row);
      }
      return goalRows.map((row) => {
        const tasks = tasksByGoal.get(row.goal_id) ?? [];
        const current = tasks.find((task) => task.task_id === row.current_task_id);
        const inProgress = tasks.find((task) => task.status === "in_progress");
        const recovering = tasks.find((task) => task.status === "recovering");
        return {
          id: GoalId.make(row.goal_id),
          projectId: row.project_id as GoalSummary["projectId"],
          threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
          title: row.title,
          status: Option.getOrElse(decodeGoalStatus(row.status), () => "failed" as const),
          currentTaskId: row.current_task_id,
          currentTaskTitle: current?.title ?? inProgress?.title ?? recovering?.title ?? null,
          completedTaskCount: tasks.filter((task) => task.status === "completed").length,
          totalTaskCount: tasks.length,
          turnStartedAt: row.turn_started_at,
          blockedReason: row.blocked_reason,
          failureReason: row.failure_reason,
          question: row.question,
          progress: row.progress,
          progressLabel: row.progress_label,
          updatedAt: row.updated_at,
          lastActivityAt: row.last_activity_at,
          completedAt: row.completed_at,
        } satisfies GoalSummary;
      });
    });

    const list: GoalService["Service"]["list"] = (input) =>
      listSummaries(input.projectId).pipe(
        Effect.map((goals) => ({ goals })),
        Effect.mapError((cause) => toGoalError(cause)),
      );

    const subscribeList: GoalService["Service"]["subscribeList"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list(input)),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
          );
        }),
      );

    /**
     * One goal's live detail.
     *
     * The client opens this while the user is looking at the goal and closes
     * it again, so the payload is built for that goal alone and the server
     * stops reading it the moment nobody watches.
     */
    const watchGoal: GoalService["Service"]["watchGoal"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const lastFingerprint = yield* Ref.make<string | null>(null);
          const read: Effect.Effect<GoalMutationResult | null> = Effect.gen(function* () {
            const record = yield* readRecord(input.id).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not read a watched goal", {
                  goalId: input.id,
                  cause,
                }).pipe(Effect.as(null)),
              ),
            );
            if (record === null) return null;
            const fingerprint = goalFingerprint(record.goal);
            const previous = yield* Ref.get(lastFingerprint);
            if (previous !== null && previous === fingerprint) return null;
            yield* Ref.set(lastFingerprint, fingerprint);
            return { goal: record.goal };
          });
          return Stream.concat(
            Stream.fromEffect(read),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read)),
          ).pipe(Stream.filter((value): value is GoalMutationResult => value !== null));
        }),
      );

    const get: GoalService["Service"]["get"] = (input) =>
      readRecordOrFail(input.id).pipe(
        Effect.map((record) => ({ goal: record.goal })),
        Effect.mapError((cause) => toGoalError(cause, input.id)),
      );

    const create: GoalService["Service"]["create"] = (input) =>
      Effect.gen(function* () {
        const threadId = input.threadId ?? null;
        if (threadId !== null) {
          // Two goals must not drive one thread: their turns would interleave
          // and each agent would answer the other's task. The web client
          // starts such a goal in a thread of its own; an agent that names a
          // busy thread is told why instead of quietly racing it.
          const owners = yield* sql<{ goal_id: string }>`
            SELECT goal_id FROM goals
            WHERE thread_id = ${threadId}
              AND status NOT IN ('completed', 'cancelled')
            ORDER BY created_at DESC
            LIMIT 1
          `;
          const owner = owners[0];
          if (owner !== undefined) {
            return yield* new GoalError({
              message:
                "This thread already has a goal. Finish or cancel it, or start the new goal without this thread.",
              goalId: GoalId.make(owner.goal_id),
            });
          }
        }
        const at = yield* nowIso;
        const id = GoalId.make(`goal:${yield* randomUuidV4}`);
        const goal: Goal = {
          id,
          projectId: input.projectId,
          threadId,
          title: input.title ?? deriveTitle(input.objective),
          objective: input.objective,
          acceptanceCriteria: (input.acceptanceCriteria ?? []).flatMap((criterion) => {
            const trimmed = criterion.trim();
            return trimmed === "" ? [] : [trimmed];
          }),
          status: "planning",
          tasks: [],
          activities: [],
          currentTaskId: null,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          revision: 1,
          cycleCount: 0,
          verification: { status: "pending", summary: null, checkedAt: null },
          blockedReason: null,
          failureReason: null,
          question: null,
          questionTaskId: null,
          blocker: null,
          progress: null,
          progressLabel: null,
          createdAt: at,
          updatedAt: at,
          startedAt: at,
          turnStartedAt: null,
          completedAt: null,
          lastActivityAt: at,
          createdBy: input.createdBy ?? "user",
          creationSource: input.creationSource ?? "web",
        };
        const record: GoalRecord = {
          goal,
          workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
          pendingEdit: false,
          pendingAnswer: null,
          providerWait: null,
        };
        yield* writeRecord(record);
        const createdActivity = yield* appendActivity(id, {
          kind: "created",
          summary: "Goal created",
          detail: goal.objective,
        });
        const planningActivity = yield* appendActivity(id, {
          kind: "status",
          summary: "Planning the work",
          detail: null,
        });
        yield* notifyChanged;
        // The goal is returned as it was created: the driver may already have
        // changed it, and the caller asked for the goal it just made.
        yield* startDriver(id);
        return {
          goal: { ...goal, activities: [createdActivity, planningActivity] },
        };
      }).pipe(Effect.mapError((cause) => toGoalError(cause)));

    const update: GoalService["Service"]["update"] = (input) =>
      Effect.gen(function* () {
        const record = yield* readRecordOrFail(input.id);
        if (hasEnded(record.goal.status)) {
          return yield* new GoalError({
            message: "This goal has ended. Start a new goal for further work.",
            goalId: input.id,
          });
        }
        const objective =
          input.additionalRequirements === undefined || input.additionalRequirements.trim() === ""
            ? (input.objective ?? record.goal.objective)
            : `${input.objective ?? record.goal.objective}\n\nAdditional requirements from the user:\n${input.additionalRequirements.trim()}`;
        const criteria =
          input.acceptanceCriteria === undefined
            ? record.goal.acceptanceCriteria
            : input.acceptanceCriteria.flatMap((criterion) => {
                const trimmed = criterion.trim();
                return trimmed === "" ? [] : [trimmed];
              });
        const edited = yield* commit(
          {
            ...record,
            pendingEdit: true,
            goal: {
              ...record.goal,
              title: input.objective === undefined ? record.goal.title : deriveTitle(objective),
              objective,
              acceptanceCriteria: [...criteria],
              // An edit never resumes anything: it keeps the current status
              // together with the reason that belongs to it, so a paused goal
              // stays paused and a question behind Needs input survives the
              // edit. Starting the work again is the user's call through
              // Resume or Save & resume.
              status: record.goal.status,
              revision: record.goal.revision + 1,
              verification: { status: "pending", summary: null, checkedAt: null },
            },
          },
          {
            kind: "user",
            summary: "Goal updated by the user",
            detail: input.additionalRequirements ?? input.objective ?? null,
          },
        );
        yield* interruptGoal(record, "The user updated this goal.");
        yield* startDriver(edited.goal.id);
        return { goal: edited.goal };
      }).pipe(Effect.mapError((cause) => toGoalError(cause, input.id)));

    const pause: GoalService["Service"]["pause"] = (input) =>
      Effect.gen(function* () {
        const record = yield* readRecordOrFail(input.id);
        if (hasEnded(record.goal.status) || record.goal.status === "paused") {
          return { goal: record.goal };
        }
        // The open question lives in its own field, so pausing keeps it and
        // the answer still lands when the goal is resumed.
        const paused = yield* setStatus(record, "paused", "Paused by the user");
        yield* interruptGoal(record, "The user paused this goal.");
        return { goal: paused.goal };
      }).pipe(Effect.mapError((cause) => toGoalError(cause, input.id)));

    const resume: GoalService["Service"]["resume"] = (input) =>
      Effect.gen(function* () {
        const record = yield* readRecordOrFail(input.id);
        if (hasEnded(record.goal.status)) {
          return yield* new GoalError({
            message: "This goal has ended. Start a new goal instead.",
            goalId: input.id,
          });
        }
        // Resuming a goal parked on an answer would leave the question
        // unanswered, so the answer stays the way through.
        if (record.goal.status === "needs_input") {
          return yield* new GoalError({
            message: "This goal is waiting for an answer. Answer the question to continue.",
            goalId: input.id,
          });
        }
        // Resuming a parked goal puts it straight back to work instead of
        // waiting out the provider delay.
        if (record.goal.status === "waiting_provider") {
          const resumed = yield* resumeParkedGoal(record);
          yield* startDriver(resumed.goal.id);
          return { goal: resumed.goal };
        }
        if (isDriven(record.goal.status)) {
          yield* startDriver(record.goal.id);
          return { goal: record.goal };
        }
        const resumed = yield* commit(
          {
            ...record,
            providerWait: null,
            goal: {
              ...record.goal,
              status: record.goal.tasks.length === 0 ? "planning" : "running",
              blockedReason: null,
              failureReason: null,
              blocker: null,
            },
          },
          { kind: "status", summary: "Resumed by the user", detail: null },
        );
        yield* startDriver(resumed.goal.id);
        return { goal: resumed.goal };
      }).pipe(Effect.mapError((cause) => toGoalError(cause, input.id)));

    const cancel: GoalService["Service"]["cancel"] = (input) =>
      Effect.gen(function* () {
        const record = yield* readRecordOrFail(input.id);
        if (record.goal.status === "cancelled") return { goal: record.goal };
        if (record.goal.status === "completed") {
          return yield* new GoalError({
            message: "This goal is already complete.",
            goalId: input.id,
          });
        }
        const cancelled = yield* setStatus(record, "cancelled", "Cancelled by the user");
        yield* interruptGoal(record, "The user cancelled this goal.");
        return { goal: cancelled.goal };
      }).pipe(Effect.mapError((cause) => toGoalError(cause, input.id)));

    const answer: GoalService["Service"]["answer"] = (input) =>
      Effect.gen(function* () {
        const record = yield* readRecordOrFail(input.id);
        // A question may be open while other tasks keep working, so the goal
        // does not have to be parked on it. What matters is that a question
        // exists and nobody has answered it yet.
        if (record.goal.question === null || record.pendingAnswer !== null) {
          return yield* new GoalError({
            message: "This goal is not waiting for an answer.",
            goalId: input.id,
          });
        }
        const answered = yield* commit(
          {
            ...record,
            pendingAnswer: input.text,
            goal: {
              ...record.goal,
              // Answering is the user saying "go on": the goal resumes and
              // the answered task picks up where it stopped.
              status: "running",
            },
          },
          { kind: "user", summary: "You answered the agent's question", detail: input.text },
        );
        yield* startDriver(answered.goal.id);
        return { goal: answered.goal };
      }).pipe(Effect.mapError((cause) => toGoalError(cause, input.id)));

    const retryTask: GoalService["Service"]["retryTask"] = (input) =>
      Effect.gen(function* () {
        const record = yield* readRecordOrFail(input.id);
        if (hasEnded(record.goal.status)) {
          return yield* new GoalError({
            message: "This goal has ended. Start a new goal instead.",
            goalId: input.id,
          });
        }
        const task = record.goal.tasks.find((candidate) => candidate.id === input.taskId);
        if (task === undefined) {
          return yield* new GoalError({
            message: "Task not found in this goal.",
            goalId: input.id,
          });
        }
        const retried = yield* commit(
          {
            ...record,
            goal: {
              ...record.goal,
              status: record.goal.status === "paused" ? "paused" : "running",
              blockedReason: null,
              failureReason: null,
              verification: { status: "pending", summary: null, checkedAt: null },
              tasks: record.goal.tasks.map((candidate) =>
                candidate.id === task.id
                  ? {
                      ...candidate,
                      status: "pending",
                      startedAt: null,
                      completedAt: null,
                      evidence: null,
                      question: null,
                      // A person asked for this retry, so it starts a new
                      // recovery budget rather than inheriting the spent one.
                      attempts: 0,
                      recoveryAttempts: 0,
                      reassessments: 0,
                    }
                  : candidate,
              ),
            },
          },
          {
            kind: "user",
            summary: `Retrying: ${task.title}`,
            detail: task.evidence,
            taskId: task.id,
          },
        );
        if (retried.goal.status === "running" || retried.goal.status === "recovering") {
          yield* startDriver(retried.goal.id);
        }
        return { goal: retried.goal };
      }).pipe(Effect.mapError((cause) => toGoalError(cause, input.id)));

    /**
     * A driven goal with nobody driving it looks live forever: restart recovery
     * only claims the 20 most recent, and a driver that cannot persist its own
     * failure leaves the goal as it stood.
     *
     * The goal is picked back up instead of being blocked. A goal that nobody
     * is driving has lost its driver, not its way forward, so restarting the
     * driver is the recovery. Goals an active driver or a queued restart holds
     * are skipped, and the refs are re-read after the record so a driver that
     * started mid-sweep keeps the goal.
     */
    const sweepStuckGoals: GoalService["Service"]["sweepStuckGoals"] = () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const cutoff = DateTime.formatIso(
          DateTime.toUtc(
            DateTime.subtract(now, { seconds: Duration.toSeconds(GOAL_STUCK_THRESHOLD) }),
          ),
        );
        const rows = yield* sql<{ goal_id: string }>`
          SELECT goal_id FROM goals
          WHERE status IN ('planning', 'running', 'recovering', 'verifying')
            AND updated_at <= ${cutoff}
          ORDER BY updated_at ASC
          LIMIT 100
        `;
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              const goalId = GoalId.make(row.goal_id);
              const active = yield* Ref.get(drivers);
              if (active.has(goalId)) return;
              const queued = yield* Ref.get(pendingDrives);
              if (queued.has(goalId)) return;
              const record = yield* readRecord(goalId);
              if (record === null || !isDriven(record.goal.status)) return;
              // A commit after the query means the goal just changed hands.
              if (record.goal.updatedAt > cutoff) return;
              const stillActive = yield* Ref.get(drivers);
              if (stillActive.has(goalId)) return;
              const stillQueued = yield* Ref.get(pendingDrives);
              if (stillQueued.has(goalId)) return;
              yield* commit(record, {
                kind: "status",
                summary: "Picking the goal back up",
                detail: null,
              });
              yield* startDriver(goalId);
            }),
          { discard: true, concurrency: 1 },
        );
      }).pipe(Effect.mapError((cause) => toGoalError(cause)));

    /**
     * Brings back the goals whose provider wait is over.
     *
     * A parked goal holds no driver: it waits for this sweep, which reads the
     * moment it stored when it parked and puts it back to work. Goals paused
     * or cancelled while they waited are left alone.
     */
    const sweepParkedGoals: GoalService["Service"]["sweepParkedGoals"] = () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(DateTime.toUtc(now));
        const rows = yield* sql<{ goal_id: string }>`
          SELECT goal_id FROM goals
          WHERE status = 'waiting_provider'
            AND json_extract(provider_wait_json, '$.resumeAt') <= ${nowIso}
          ORDER BY updated_at ASC
          LIMIT 50
        `;
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              const goalId = GoalId.make(row.goal_id);
              const active = yield* Ref.get(drivers);
              if (active.has(goalId)) return;
              const queued = yield* Ref.get(pendingDrives);
              if (queued.has(goalId)) return;
              const record = yield* readRecord(goalId);
              if (record === null || record.goal.status !== "waiting_provider") return;
              const wait = record.providerWait;
              if (wait === null) return;
              if (Date.parse(wait.resumeAt) > DateTime.toEpochMillis(now)) return;
              const resumed = yield* resumeParkedGoal(record);
              yield* startDriver(resumed.goal.id);
            }),
          { discard: true, concurrency: 1 },
        );
      }).pipe(Effect.mapError((cause) => toGoalError(cause)));

    // Resume goals a crash or restart interrupted. The delay lets provider
    // runtimes come up first, so the first dispatched turn does not fail.
    yield* Effect.gen(function* () {
      yield* Effect.sleep(GOAL_RECOVERY_DELAY);
      const interrupted = yield* sql<{ goal_id: string }>`
        SELECT goal_id FROM goals
        WHERE status IN ('planning', 'running', 'recovering', 'verifying')
        ORDER BY updated_at DESC
        LIMIT 20
      `;
      yield* Effect.forEach(
        interrupted,
        (row) =>
          Effect.gen(function* () {
            yield* appendActivity(GoalId.make(row.goal_id), {
              kind: "status",
              summary: "Resumed after a server restart",
              detail: null,
            });
            yield* startDriver(GoalId.make(row.goal_id));
          }),
        { discard: true, concurrency: 1 },
      );
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not resume interrupted goals", { cause })),
      Effect.forkIn(scope),
    );

    // A goal nobody drives (recovery passed it over, or its driver could not
    // persist a failure) sits driven and silent; block it once it stays past
    // the threshold so the card offers Resume. The first pass waits out the
    // interval, so recovery re-drives restart interruptions before anything is
    // judged stuck. Failures log and the next pass still runs.
    yield* Effect.sleep(GOAL_STUCK_SWEEP_INTERVAL).pipe(
      Effect.andThen(
        sweepStuckGoals().pipe(
          Effect.catch((cause) => Effect.logWarning("Could not sweep stuck goals", { cause })),
          Effect.repeat(Schedule.spaced(GOAL_STUCK_SWEEP_INTERVAL)),
        ),
      ),
      Effect.forkIn(scope),
    );

    // A parked goal has no driver to wake it, so this pass is what brings it
    // back the moment its wait is over.
    yield* sweepParkedGoals().pipe(
      Effect.catch((cause) => Effect.logWarning("Could not sweep parked goals", { cause })),
      Effect.repeat(Schedule.spaced(GOAL_PARKED_SWEEP_INTERVAL)),
      Effect.forkIn(scope),
    );

    return {
      list,
      subscribeList,
      watchGoal,
      get,
      create,
      update,
      pause,
      resume,
      cancel,
      answer,
      retryTask,
      sweepStuckGoals,
      sweepParkedGoals,
    };
  }),
);
