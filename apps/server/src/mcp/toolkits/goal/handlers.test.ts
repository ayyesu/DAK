import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GoalId,
  type Project as ProjectRecord,
  ProviderInstanceId,
  ThreadId,
  type Goal,
  type GoalCreateInput,
  type GoalSummary,
} from "@dak/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as GoalService from "../../../goals/GoalService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as GoalHandlers from "./handlers.ts";
import { GoalToolkit } from "./tools.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

it.effect("creates and manages a goal through MCP", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("mcp-goal-thread");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = liveThreadShell(sourceThreadId);
    const projectId = caller.projectId;
    const goalId = GoalId.make("goal:mcp");
    const createdInputs: Array<GoalCreateInput> = [];
    const paused: Array<string> = [];
    const goal = {
      id: goalId,
      projectId,
      threadId: sourceThreadId,
      title: "Test goal",
      objective: "Ship it",
      acceptanceCriteria: [],
      status: "planning",
      tasks: [],
      activities: [],
      currentTaskId: null,
      modelSelection: caller.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      revision: 1,
      cycleCount: 0,
      verification: { status: "pending", summary: null, checkedAt: null },
      blockedReason: null,
      failureReason: null,
      progress: null,
      progressLabel: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      turnStartedAt: null,
      completedAt: null,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      createdBy: "agent",
      creationSource: "mcp",
    } as unknown as Goal;
    const summary = {
      id: goalId,
      projectId,
      threadId: sourceThreadId,
      title: "Test goal",
      status: "planning",
      currentTaskId: null,
      currentTaskTitle: null,
      completedTaskCount: 0,
      totalTaskCount: 0,
      turnStartedAt: null,
      blockedReason: null,
      failureReason: null,
      progress: null,
      progressLabel: null,
      updatedAt: goal.updatedAt,
      lastActivityAt: goal.updatedAt,
      completedAt: null,
    } as GoalSummary;

    const layerDependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(GoalService.GoalService)({
        list: (input) =>
          Effect.succeed({
            goals: input.projectId === projectId ? [summary] : [],
          }),
        get: () => Effect.succeed({ goal }),
        create: (input) =>
          Effect.sync(() => {
            createdInputs.push(input);
            return { goal };
          }),
        pause: (input) =>
          Effect.sync(() => {
            paused.push(input.id);
            return { goal };
          }),
      }),
      Layer.mock(Project.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({
                  id,
                  deletedAt: null,
                  defaultModelSelection: null,
                } as unknown as ProjectRecord)
              : Option.none(),
          ),
      }),
    );

    const toolkit = yield* GoalToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(GoalHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );

    const call = <Name extends keyof typeof GoalToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit
        .handle(name, params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    const created = (yield* call("dak_goal_create", { objective: "Ship it", projectId })).at(-1)!;
    expect(created.result).toMatchObject({ goal: { id: goalId, status: "planning" } });
    expect(createdInputs).toEqual([
      expect.objectContaining({
        projectId,
        objective: "Ship it",
        modelSelection: caller.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      }),
    ]);

    const listed = (yield* call("dak_goal_list", { projectId })).at(-1)!;
    expect(
      (listed.result as Tool.Success<(typeof GoalToolkit.tools)["dak_goal_list"]>).goals,
    ).toEqual([summary]);

    const read = (yield* call("dak_goal_read", { id: goalId })).at(-1)!;
    expect((read.result as Tool.Success<(typeof GoalToolkit.tools)["dak_goal_read"]>).goal.id).toBe(
      goalId,
    );

    const pausedResult = (yield* call("dak_goal_pause", { id: goalId })).at(-1)!;
    expect(
      (pausedResult.result as Tool.Success<(typeof GoalToolkit.tools)["dak_goal_pause"]>).goal.id,
    ).toBe(goalId);
    expect(paused).toEqual([goalId]);
  }),
);
