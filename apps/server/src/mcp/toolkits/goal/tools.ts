import {
  GoalAnswerInput,
  GoalCancelInput,
  GoalCreateInput,
  GoalGetInput,
  GoalListInput,
  GoalListResult,
  GoalMutationResult,
  GoalPauseInput,
  GoalResumeInput,
  GoalRetryTaskInput,
  GoalUpdateInput,
  ModelSelection,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@dak/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as GoalService from "../../../goals/GoalService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  GoalService.GoalService,
  ProjectService.ProjectService,
];

const GoalListTool = Tool.make("dak_goal_list", {
  description:
    "List lightweight goal summaries in this environment. Use this to find a goal id and its current status; read the goal for tasks, activities, criteria, and verification details. Omit projectId to list every project.",
  parameters: GoalListInput,
  success: GoalListResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const GoalReadTool = Tool.make("dak_goal_read", {
  description:
    "Read one goal in full, including its objective, acceptance criteria, plan tasks, activity history, verification, and the current question or failure reason.",
  parameters: GoalGetInput,
  success: GoalMutationResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const GoalCreateTool = Tool.make("dak_goal_create", {
  description:
    "Create a goal and start it right away. The goal keeps working while its thread waits, and only stops for a question, an obstacle, verification, or completion. Omit projectId, modelSelection, and modes to inherit them from the calling thread or project default. createdBy will be agent and creationSource will be mcp. A thread runs one goal: a thread that already has a goal is refused, and a goal's own thread cannot start another goal.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    threadId: Schema.optional(Schema.NullOr(ThreadId)),
    objective: GoalCreateInput.fields.objective,
    title: Schema.optional(GoalCreateInput.fields.title),
    acceptanceCriteria: Schema.optional(GoalCreateInput.fields.acceptanceCriteria),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(GoalCreateInput.fields.workspaceStrategy),
  }),
  success: GoalMutationResult,
  failure: OrchestratorMcpFailure,
  dependencies,
}).annotate(Tool.Destructive, true);

const GoalUpdateTool = Tool.make("dak_goal_update", {
  description:
    "Update a goal's objective or acceptance criteria. Completed work is kept and the remaining plan is revised.",
  parameters: GoalUpdateInput,
  success: GoalMutationResult,
  failure: OrchestratorMcpFailure,
  dependencies,
}).annotate(Tool.Destructive, true);

const GoalPauseTool = Tool.make("dak_goal_pause", {
  description:
    "Pause a goal after the current turn. A goal that is waiting for an answer cannot be paused; answer it first.",
  parameters: GoalPauseInput,
  success: GoalMutationResult,
  failure: OrchestratorMcpFailure,
  dependencies,
}).annotate(Tool.Destructive, true);

const GoalResumeTool = Tool.make("dak_goal_resume", {
  description:
    "Resume a paused, blocked, or failed goal and continue from the same plan. A goal that is waiting for an answer cannot be resumed; answer it first.",
  parameters: GoalResumeInput,
  success: GoalMutationResult,
  failure: OrchestratorMcpFailure,
  dependencies,
}).annotate(Tool.Destructive, true);

const GoalCancelTool = Tool.make("dak_goal_cancel", {
  description:
    "Cancel a goal for good. A cancelled goal cannot be resumed, so start a new goal if the work returns.",
  parameters: GoalCancelInput,
  success: GoalMutationResult,
  failure: OrchestratorMcpFailure,
  dependencies,
}).annotate(Tool.Destructive, true);

const GoalAnswerTool = Tool.make("dak_goal_answer", {
  description:
    "Answer the agent's current goal question. The affected task resumes where it stopped and the goal keeps working. Use this, not pause or resume, when a goal is waiting for an answer.",
  parameters: GoalAnswerInput,
  success: GoalMutationResult,
  failure: OrchestratorMcpFailure,
  dependencies,
}).annotate(Tool.Destructive, true);

const GoalRetryTaskTool = Tool.make("dak_goal_retry_task", {
  description:
    "Retry one task that could not finish without restarting the whole goal. The task is put back in the plan with a fresh recovery budget and the driver continues.",
  parameters: GoalRetryTaskInput,
  success: GoalMutationResult,
  failure: OrchestratorMcpFailure,
  dependencies,
}).annotate(Tool.Destructive, true);

export const GoalToolkit = Toolkit.make(
  GoalListTool,
  GoalReadTool,
  GoalCreateTool,
  GoalUpdateTool,
  GoalPauseTool,
  GoalResumeTool,
  GoalCancelTool,
  GoalAnswerTool,
  GoalRetryTaskTool,
);
