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
 *
 * `recovering` means the agent hit an obstacle and is working through it.
 * `needs_input` means it is waiting for the user. `blocked` is reserved for a
 * genuine deadlock with evidence behind it.
 *
 * `waiting_provider` means the environment, not the agent, stopped the work:
 * the provider failed, hit its usage limit, or could not be reached. The
 * server parks the goal there and resumes it on its own, so this state never
 * needs the user to intervene.
 */
export const GoalStatus = Schema.Literals([
  "draft",
  "planning",
  "running",
  "recovering",
  "paused",
  "needs_input",
  "blocked",
  "waiting_provider",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);
export type GoalStatus = typeof GoalStatus.Type;

/**
 * The evidence a blocked task or goal must carry. The server only accepts a
 * block when every part of this assessment is present, so a block is a
 * conclusion drawn from execution, not a shrug.
 */
export const GoalBlocker = Schema.Struct({
  /** The exact thing that stopped the work. */
  reason: Schema.String,
  /** Why it is true. */
  rootCause: Schema.String,
  /** What was inspected to find it. */
  investigation: Schema.String,
  /** The recovery attempts that were made. */
  attempts: Schema.Array(Schema.String),
  /** The alternatives that were considered. */
  alternatives: Schema.Array(Schema.String),
  /** The external intervention that would unblock it. */
  intervention: Schema.String,
  /** Whether other independent tasks can still make progress. */
  otherTasksCanContinue: Schema.Boolean,
});
export type GoalBlocker = typeof GoalBlocker.Type;

/**
 * A task never sits in a bare `blocked` state: an obstacle either sends it
 * through `recovering` (the agent is still working on it) or `waiting_input`
 * (only the user can move it forward). `failed` means the agent produced a
 * full assessment of a deadlock it cannot get past.
 */
export const GoalTaskStatus = Schema.Literals([
  "pending",
  "in_progress",
  "recovering",
  "waiting_input",
  "completed",
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
  /** The question this task is waiting on, when it needs the user. */
  question: Schema.NullOr(Schema.String),
  /**
   * The evidence behind this task's dead end. A task only carries one when
   * the agent produced a full assessment of what is blocking it.
   */
  blocker: Schema.NullOr(GoalBlocker),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Recovery turns spent on the current obstacle. Drives reassessment. */
  recoveryAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Reassessment turns spent after the recovery budget was exhausted. */
  reassessments: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * Tasks that must complete before this one runs. Empty means independent, so
   * a task waiting on the user never holds up the rest of the plan.
   */
  dependsOn: Schema.Array(TrimmedNonEmptyString),
});
export type GoalTask = typeof GoalTask.Type;

export const GoalActivityKind = Schema.Literals([
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

/** A single piece of verifiable proof that a criterion was met. */
export const GoalProof = Schema.Struct({
  /** Kind of proof: image, screenshot, canvas, test, check, run, or text. */
  type: Schema.Literals(["image", "screenshot", "canvas", "test", "check", "run", "text"]),
  /** URL where the proof asset can be viewed (image file, canvas export, test report). */
  url: Schema.String,
  /** Optional thumbnail URL for images and screenshots. */
  thumbnailUrl: Schema.NullOr(Schema.String),
  /** Human-readable description of what this proof shows. */
  caption: Schema.NullOr(Schema.String),
  /** When the proof was captured. Null when the agent did not supply one. */
  createdAt: Schema.NullOr(IsoDateTime),
});
export type GoalProof = typeof GoalProof.Type;

/** One acceptance criterion's result from the last verification pass. */
export const GoalVerificationCriterion = Schema.Struct({
  criterion: Schema.String,
  met: Schema.Boolean,
  /** Rich proof backing this criterion: images, screenshots, canvas, test results, etc. */
  proof: Schema.optional(Schema.Array(GoalProof)),
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
  /** The open question the agent asked, when it is waiting for the user. */
  question: Schema.NullOr(Schema.String),
  /** The task the open question belongs to. */
  questionTaskId: Schema.NullOr(Schema.String),
  /** The evidence behind a blocked goal; null while the goal is not blocked. */
  blocker: Schema.NullOr(GoalBlocker),
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
  /** The open question the agent asked, when one is waiting for the user. */
  question: Schema.NullOr(Schema.String),
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

/**
 * One goal's live detail. A client opens this while the user is looking at
 * the goal, so the detail payload is only built for a goal somebody watches.
 */
export const GoalWatchInput = Schema.Struct({ id: GoalId });
export type GoalWatchInput = typeof GoalWatchInput.Type;

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
/** Tasks one plan may contain. No cap: the agent decides its own approach. */
export const GOAL_MAX_TASKS = 10_000;
/**
 * Recovery turns a task may spend on one failure before the server asks the
 * agent to reassess instead of retrying. Past this point every further
 * attempt is a reassessment, and reassessments never run out: a task is only
 * stopped by evidence, never by a counter.
 */
export const GOAL_RECOVERY_ATTEMPTS = 4;
/**
 * Consecutive turns without a usable progress report before the server
 * escalates the prompt instead of repeating the same one. A report resets
 * this. The escalation asks the agent what went wrong; it never ends the
 * goal.
 */
export const GOAL_IDLE_ESCALATION_CYCLES = 3;
/** Verification repair rounds before the server asks for a reassessment. */
export const GOAL_MAX_VERIFY_REPAIR_ROUNDS = 3;
