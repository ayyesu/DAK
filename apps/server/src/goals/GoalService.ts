import {
  CommandId,
  GOAL_ACTIVITY_LIMIT,
  GOAL_MAX_CYCLES,
  GOAL_MAX_IDLE_CYCLES,
  GoalError,
  GoalId,
  GoalStatus,
  GoalTaskStatus,
  GoalVerification,
  MessageId,
  ModelSelection,
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
  type RunId,
} from "@dak/contracts";
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
/** Verification passes (each with one repair turn) before a goal is blocked. */
const GOAL_MAX_VERIFY_ROUNDS = 2;
/** Boot delay before interrupted goals resume, so provider runtimes are up. */
const GOAL_RECOVERY_DELAY = Duration.seconds(15);
/** A driven goal this old with no driver is stuck, not waiting for a turn. */
const GOAL_STUCK_THRESHOLD = Duration.seconds(10);
/** How often the sweep looks for driven goals whose driver died. */
const GOAL_STUCK_SWEEP_INTERVAL = Duration.seconds(60);
const ACTIVITY_DETAIL_LIMIT = 2_000;

const DRIVEN_STATUSES: ReadonlySet<Goal["status"]> = new Set(["planning", "running", "verifying"]);
/** Terminal states. `failed` is deliberately absent: resume or edit recovers it. */
const ENDED_STATUSES: ReadonlySet<Goal["status"]> = new Set(["completed", "cancelled"]);

type TurnPhase = "plan" | "task" | "verify" | "repair" | "answer" | "edit";

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
  readonly pending_edit: number;
  readonly pending_answer: string | null;
  readonly verify_rounds: number;
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
  readonly attempts: number;
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

/**
 * A goal plus the driver state that never crosses the wire. Rows are read as
 * one record so a mutation and the loop cannot disagree about the plan.
 */
interface GoalRecord {
  readonly goal: Goal;
  readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  readonly pendingEdit: boolean;
  readonly pendingAnswer: string | null;
  readonly verifyRounds: number;
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
    "task_blocked",
    "status",
    "prompt",
    "user",
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

function isDriven(status: Goal["status"]): boolean {
  return DRIVEN_STATUSES.has(status);
}

function hasEnded(status: Goal["status"]): boolean {
  return ENDED_STATUSES.has(status);
}

export class GoalService extends Context.Service<
  GoalService,
  {
    readonly list: (input: GoalListInput) => Effect.Effect<GoalListResult, GoalError>;
    /** Snapshot on subscribe, then a fresh list after every goal change. */
    readonly subscribeList: (input: GoalListInput) => Stream.Stream<GoalListResult, GoalError>;
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
      attempts: row.attempts,
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
        verifyRounds: row.verify_rounds,
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
      yield* sql`
        INSERT INTO goals (
          goal_id, project_id, thread_id, title, objective, acceptance_criteria_json, status,
          current_task_id, model_selection_json, runtime_mode, interaction_mode,
          workspace_strategy_json, revision, cycle_count, verification_json, blocked_reason,
          failure_reason, pending_edit, pending_answer, verify_rounds, created_by,
          creation_source, created_at, updated_at, started_at, turn_started_at,
          completed_at, last_activity_at
        ) VALUES (
          ${goal.id}, ${goal.projectId}, ${goal.threadId}, ${goal.title}, ${goal.objective},
          ${encodeCriteria([...goal.acceptanceCriteria])}, ${goal.status}, ${goal.currentTaskId},
          ${encodeModelSelection(goal.modelSelection)}, ${goal.runtimeMode},
          ${goal.interactionMode}, ${encodeWorkspaceStrategy(record.workspaceStrategy)},
          ${goal.revision}, ${goal.cycleCount}, ${encodeVerification(goal.verification)},
          ${goal.blockedReason}, ${goal.failureReason}, ${record.pendingEdit ? 1 : 0},
          ${record.pendingAnswer}, ${record.verifyRounds}, ${goal.createdBy},
          ${goal.creationSource}, ${goal.createdAt}, ${goal.updatedAt}, ${goal.startedAt},
          ${goal.turnStartedAt}, ${goal.completedAt}, ${goal.lastActivityAt}
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
          pending_edit = excluded.pending_edit,
          pending_answer = excluded.pending_answer,
          verify_rounds = excluded.verify_rounds,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          started_at = excluded.started_at,
          turn_started_at = excluded.turn_started_at,
          completed_at = excluded.completed_at,
          last_activity_at = excluded.last_activity_at
      `;

      yield* sql`DELETE FROM goal_tasks WHERE goal_id = ${goal.id}`;
      yield* Effect.forEach(
        goal.tasks,
        (task) => sql`
          INSERT INTO goal_tasks (
            goal_id, task_id, title, detail, status, task_order, started_at, completed_at,
            evidence, attempts
          ) VALUES (
            ${goal.id}, ${task.id}, ${task.title}, ${task.detail}, ${task.status},
            ${task.order}, ${task.startedAt}, ${task.completedAt}, ${task.evidence}, ${task.attempts}
          )
        `,
        { discard: true, concurrency: 1 },
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
            completedAt: status === "completed" ? yield* nowIso : record.goal.completedAt,
            currentTaskId:
              status === "completed" || status === "cancelled" ? null : record.goal.currentTaskId,
          },
        },
        { kind: "status", summary, detail: options?.detail ?? null },
      );
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
     * One dispatched turn, from writing the cycle through reading its report.
     *
     * Besides `report`/`no_report`/`stopped`, the outcome can be `interrupted`
     * (the run ended while the goal is still driven) or `relaunch` (the thread
     * vanished); the drive loop continues on both instead of blocking. Pause
     * and cancel set the goal's status before they end the run, so they are
     * filtered by the authoritative read and surface as `stopped`.
     */
    const runTurn = (
      record: GoalRecord,
      prompt: string,
      phase: TurnPhase,
      options?: { readonly taskId?: string | null; readonly status?: Goal["status"] },
    ) =>
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
          const blocked = yield* setStatus(
            yield* readRecordOrFail(goal.id),
            "blocked",
            "The goal's thread is archived",
            {
              blockedReason:
                "The goal's thread was archived and cannot receive messages. Resume to continue in a new thread.",
            },
          );
          return { kind: "stopped", record: blocked, report: null };
        }
        if (dispatched === null) {
          // The thread is gone; the drive loop dispatches again and launches
          // a replacement instead of parking on a dead goal.
          return { kind: "relaunch", record: yield* readRecordOrFail(goal.id), report: null };
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
          // setStatus writes the record it is given, so it must carry the
          // launched thread or the blocked goal would forget it.
          const blocked = yield* setStatus(launched, "blocked", "The agent turn did not start", {
            blockedReason: "The thread launched without a run. Resume to try again.",
          });
          return { kind: "stopped", record: blocked, report: null };
        }

        const forgetThreadDuringTurn = (summary: string) =>
          Effect.gen(function* () {
            const current = yield* readRecordOrFail(goal.id);
            if (!isDriven(current.goal.status)) {
              return { kind: "stopped", record: current, report: null };
            }
            const forgot = yield* commit(
              { ...current, goal: { ...current.goal, threadId: null } },
              { kind: "error", summary, detail: null },
            );
            return { kind: "relaunch", record: forgot, report: null };
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
              return { kind: "stopped", record: timedOutRecord, report: null };
            }
            const blocked = yield* setStatus(
              timedOutRecord,
              "blocked",
              "The agent turn ran too long",
              {
                blockedReason: `No turn result after ${Math.round(GOAL_TURN_TIMEOUT_MS / 60_000)} minutes. Resume when the thread is idle.`,
              },
            );
            return { kind: "stopped", record: blocked, report: null };
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
            return { kind: "stopped", record: afterWait, report: null };
          }

          if (!completed) {
            const runStatus = waited.run?.status ?? null;
            if (runStatus === "failed") {
              const failed = yield* setStatus(
                afterWait,
                "failed",
                "The agent turn ended as failed",
                { failureReason: "The provider turn failed." },
              );
              return { kind: "stopped", record: failed, report: null };
            }
            if (
              runStatus === "interrupted" ||
              runStatus === "cancelled" ||
              runStatus === "rolled_back"
            ) {
              // Still driven, so whoever ended the turn (an update interrupting
              // for a new edit, or a stop in the thread) is answered by
              // re-dispatching on the next cycle rather than blocking.
              return { kind: "interrupted", record: afterWait, report: null };
            }
            const blocked = yield* setStatus(
              afterWait,
              "blocked",
              `The agent turn ended as ${runStatus ?? "no run"}`,
              {
                blockedReason: `The last turn ended as ${runStatus ?? "no run"}. Resume to continue from here.`,
              },
            );
            return { kind: "stopped", record: blocked, report: null };
          }

          const report = parseGoalReport(reply);
          return report === null
            ? { kind: "no_report", record: afterWait, report: null }
            : { kind: "report", report, record: afterWait };
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
                  return { kind: "stopped", record: current, report: null };
                }
                // Drop the binding so Resume continues in a new thread instead
                // of re-hitting the archive on every attempt.
                const blocked = yield* setStatus(
                  { ...current, goal: { ...current.goal, threadId: null } },
                  "blocked",
                  "The goal's thread is archived",
                  {
                    blockedReason:
                      "The goal's thread was archived mid-turn. Resume to continue in a new thread.",
                  },
                );
                return { kind: "stopped", record: blocked, report: null };
              }),
          }),
        );
      }).pipe(
        Effect.mapError((cause) => toGoalError(cause)),
        Effect.withSpan("GoalService.runTurn"),
      );

    const applyReport = Effect.fn("GoalService.applyReport")(function* (
      record: GoalRecord,
      report: GoalReport,
      options?: { readonly repair?: boolean; readonly planHandling?: GoalPlanHandling },
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
      const goal: Goal = {
        ...record.goal,
        tasks: [...applied.tasks],
        acceptanceCriteria: [...applied.acceptanceCriteria],
        currentTaskId: applied.currentTaskId,
        // A turn that reports no work yet leaves a task-less goal in planning
        // so the loop re-plans instead of blocking on an empty plan.
        status:
          applied.status === "running" && applied.tasks.length === 0 ? "planning" : applied.status,
        verification,
        blockedReason:
          applied.status === "blocked"
            ? (report.summary ?? "The agent reported being blocked.")
            : applied.status === "needs_input"
              ? (report.question ?? "The agent needs information to continue.")
              : null,
        failureReason: null,
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
      return { record: next, allCompleted, status: goal.status };
    });

    const verifyCompletion = Effect.fn("GoalService.verifyCompletion")(function* (
      record: GoalRecord,
      report: GoalReport,
    ) {
      const goal = record.goal;
      const unmet = goal.acceptanceCriteria.filter(
        (criterion) =>
          !report.acceptance.some(
            (entry) =>
              entry.met && normalizedCriterion(entry.criterion) === normalizedCriterion(criterion),
          ),
      );
      const allTasksCompleted =
        goal.tasks.length > 0 && goal.tasks.every((task) => task.status === "completed");
      const verified =
        report.verified === true &&
        unmet.length === 0 &&
        allTasksCompleted &&
        (goal.acceptanceCriteria.length === 0 || report.acceptance.length > 0);
      // Per-criterion results for the UI, whatever the pass decided.
      const criterionResults = goal.acceptanceCriteria.map((criterion) => ({
        criterion,
        met: !unmet.some((entry) => normalizedCriterion(entry) === normalizedCriterion(criterion)),
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

      const rounds = record.verifyRounds + 1;
      const summary =
        report.summary ??
        (unmet.length > 0
          ? `Unmet: ${unmet.join("; ")}`
          : "The agent did not confirm that the goal is satisfied.");
      if (rounds >= GOAL_MAX_VERIFY_ROUNDS) {
        const blocked = yield* commit(
          {
            ...record,
            verifyRounds: rounds,
            goal: {
              ...goal,
              status: "blocked",
              verification: {
                status: "failed",
                summary,
                checkedAt: at,
                criteria: criterionResults,
              },
              blockedReason: `Verification did not pass: ${summary}`,
            },
          },
          { kind: "verification", summary: "Verification failed", detail: summary },
        );
        return { done: true as const, record: blocked };
      }

      const repair = yield* commit(
        {
          ...record,
          verifyRounds: rounds,
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

    const drive = (goalId: GoalId) =>
      Effect.gen(function* () {
        let idleCycles = 0;
        for (let iteration = 0; iteration < GOAL_MAX_CYCLES + 2; iteration += 1) {
          const record = yield* readRecordOrFail(goalId);
          const goal = record.goal;
          if (!isDriven(goal.status)) return;

          if (goal.cycleCount >= GOAL_MAX_CYCLES) {
            yield* setStatus(record, "blocked", "Stopped after too many attempts", {
              blockedReason: `The goal used all ${GOAL_MAX_CYCLES} attempts without finishing. Review the plan and resume to continue.`,
            });
            return;
          }

          if (record.pendingAnswer !== null) {
            const question = goal.blockedReason ?? "You asked the user for clarification.";
            // The answer stays stored until its turn completes, so a pause or
            // an interrupted turn cannot swallow the user's reply.
            const outcome = yield* runTurn(
              { ...record, verifyRounds: 0 },
              buildGoalAnswerPrompt({ goal, question, answer: record.pendingAnswer }),
              "answer",
            );
            if (outcome.kind === "stopped") return;
            if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
            const cleared = yield* commit(
              {
                ...outcome.record,
                pendingAnswer: null,
                goal: { ...outcome.record.goal, blockedReason: null },
              },
              { kind: "user", summary: "Continued with the user's answer", detail: null },
            );
            if (outcome.report === null) {
              idleCycles += 1;
              continue;
            }
            const applied = yield* applyReport(cleared, outcome.report, {
              planHandling: "ignore",
            });
            if (applied.status === "needs_input" || applied.status === "blocked") return;
            continue;
          }

          if (record.pendingEdit) {
            const dispatchedRevision = record.goal.revision;
            const outcome = yield* runTurn(record, buildGoalEditPrompt(goal), "edit");
            if (outcome.kind === "stopped") return;
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
            });
            if (applied.status === "needs_input" || applied.status === "blocked") return;
            continue;
          }

          if (goal.status === "planning" && goal.tasks.length === 0) {
            const outcome = yield* runTurn(record, buildGoalPlanningPrompt(goal), "plan");
            if (outcome.kind === "stopped") return;
            if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
            if (outcome.report === null) {
              idleCycles += 1;
              if (idleCycles >= GOAL_MAX_IDLE_CYCLES) {
                yield* setStatus(outcome.record, "blocked", "The agent did not produce a plan", {
                  blockedReason:
                    "The planning turn finished without a plan report. Resume to try planning again.",
                });
                return;
              }
              continue;
            }
            idleCycles = 0;
            const applied = yield* applyReport(outcome.record, outcome.report);
            if (applied.status === "needs_input" || applied.status === "blocked") return;
            if (applied.record.goal.tasks.length === 0) {
              yield* setStatus(applied.record, "blocked", "The agent did not produce a plan", {
                blockedReason: "The planning turn reported no tasks. Resume to try planning again.",
              });
              return;
            }
            continue;
          }

          if (goal.status === "verifying") {
            const outcome = yield* runTurn(record, buildGoalVerificationPrompt(goal), "verify");
            if (outcome.kind === "stopped") return;
            if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
            if (outcome.report === null) {
              idleCycles += 1;
              if (idleCycles >= GOAL_MAX_IDLE_CYCLES) {
                yield* setStatus(outcome.record, "blocked", "Verification never reported back", {
                  blockedReason:
                    "The verification turn finished without a report. Resume to verify again.",
                });
                return;
              }
              continue;
            }
            idleCycles = 0;
            const verified = yield* verifyCompletion(outcome.record, outcome.report);
            if (verified.done) return;
            continue;
          }

          if (goal.tasks.length === 0) {
            yield* setStatus(record, "blocked", "This goal has no tasks", {
              blockedReason: "The plan is empty. Edit the goal to define what should happen.",
            });
            return;
          }

          const allCompleted = goal.tasks.every((task) => task.status === "completed");
          if (allCompleted) {
            if (goal.verification.status === "failed") {
              const outcome = yield* runTurn(record, buildGoalRepairPrompt(goal), "repair");
              if (outcome.kind === "stopped") return;
              if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
              if (outcome.report === null) {
                idleCycles += 1;
                if (idleCycles >= GOAL_MAX_IDLE_CYCLES) {
                  yield* setStatus(outcome.record, "blocked", "Repair did not report back", {
                    blockedReason: "The repair turn finished without a report. Resume to continue.",
                  });
                  return;
                }
                continue;
              }
              idleCycles = 0;
              const applied = yield* applyReport(outcome.record, outcome.report, {
                repair: true,
                planHandling: "extend",
              });
              if (applied.status !== "running" && applied.status !== "verifying") return;
              continue;
            }
            yield* setStatus(record, "verifying", "Verifying the result against the goal", {
              detail: goal.acceptanceCriteria.join("\n") || null,
            });
            continue;
          }

          const nextTask =
            goal.tasks.find((task) => task.status === "in_progress") ??
            goal.tasks.find((task) => task.status === "pending");
          if (nextTask === undefined) {
            const stuck = goal.tasks.filter(
              (task) => task.status === "failed" || task.status === "blocked",
            );
            yield* setStatus(record, "blocked", "No runnable task remains", {
              blockedReason:
                stuck.length === 0
                  ? "Every task ended without a runnable next step."
                  : `Waiting on: ${stuck.map((task) => task.title).join("; ")}. Retry a task or edit the goal.`,
            });
            return;
          }

          const markedAt = yield* nowIso;
          const marked: GoalRecord = {
            ...record,
            goal: {
              ...goal,
              tasks: goal.tasks.map((task) =>
                task.id === nextTask.id && task.status === "pending"
                  ? {
                      ...task,
                      status: "in_progress",
                      startedAt: task.startedAt ?? markedAt,
                      attempts: task.attempts + 1,
                    }
                  : task,
              ),
              currentTaskId: nextTask.id,
            },
          };
          yield* commit(marked, {
            kind: "task_started",
            summary: `Working on: ${nextTask.title}`,
            detail: nextTask.detail,
            taskId: nextTask.id,
          });

          const outcome = yield* runTurn(
            marked,
            buildGoalExecutionPrompt({ goal: marked.goal, task: nextTask, edited: false }),
            "task",
            { taskId: nextTask.id },
          );
          if (outcome.kind === "stopped") return;
          if (outcome.kind === "interrupted" || outcome.kind === "relaunch") continue;
          if (outcome.report === null) {
            idleCycles += 1;
            if (idleCycles >= GOAL_MAX_IDLE_CYCLES) {
              yield* setStatus(outcome.record, "blocked", "The agent stopped reporting progress", {
                blockedReason:
                  "Two consecutive turns produced no progress report. Check the thread, then resume or edit the goal.",
              });
              return;
            }
            continue;
          }
          idleCycles = 0;
          const applied = yield* applyReport(outcome.record, outcome.report, {
            planHandling: "ignore",
          });
          if (applied.status === "needs_input" || applied.status === "blocked") return;
          if (applied.status === "completed") return;
        }

        const last = yield* readRecordOrFail(goalId);
        if (isDriven(last.goal.status)) {
          yield* setStatus(last, "blocked", "Stopped after too many attempts", {
            blockedReason: "The execution loop hit its iteration guard. Resume to continue.",
          });
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

    /** The list payload is only what selection and collapsed cards need. */
    const toGoalSummary = (goal: Goal): GoalSummary => ({
      id: goal.id,
      projectId: goal.projectId,
      threadId: goal.threadId,
      title: goal.title,
      status: goal.status,
      currentTaskId: goal.currentTaskId,
      currentTaskTitle:
        goal.tasks.find((task) => task.id === goal.currentTaskId)?.title ??
        goal.tasks.find((task) => task.status === "in_progress")?.title ??
        null,
      completedTaskCount: goal.tasks.filter((task) => task.status === "completed").length,
      totalTaskCount: goal.tasks.length,
      turnStartedAt: goal.turnStartedAt,
      blockedReason: goal.blockedReason,
      failureReason: goal.failureReason,
      updatedAt: goal.updatedAt,
      lastActivityAt: goal.lastActivityAt,
      completedAt: goal.completedAt,
    });

    const listRecords = Effect.fn("GoalService.listRecords")(function* (projectId?: string) {
      const rows =
        projectId === undefined
          ? yield* sql<{ goal_id: string }>`
              SELECT goal_id FROM goals ORDER BY updated_at DESC, goal_id ASC LIMIT 100
            `
          : yield* sql<{ goal_id: string }>`
              SELECT goal_id FROM goals WHERE project_id = ${projectId}
              ORDER BY updated_at DESC, goal_id ASC LIMIT 100
            `;
      const records = yield* Effect.forEach(rows, (row) => readRecord(GoalId.make(row.goal_id)), {
        concurrency: 1,
      });
      return records.flatMap((record) => (record === null ? [] : [record]));
    });

    const list: GoalService["Service"]["list"] = (input) =>
      listRecords(input.projectId).pipe(
        Effect.map((records) => ({ goals: records.map((record) => toGoalSummary(record.goal)) })),
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

    const get: GoalService["Service"]["get"] = (input) =>
      readRecordOrFail(input.id).pipe(
        Effect.map((record) => ({ goal: record.goal })),
        Effect.mapError((cause) => toGoalError(cause, input.id)),
      );

    const create: GoalService["Service"]["create"] = (input) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const id = GoalId.make(`goal:${yield* randomUuidV4}`);
        const goal: Goal = {
          id,
          projectId: input.projectId,
          threadId: input.threadId ?? null,
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
          verifyRounds: 0,
        };
        yield* writeRecord(record);
        yield* appendActivity(id, {
          kind: "created",
          summary: "Goal created",
          detail: goal.objective,
        });
        yield* appendActivity(id, {
          kind: "status",
          summary: "Planning the work",
          detail: null,
        });
        yield* notifyChanged;
        yield* startDriver(id);
        const saved = yield* readRecordOrFail(id);
        return { goal: saved.goal };
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
            verifyRounds: 0,
            goal: {
              ...record.goal,
              title: input.objective === undefined ? record.goal.title : deriveTitle(objective),
              objective,
              acceptanceCriteria: [...criteria],
              // Without a plan yet the goal keeps planning: an edit must not
              // shove a task-less goal into running, where the loop would
              // block on the empty plan instead of re-planning.
              status: record.goal.tasks.length === 0 ? "planning" : "running",
              revision: record.goal.revision + 1,
              blockedReason: null,
              failureReason: null,
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
        // The question lives only in blockedReason, which pausing would clear;
        // refuse instead of silently dropping an answer the agent is waiting on.
        if (record.goal.status === "needs_input") {
          return yield* new GoalError({
            message: "This goal is waiting for an answer. Answer the question to continue.",
            goalId: input.id,
          });
        }
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
        // Resuming from needs_input would null blockedReason (the question)
        // while pendingAnswer is still null, losing the agent's ask entirely.
        if (record.goal.status === "needs_input") {
          return yield* new GoalError({
            message: "This goal is waiting for an answer. Answer the question to continue.",
            goalId: input.id,
          });
        }
        if (isDriven(record.goal.status)) {
          yield* startDriver(record.goal.id);
          return { goal: record.goal };
        }
        const resumed = yield* commit(
          {
            ...record,
            verifyRounds: 0,
            goal: {
              ...record.goal,
              status: record.goal.tasks.length === 0 ? "planning" : "running",
              blockedReason: null,
              failureReason: null,
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
        if (record.goal.status !== "needs_input") {
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
              status: "running",
              blockedReason: record.goal.blockedReason,
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
            verifyRounds: 0,
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
        if (retried.goal.status === "running") yield* startDriver(retried.goal.id);
        return { goal: retried.goal };
      }).pipe(Effect.mapError((cause) => toGoalError(cause, input.id)));

    /**
     * A driven goal with nobody driving it looks live forever: restart recovery
     * only claims the 20 most recent, and a driver that cannot persist its own
     * failure leaves the goal as it stood. Block those so the card offers
     * Resume. Goals an active driver or a queued restart holds are skipped, and
     * the refs are re-read after the record so a driver that started mid-sweep
     * keeps the goal.
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
          WHERE status IN ('planning', 'running', 'verifying')
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
              yield* setStatus(record, "blocked", "The goal stopped making progress", {
                blockedReason: "The goal stopped making progress. Resume to continue.",
              });
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
        WHERE status IN ('planning', 'running', 'verifying')
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

    return {
      list,
      subscribeList,
      get,
      create,
      update,
      pause,
      resume,
      cancel,
      answer,
      retryTask,
      sweepStuckGoals,
    };
  }),
);
