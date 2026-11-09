import { GoalError, OrchestratorMcpFailure } from "@dak/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GoalService from "../../../goals/GoalService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { GoalToolkit } from "./tools.ts";

function goalFailure(error: GoalError): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({
    code: "invalid_request",
    message: error.message,
  });
}

function mutation<A>(
  effect: Effect.Effect<A, GoalError>,
): Effect.Effect<A, OrchestratorMcpFailure> {
  return effect.pipe(Effect.mapError(goalFailure));
}

const make = Effect.gen(function* () {
  const goals = yield* GoalService.GoalService;
  return {
    dak_goal_list: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        yield* readCaller();
        return yield* mutation(goals.list(input));
      }),
    ),
    dak_goal_read: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        yield* readCaller();
        return yield* mutation(goals.get(input));
      }),
    ),
    dak_goal_create: McpToolAccess.startsThreads(
      (input) => ({
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
      }),
      (input, modes) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, input.projectId);
          const projects = yield* ProjectService.ProjectService;
          const project = yield* projects
            .getById(projectId)
            .pipe(Effect.mapError(unavailable), Effect.map(Option.getOrUndefined));
          if (project === undefined || project.deletedAt !== null) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          }
          const modelSelection =
            input.modelSelection ??
            context.caller?.modelSelection ??
            project.defaultModelSelection ??
            null;
          if (modelSelection === null) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
            });
          }
          return yield* mutation(
            goals.create({
              projectId,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              objective: input.objective,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.acceptanceCriteria === undefined
                ? {}
                : { acceptanceCriteria: input.acceptanceCriteria }),
              modelSelection,
              runtimeMode: modes.runtimeMode,
              interactionMode: modes.interactionMode,
              ...(input.workspaceStrategy === undefined
                ? {}
                : { workspaceStrategy: input.workspaceStrategy }),
              createdBy: "agent",
              creationSource: "mcp",
            }),
          );
        }),
    ),
    dak_goal_update: McpToolAccess.writes((input) => mutation(goals.update(input))),
    dak_goal_pause: McpToolAccess.writes((input) => mutation(goals.pause(input))),
    dak_goal_resume: McpToolAccess.writes((input) => mutation(goals.resume(input))),
    dak_goal_cancel: McpToolAccess.writes((input) => mutation(goals.cancel(input))),
    dak_goal_answer: McpToolAccess.writes((input) => mutation(goals.answer(input))),
    dak_goal_retry_task: McpToolAccess.writes((input) => mutation(goals.retryTask(input))),
  } satisfies McpToolAccess.Handlers<typeof GoalToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(GoalToolkit, make);
