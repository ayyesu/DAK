import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import type {
  Goal,
  GoalCreateInput,
  GoalListResult,
  GoalSummary,
  ModelSelection,
  OrchestrationV2ThreadProjection,
  ProjectId,
  RunId,
} from "@dak/contracts";
import { GoalError, GoalId, ThreadId } from "@dak/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GoalService from "./GoalService.ts";

/**
 * The recovery behaviour of Goal Mode: an obstacle is worked through, an
 * exhausted budget becomes a reassessment, and only an evidence-backed
 * assessment ends the work.
 */

const projectId = "project-goals" as ProjectId;
const modelSelection = { instanceId: "codex", model: "gpt-5.4" } as ModelSelection;

const createInput = (overrides: Partial<GoalCreateInput> = {}): GoalCreateInput => ({
  projectId,
  objective: "Ship the notification settings page",
  modelSelection,
  runtimeMode: "auto",
  interactionMode: "default",
  ...overrides,
});

type TurnStep =
  | { readonly kind: "completed"; readonly reply: string | null }
  | {
      readonly kind: "run";
      readonly status: "interrupted" | "failed" | "cancelled" | "rolled_back";
    }
  | { readonly kind: "timeout" };

interface GoalScript {
  readonly steps: Array<TurnStep>;
  readonly stepsByRun: Map<string, TurnStep>;
  readonly sentTexts: Array<string>;
  readonly messages: Array<{
    readonly role: string;
    readonly runId: string;
    readonly text: string;
    readonly createdAt: DateTime.DateTime;
  }>;
  waitCount: number;
  runSeq: number;
  nextRunId: () => RunId;
  assign: (runId: string, step: TurnStep) => void;
}

function makeScript(steps: ReadonlyArray<TurnStep>): GoalScript {
  const script: GoalScript = {
    steps: [...steps],
    stepsByRun: new Map(),
    sentTexts: [],
    messages: [],
    waitCount: 0,
    runSeq: 0,
    nextRunId: () => {
      script.runSeq += 1;
      return `run:${script.runSeq}` as RunId;
    },
    assign: (runId, step) => {
      script.stepsByRun.set(runId, step);
      if (step.kind === "completed" && step.reply !== null) {
        script.messages.push({
          role: "assistant",
          runId,
          text: step.reply,
          createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        });
      }
    },
  };
  return script;
}

const takeStep = (script: GoalScript, where: string): TurnStep => {
  const step = script.steps.shift();
  if (step === undefined) {
    throw new Error(`Goal test script ran out of steps at ${where}`);
  }
  return step;
};

const scriptedDependencies = (script: GoalScript) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          script.sentTexts.push(input.initialMessage?.text ?? "");
          const step = takeStep(script, "launch");
          const runId = script.nextRunId();
          script.assign(runId, step);
          return {
            threadId: ThreadId.make("thread:1"),
            projection: { runs: [{ id: runId, ordinal: 1, status: "running" }] },
            resumed: false,
          } as unknown as ThreadLaunchService.ThreadLaunchResult;
        }),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.gen(function* () {
          script.sentTexts.push(input.text);
          const step = takeStep(script, "send");
          const runId = script.nextRunId();
          script.assign(runId, step);
          return {
            run: { id: runId, ordinal: 1, status: "running" },
          } as unknown as ThreadManagementService.ThreadManagementSendResult;
        }),
      waitForThread: (input) =>
        Effect.gen(function* () {
          script.waitCount += 1;
          const runId = String(input.runId);
          const step = script.stepsByRun.get(runId);
          if (step === undefined) {
            throw new Error(`Goal test script has no step for ${runId}`);
          }
          if (step.kind === "timeout") {
            return {
              threadId: input.threadId,
              run: { id: runId, status: "running" },
              timedOut: true,
            } as unknown as ThreadManagementService.ThreadManagementWaitResult;
          }
          const status = step.kind === "completed" ? "completed" : step.status;
          return {
            threadId: input.threadId,
            run: { id: runId, status },
            timedOut: false,
          } as unknown as ThreadManagementService.ThreadManagementWaitResult;
        }),
      getThreadProjection: () =>
        Effect.succeed({
          messages: script.messages,
        } as unknown as OrchestrationV2ThreadProjection),
      interruptThread: () => Effect.succeed({ type: "no_active_run" as const }),
    }),
  );

const scriptedLayer = (script: GoalScript) =>
  Layer.provideMerge(
    GoalService.layer.pipe(Layer.provide(scriptedDependencies(script))),
    SqlitePersistence.layerMemory,
  );

const awaitGoalState = (
  stream: Stream.Stream<GoalListResult, GoalError>,
  goalId: Goal["id"],
  predicate: (goal: GoalSummary) => boolean,
): Effect.Effect<GoalSummary, GoalError> =>
  stream
    .pipe(
      Stream.filterMap((list) => {
        const goal = list.goals.find((candidate) => candidate.id === goalId);
        return goal !== undefined && predicate(goal) ? Result.succeed(goal) : Result.failVoid;
      }),
      Stream.runHead,
    )
    .pipe(
      Effect.map(Option.getOrNull),
      Effect.flatMap((goal) =>
        goal === null
          ? Effect.fail(new GoalError({ message: "Goal never reached the awaited state." }))
          : Effect.succeed(goal),
      ),
    );

const report = (body: Record<string, unknown>): string =>
  `\`\`\`goal\n${JSON.stringify({ goal_report: body })}\n\`\`\``;

const planReport = report({
  status: "running",
  summary: "Planned one step",
  plan: [{ title: "Do the thing", detail: null }],
});

/** A build that failed; the agent reports it as an obstacle, not a dead end. */
const buildFailedReport = report({
  status: "running",
  summary: "The build failed",
  tasks: [
    {
      title: "Do the thing",
      status: "failed",
      evidence: "Type error: Property 'x' does not exist on type 'Y'",
    },
  ],
});

/** The agent worked the failure out and the build passes now. */
const buildFixedReport = report({
  status: "completed",
  summary: "Fixed the type and the build passes",
  tasks: [{ title: "Do the thing", status: "completed", evidence: "npm run build passed" }],
});

const verifyReport = report({
  status: "completed",
  verified: true,
  summary: "All criteria met",
  acceptance: [
    {
      criterion: "Each channel persists after reload",
      met: true,
      evidence: "reload test passed",
    },
  ],
});

/** A deadlock with the evidence the server requires before it may block. */
const blockedReport = report({
  status: "blocked",
  summary: "The sandbox has no network access",
  blocker: {
    reason: "the sandbox has no network access",
    rootCause: "outbound connections are blocked by the sandbox",
    investigation: "a curl to the package registry timed out",
    attempts: ["retried the install with the same command"],
    alternatives: ["vendoring the dependency by hand"],
    intervention: "network access has to be enabled for the environment",
    otherTasksCanContinue: false,
  },
});

/** A blocked claim with no evidence behind it. */
const vagueBlockedReport = report({
  status: "blocked",
  summary: "Something went wrong",
});

/** The agent needs a credential it cannot get itself. */
const needsCredentialReport = report({
  status: "needs_input",
  summary: "The API key is not available",
  input: {
    question: "Which API key should I use for the staging deploy?",
    reason: "the staging account uses a different key",
    attempted: "read the deployment config, which holds a placeholder",
    recommendation: "use the staging key from the vault",
  },
});

it.effect("a build failure recovers instead of blocking the goal", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: buildFailedReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    const done = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    expect(done.status).toBe("completed");
    // Nothing asked the user: the build failure was worked through.
    expect(done.question).toBeNull();
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a failed test leads to an investigation and a correction", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: buildFailedReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );

    // The follow-up turn carries the failure and leaves the choice to the
    // agent, so it works the problem out rather than repeating the failure.
    const recovery = script.sentTexts.find((text) => text.includes("You decide how to continue"));
    assert.isDefined(recovery);
    expect(recovery).toContain("Property 'x' does not exist");
    expect(recovery).toContain("Do not repeat the same failing operation unchanged");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("the agent recovers and the goal continues on its own", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: buildFailedReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    const done = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    expect(done.completedTaskCount).toBe(1);
    // The whole recovery ran without the user doing anything.
    expect(script.sentTexts).toHaveLength(4);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("an agent that calls an obstacle a deadlock keeps working it", () => {
  // Far past any budget a server could keep: the agent is told what is known
  // and decides. Calling the problem a deadlock does not end the goal, so
  // the assessment becomes the next turn's context instead.
  const failures = Array.from({ length: 8 }, () => ({
    kind: "completed" as const,
    reply: buildFailedReport,
  }));
  const script = makeScript([
    { kind: "completed", reply: planReport },
    ...failures,
    { kind: "completed", reply: blockedReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const done = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    expect(done.failureReason).toBeNull();
    expect(done.waitingReason).toBeNull();

    // The assessment rides on the task and the next turn starts from it.
    const full = yield* service.get({ id: created.goal.id });
    const assessed = full.goal.tasks.find((task) => task.title === "Do the thing");
    expect(assessed?.blocker?.reason).toBe("the sandbox has no network access");
    const followUp = script.sentTexts.find((text) =>
      text.includes("the sandbox has no network access"),
    );
    assert.isDefined(followUp);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a report that asks to be blocked is an obstacle like any other", () => {
  const failures = Array.from({ length: 5 }, () => ({
    kind: "completed" as const,
    reply: buildFailedReport,
  }));
  const script = makeScript([
    { kind: "completed", reply: planReport },
    ...failures,
    { kind: "completed", reply: vagueBlockedReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    // The goal keeps recovering instead of stopping on a shrug.
    const recovered = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "recovering" || goal.status === "running",
    );
    expect(recovered.status).not.toBe("failed");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a missing credential asks the user instead of failing", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: needsCredentialReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const asking = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    expect(asking.question).toBe("Which API key should I use for the staging deploy?");

    const full = yield* service.get({ id: created.goal.id });
    const task = full.goal.tasks[0];
    expect(task?.status).toBe("waiting_input");
    expect(task?.question).toBe("Which API key should I use for the staging deploy?");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("the user's answer resumes the affected task and the goal carries on", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: needsCredentialReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    yield* service.answer({ id: created.goal.id, text: "Use the staging key." });

    const done = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    expect(done.completedTaskCount).toBe(1);

    // The answer turn carried the question and the answer, so the agent
    // resumed exactly where it stopped.
    const answerTurn = script.sentTexts.find((text) => text.includes("The user answered"));
    assert.isDefined(answerTurn);
    expect(answerTurn).toContain("Which API key should I use for the staging deploy?");
    expect(answerTurn).toContain("Use the staging key.");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a task that is stuck does not stop independent tasks", () => {
  const script = makeScript([
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "Planned two steps",
        plan: [
          { title: "First", detail: null },
          { title: "Second", detail: null },
        ],
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "First is stuck",
        tasks: [{ title: "First", status: "failed", evidence: "the first build is broken" }],
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "Second finished",
        tasks: [{ title: "Second", status: "completed", evidence: "tests passed" }],
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "First is still stuck",
        tasks: [{ title: "First", status: "failed", evidence: "the first build is broken" }],
      }),
    },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    // The second task still gets worked on while the first is in recovery.
    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.completedTaskCount === 1,
    );
    const full = yield* service.get({ id: created.goal.id });
    const second = full.goal.tasks.find((task) => task.title === "Second");
    expect(second?.status).toBe("completed");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("the goal keeps working while a question is open", () => {
  const script = makeScript([
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "Planned two steps",
        plan: [
          { title: "First", detail: null },
          { title: "Second", detail: null },
        ],
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "needs_input",
        summary: "First needs a credential",
        input: { question: "Which credential do I use?", reason: "two accounts" },
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "Second finished",
        tasks: [{ title: "Second", status: "completed", evidence: "tests passed" }],
      }),
    },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    // The second task runs even though the first asked a question.
    const progressed = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.completedTaskCount === 1,
    );
    expect(progressed.question).toBe("Which credential do I use?");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("the goal keeps executing later tasks without user interaction", () => {
  const script = makeScript([
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "Planned three steps",
        plan: [
          { title: "First", detail: null },
          { title: "Second", detail: null },
          { title: "Third", detail: null },
        ],
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "First finished",
        tasks: [{ title: "First", status: "completed", evidence: "tests passed" }],
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "Second finished",
        tasks: [{ title: "Second", status: "completed", evidence: "tests passed" }],
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "Third finished",
        tasks: [{ title: "Third", status: "completed", evidence: "tests passed" }],
      }),
    },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    const done = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    expect(done.completedTaskCount).toBe(3);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("completed work is not repeated when the goal resumes", () => {
  const script = makeScript([
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "Planned two steps",
        plan: [
          { title: "First", detail: null },
          { title: "Second", detail: null },
        ],
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "First finished",
        tasks: [{ title: "First", status: "completed", evidence: "tests passed" }],
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "needs_input",
        summary: "Second needs a credential",
        input: { question: "Which credential do I use?", reason: "two accounts" },
      }),
    },
    {
      kind: "completed",
      reply: report({
        status: "running",
        summary: "Second finished",
        tasks: [{ title: "Second", status: "completed", evidence: "tests passed" }],
      }),
    },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    yield* service.answer({ id: created.goal.id, text: "Use the second account." });

    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );

    // The first task is never worked on again.
    const firstTurns = script.sentTexts.filter((text) => text.includes('"First"'));
    expect(firstTurns).toHaveLength(1);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a turn that never completes is recovered from rather than blocking", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "timeout" },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    const done = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    expect(done.status).toBe("completed");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a goal whose driver died is picked back up", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* GoalService.GoalService;
    const goalId = GoalId.make("goal:pick-up");
    const at = "2026-01-01T00:00:00.000Z";
    yield* sql`
      INSERT INTO goals (
        goal_id, project_id, thread_id, title, objective, acceptance_criteria_json, status,
        current_task_id, model_selection_json, runtime_mode, interaction_mode,
        workspace_strategy_json, revision, cycle_count, verification_json, blocked_reason,
        failure_reason, pending_edit, pending_answer, created_by,
        creation_source, created_at, updated_at, started_at, turn_started_at,
        completed_at, last_activity_at
      ) VALUES (
        ${goalId}, ${projectId}, NULL, 'Seeded goal', 'Objective', '[]', 'running',
        NULL, ${JSON.stringify(modelSelection)}, 'auto', 'default',
        '{"type":"root"}', 1, 0, '{"status":"pending","summary":null,"checkedAt":null}',
        NULL, NULL, 0, NULL, 'user', 'web', ${at}, ${at}, ${at}, NULL, NULL, ${at}
      )
    `;

    // The goal is driven but nobody is driving it.
    yield* TestClock.adjust("15 seconds");
    const picked = yield* awaitGoalState(
      service.subscribeList({}),
      goalId,
      (goal) => goal.status === "failed",
    );
    expect(picked.status).toBe("failed");
    // The goal was picked up and driven, not left stranded.
    const full = yield* service.get({ id: goalId });
    expect(full.goal.activities.map((activity) => activity.summary)).toContain(
      "Resumed after a server restart",
    );
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("the goal's progress survives an interrupted session", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* GoalService.GoalService;
    const goalId = GoalId.make("goal:interrupted");
    const at = "2026-01-01T00:00:00.000Z";
    yield* sql`
      INSERT INTO goals (
        goal_id, project_id, thread_id, title, objective, acceptance_criteria_json, status,
        current_task_id, model_selection_json, runtime_mode, interaction_mode,
        workspace_strategy_json, revision, cycle_count, verification_json, blocked_reason,
        failure_reason, pending_edit, pending_answer, created_by,
        creation_source, created_at, updated_at, started_at, turn_started_at,
        completed_at, last_activity_at
      ) VALUES (
        ${goalId}, ${projectId}, NULL, 'Seeded goal', 'Objective', '[]', 'running',
        NULL, ${JSON.stringify(modelSelection)}, 'auto', 'default',
        '{"type":"root"}', 1, 0, '{"status":"pending","summary":null,"checkedAt":null}',
        NULL, NULL, 0, NULL, 'user', 'web', ${at}, ${at}, ${at}, NULL, NULL, ${at}
      )
    `;
    yield* sql`
      INSERT INTO goal_tasks (
        goal_id, task_id, title, detail, status, task_order, started_at, completed_at,
        evidence, question, attempts, recovery_attempts, reassessments, depends_on_json
      ) VALUES (
        ${goalId}, 'task:seeded', 'Do the thing', NULL, 'recovering', 0, ${at}, NULL,
        'the build failed', NULL, 2, 1, 0, '[]'
      )
    `;

    yield* TestClock.adjust("15 seconds");
    const done = yield* awaitGoalState(
      service.subscribeList({}),
      goalId,
      (goal) => goal.status === "completed",
    );
    expect(done.completedTaskCount).toBe(1);

    // The stored recovery budget was what the next turn used, and the task
    // finished, so the budget is cleared again.
    const loaded = yield* service.get({ id: goalId });
    expect(loaded.goal.tasks[0]?.status).toBe("completed");
    // The two attempts it had before the restart, plus the recovery turn and
    // the turn that finished it.
    expect(loaded.goal.tasks[0]?.attempts).toBe(4);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a goal that asks to be blocked keeps working instead", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: vagueBlockedReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    const done = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.waitingReason).toBeNull();
    expect(done.status).toBe("completed");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a completed goal records the verification behind it", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.verification.status).toBe("passed");
    expect(full.goal.verification.criteria).toEqual([
      { criterion: "Each channel persists after reload", met: true, proof: [] },
    ]);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("the goal's activity log explains what it is doing", () => {
  const script = makeScript([
    { kind: "completed", reply: planReport },
    { kind: "completed", reply: buildFailedReport },
    { kind: "completed", reply: buildFixedReport },
    { kind: "completed", reply: verifyReport },
  ]);
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    const full = yield* service.get({ id: created.goal.id });
    const summaries = full.goal.activities.map((activity) => activity.summary);
    expect(summaries).toContain("Working on: Do the thing");
    expect(summaries).toContain("Recovering: Do the thing");
    expect(summaries).toContain("Completed: Do the thing");
  }).pipe(Effect.provide(scriptedLayer(script)));
});
