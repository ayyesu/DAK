import * as Schema from "effect/Schema";

import { GoalId, IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * A goal moves through these states while the server drives its execution
 * loop. `draft` is reserved for a goal stored before planning starts; clients
 * never create one, but an interrupted create can be recovered into it.
 */
export const GoalStatus = Schema.Literals([
  "draft",
  "planning",
  "running",
  "paused",
  "needs_input",
  "blocked",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);
export type GoalStatus = typeof GoalStatus.Type;

export const GoalTaskStatus = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "failed",
]);
export type GoalTaskStatus = typeof GoalTaskStatus.Type;

/** A task the agent's plan produced. Only the server mutates these. */
export const GoalTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String),
  status: GoalTaskStatus,
  /** Position in the plan, ascending. */
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  /** What the agent reported as proof the task is done; never inferred. */
  evidence: Schema.NullOr(Schema.String),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type GoalTask = typeof GoalTask.Type;

export const GoalActivityKind = Schema.Literals([
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
]);
export type GoalActivityKind = typeof GoalActivityKind.Type;

/** One line of the execution log shown when the activity section is expanded. */
export const GoalActivity = Schema.Struct({
  id: TrimmedNonEmptyString,
  at: IsoDateTime,
  kind: GoalActivityKind,
  summary: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
});
export type GoalActivity = typeof GoalActivity.Type;

export const GoalVerificationStatus = Schema.Literals(["pending", "passed", "failed"]);
export type GoalVerificationStatus = typeof GoalVerificationStatus.Type;

/** One acceptance criterion's result from the last verification pass. */
export const GoalVerificationCriterion = Schema.Struct({
  criterion: Schema.String,
  met: Schema.Boolean,
});
export type GoalVerificationCriterion = typeof GoalVerificationCriterion.Type;

export const GoalVerification = Schema.Struct({
  status: GoalVerificationStatus,
  summary: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(IsoDateTime),
  /** Absent until a verification pass ran under a schema that recorded it. */
  criteria: Schema.optional(Schema.Array(GoalVerificationCriterion)),
});
export type GoalVerification = typeof GoalVerification.Type;

export const Goal = Schema.Struct({
  id: GoalId,
  projectId: ProjectId,
  /** The thread the goal drives, once one exists. */
  threadId: Schema.NullOr(ThreadId),
  title: TrimmedNonEmptyString,
  /** The outcome the user asked for, in their words. */
  objective: Schema.String,
  /** Conditions the verification pass must satisfy before completion. */
  acceptanceCriteria: Schema.Array(Schema.String),
  status: GoalStatus,
  tasks: Schema.Array(GoalTask),
  /** Newest last, bounded by the server to keep the live payload small. */
  activities: Schema.Array(GoalActivity),
  currentTaskId: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** Bumped whenever the user edits the goal; the plan keeps completed work. */
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Turns dispatched so far, including verification passes. */
  cycleCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  verification: GoalVerification,
  blockedReason: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(Schema.String),
  /** The agent's own progress estimate (0-100), reported each turn. */
  progress: Schema.NullOr(Schema.Int),
  /** Human label for the agent's reported progress. */
  progressLabel: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  /** When the driver last dispatched a turn; cleared when the goal stops being driven. */
  turnStartedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  lastActivityAt: IsoDateTime,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
});
export type Goal = typeof Goal.Type;

/** The user's own words; bounded so one goal cannot blow past a provider turn limit. */
const GoalObjective = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));
const GoalAcceptanceCriterion = Schema.String.check(Schema.isMaxLength(500));
const GoalAcceptanceCriteria = Schema.Array(GoalAcceptanceCriterion).check(Schema.isMaxLength(20));

export const GoalListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId).annotate({
    description: "Only list goals in this project.",
  }),
});
export type GoalListInput = typeof GoalListInput.Type;

/** A goal as listed for selection or notification; details load on demand. */
export const GoalSummary = Schema.Struct({
  id: GoalId,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  title: TrimmedNonEmptyString,
  status: GoalStatus,
  currentTaskId: Schema.NullOr(Schema.String),
  currentTaskTitle: Schema.NullOr(Schema.String),
  completedTaskCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalTaskCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  turnStartedAt: Schema.NullOr(IsoDateTime),
  blockedReason: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(Schema.String),
  /** The agent's own progress estimate (0-100), reported each turn. */
  progress: Schema.NullOr(Schema.Int),
  /** Human label for the agent's reported progress. */
  progressLabel: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type GoalSummary = typeof GoalSummary.Type;

export const GoalListResult = Schema.Struct({
  goals: Schema.Array(GoalSummary),
});
export type GoalListResult = typeof GoalListResult.Type;

export const GoalCreateInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)).annotate({
    description: "Bind the goal to an existing thread. Omit to start a fresh one.",
  }),
  objective: GoalObjective.annotate({
    description: "The outcome the agent should achieve, in the user's own words.",
  }),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  acceptanceCriteria: Schema.optional(GoalAcceptanceCriteria).annotate({
    description: "Conditions that must hold before the goal counts as complete.",
  }),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type GoalCreateInput = typeof GoalCreateInput.Type;

export const GoalPauseInput = Schema.Struct({ id: GoalId });
export type GoalPauseInput = typeof GoalPauseInput.Type;

export const GoalResumeInput = Schema.Struct({ id: GoalId });
export type GoalResumeInput = typeof GoalResumeInput.Type;

export const GoalCancelInput = Schema.Struct({ id: GoalId });
export type GoalCancelInput = typeof GoalCancelInput.Type;

export const GoalGetInput = Schema.Struct({ id: GoalId });
export type GoalGetInput = typeof GoalGetInput.Type;

export const GoalUpdateInput = Schema.Struct({
  id: GoalId,
  objective: Schema.optional(GoalObjective).annotate({
    description: "Replace the objective. Completed work is kept.",
  }),
  additionalRequirements: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))).annotate(
    {
      description: "Extra constraints appended to the objective.",
    },
  ),
  acceptanceCriteria: Schema.optional(GoalAcceptanceCriteria),
});
export type GoalUpdateInput = typeof GoalUpdateInput.Type;

/** Answers a `needs_input` pause with the information the agent asked for. */
export const GoalAnswerInput = Schema.Struct({
  id: GoalId,
  text: TrimmedNonEmptyString,
});
export type GoalAnswerInput = typeof GoalAnswerInput.Type;

/** Puts a failed or blocked task back in the queue without touching the rest. */
export const GoalRetryTaskInput = Schema.Struct({
  id: GoalId,
  taskId: TrimmedNonEmptyString,
});
export type GoalRetryTaskInput = typeof GoalRetryTaskInput.Type;

export const GoalMutationResult = Schema.Struct({ goal: Goal });
export type GoalMutationResult = typeof GoalMutationResult.Type;

export class GoalError extends Schema.TaggedError<GoalError>()("GoalError", {
  message: Schema.String,
  goalId: Schema.optional(GoalId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Activities kept in the live goal payload; older ones fall off. */
export const GOAL_ACTIVITY_LIMIT = 40;
/** Tasks one plan may contain, so a runaway plan cannot flood the UI. */
export const GOAL_MAX_TASKS = 30;
/** Execution cycles per goal before the server stops instead of looping forever. */
export const GOAL_MAX_CYCLES = 24;
/** Consecutive turns without a usable progress report before a goal is blocked. */
export const GOAL_MAX_IDLE_CYCLES = 2;
