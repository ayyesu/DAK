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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GoalService from "./GoalService.ts";

const projectId = "project-goals" as ProjectId;
const modelSelection = { instanceId: "codex", model: "gpt-5.4" } as ModelSelection;

// A launch that never resolves keeps the execution loop parked at its first
// turn, so these tests observe only the user-facing state machine.
const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({ launch: () => Effect.never }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
);

// One build scope for the service and its database: the memory SQLite feeds
// GoalService's SqlClient requirement and stays visible to tests that query it.
const layer = Layer.provideMerge(
  GoalService.layer.pipe(Layer.provide(dependencies)),
  SqlitePersistence.layerMemory,
);

const createInput = (overrides: Partial<GoalCreateInput> = {}): GoalCreateInput => ({
  projectId,
  objective: "Ship the notification settings page",
  modelSelection,
  runtimeMode: "auto",
  interactionMode: "default",
  ...overrides,
});

// --- Scripted turn harness -------------------------------------------------
//
// Each dispatched run consumes one scripted step: what `waitForThread` reports
// and which assistant text the projection carries. A gate holds one wait so a
// test can mutate the goal while a turn is provably in flight.

interface Gate {
  readonly reached: Promise<void>;
  readonly open: Promise<void>;
  readonly signal: () => void;
  readonly release: () => void;
}

function makeGate(): Gate {
  let signal!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, open, signal, release };
}

type TurnStep =
  | { readonly kind: "completed"; readonly reply: string | null }
  | {
      readonly kind: "run";
      readonly status: "interrupted" | "failed" | "cancelled" | "rolled_back";
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "waitError"; readonly error: "thread" | "run" | "archived" };

interface ScriptOptions {
  readonly steps?: ReadonlyArray<TurnStep>;
  readonly holdWaitAt?: number;
  readonly gate?: Gate;
  readonly launchMode?: "script" | "never" | "noRun";
  readonly launchGate?: { readonly at: number; readonly gate: Gate };
  readonly failNextSendWith?: "thread" | "archived";
}

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
  readonly holdWaitAt: number | null;
  readonly gate: Gate | null;
  readonly launchMode: "script" | "never" | "noRun";
  readonly launchGate: { readonly at: number; readonly gate: Gate } | null;
  failNextSendWith: "thread" | "archived" | null;
  waitCount: number;
  launchCount: number;
  runSeq: number;
  nextRunId: () => RunId;
  assign: (runId: string, step: TurnStep) => void;
}

function makeScript(options: ScriptOptions = {}): GoalScript {
  const script: GoalScript = {
    steps: [...(options.steps ?? [])],
    stepsByRun: new Map(),
    sentTexts: [],
    messages: [],
    holdWaitAt: options.holdWaitAt ?? null,
    gate: options.gate ?? null,
    launchMode: options.launchMode ?? "script",
    launchGate: options.launchGate ?? null,
    failNextSendWith: options.failNextSendWith ?? null,
    waitCount: 0,
    launchCount: 0,
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

const report = (body: Record<string, unknown>): string =>
  `\`\`\`goal\n${JSON.stringify({ goal_report: body })}\n\`\`\``;

const planReport = report({
  status: "running",
  summary: "Planned one step",
  plan: [{ title: "Do the thing", detail: null }],
});
const needsInputReport = report({
  status: "needs_input",
  summary: "Need one detail",
  question: "Which provider should it use?",
});
const taskDoneReport = report({
  status: "completed",
  summary: "Finished the step",
  tasks: [{ title: "Do the thing", status: "completed", evidence: "tests passed" }],
});
const answerProgressReport = report({
  status: "running",
  summary: "Used the email provider",
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
const taskFailedReport = report({
  status: "running",
  summary: "The port was already in use",
  tasks: [{ title: "Do the thing", status: "failed", evidence: "port 4000 already in use" }],
});
const twoTaskPlanReport = report({
  status: "running",
  summary: "Planned two steps",
  plan: [
    { title: "First", detail: null },
    { title: "Second", detail: null },
  ],
});
const firstFailedReport = report({
  status: "running",
  summary: "First could not start",
  tasks: [{ title: "First", status: "failed", evidence: "port 4000 already in use" }],
});
const secondDoneReport = report({
  status: "running",
  summary: "Second finished",
  tasks: [{ title: "Second", status: "completed", evidence: "tests passed" }],
});
const firstDoneReport = report({
  status: "running",
  summary: "First finished on the second attempt",
  tasks: [{ title: "First", status: "completed", evidence: "tests passed" }],
});
/** Claims a criterion is met without the command that proves it. */
const verifyWithoutEvidence = report({
  status: "completed",
  verified: true,
  summary: "Looks done to me",
  acceptance: [{ criterion: "Each channel persists after reload", met: true }],
});
const repairReport = report({
  status: "completed",
  summary: "Re-ran the reload check",
  tasks: [{ title: "Do the thing", status: "completed", evidence: "tests passed" }],
});

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
          script.launchCount += 1;
          if (script.launchGate !== null && script.launchCount === script.launchGate.at) {
            script.launchGate.gate.signal();
          }
          const threadId = ThreadId.make(`thread:${script.launchCount}`);
          if (script.launchMode === "never") return yield* Effect.never;
          if (script.launchMode === "noRun") {
            return {
              threadId,
              projection: { runs: [] },
              resumed: false,
            } as unknown as ThreadLaunchService.ThreadLaunchResult;
          }
          const step = takeStep(script, "launch");
          const runId = script.nextRunId();
          script.assign(runId, step);
          return {
            threadId,
            projection: { runs: [{ id: runId, ordinal: 1, status: "running" }] },
            resumed: false,
          } as unknown as ThreadLaunchService.ThreadLaunchResult;
        }),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.gen(function* () {
          script.sentTexts.push(input.text);
          if (script.failNextSendWith !== null) {
            const failure = script.failNextSendWith;
            script.failNextSendWith = null;
            if (failure === "thread") {
              return yield* Effect.fail(
                new ThreadManagementService.ThreadManagementThreadNotFoundError({
                  projectId: input.projectId,
                  threadId: input.threadId,
                }),
              );
            }
            return yield* Effect.fail(
              new ThreadManagementService.ThreadManagementThreadArchivedError({
                threadId: input.threadId,
              }),
            );
          }
          const step = takeStep(script, "send");
          const runId = script.nextRunId();
          script.assign(runId, step);
          return {
            run: { id: runId, ordinal: 1, status: "running" },
          } as unknown as ThreadManagementService.ThreadManagementSendResult;
        }),
      waitForThread: (input) =>
        Effect.gen(function* () {
          const index = script.waitCount;
          script.waitCount += 1;
          if (script.holdWaitAt === index && script.gate !== null) {
            script.gate.signal();
            yield* Effect.promise(() => script.gate?.open ?? Promise.resolve());
          }
          const runId = String(input.runId);
          const step = script.stepsByRun.get(runId);
          if (step === undefined) {
            throw new Error(`Goal test script has no step for ${runId}`);
          }
          if (step.kind === "waitError") {
            if (step.error === "thread") {
              return yield* Effect.fail(
                new ThreadManagementService.ThreadManagementThreadNotFoundError({
                  projectId: input.projectId,
                  threadId: input.threadId,
                }),
              );
            }
            if (step.error === "run") {
              return yield* Effect.fail(
                new ThreadManagementService.ThreadManagementRunNotFoundError({
                  threadId: input.threadId,
                  runId: input.runId ?? ("run:missing" as RunId),
                }),
              );
            }
            return yield* Effect.fail(
              new ThreadManagementService.ThreadManagementThreadArchivedError({
                threadId: input.threadId,
              }),
            );
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

/**
 * Resolves with the goal's first list emission where the predicate holds.
 * Event-driven: it waits on the goal subscription, never on a clock.
 */
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

// --- Plain state-machine tests --------------------------------------------

it.effect("creates a goal in planning and lists it by project", () =>
  Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());
    expect(created.goal.status).toBe("planning");
    expect(created.goal.tasks).toEqual([]);
    expect(created.goal.acceptanceCriteria).toEqual([]);
    expect(created.goal.activities.map((activity) => activity.kind)).toContain("created");

    const listed = yield* service.list({ projectId });
    expect(listed.goals.map((goal) => goal.id)).toEqual([created.goal.id]);

    const otherProject = yield* service.list({ projectId: "project-other" as ProjectId });
    expect(otherProject.goals).toEqual([]);

    const fetched = yield* service.get({ id: created.goal.id });
    expect(fetched.goal.objective).toBe("Ship the notification settings page");
  }).pipe(Effect.provide(layer)),
);

it.effect("pauses, resumes and cancels a goal, and refuses to revive a cancelled one", () =>
  Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const paused = yield* service.pause({ id: created.goal.id });
    expect(paused.goal.status).toBe("paused");
    // Pausing twice is a no-op, not an error.
    expect((yield* service.pause({ id: created.goal.id })).goal.status).toBe("paused");

    // A goal paused before it had a plan resumes into planning, not running.
    const resumed = yield* service.resume({ id: created.goal.id });
    expect(resumed.goal.status).toBe("planning");

    const cancelled = yield* service.cancel({ id: created.goal.id });
    expect(cancelled.goal.status).toBe("cancelled");

    const resumeFailure = yield* service.resume({ id: created.goal.id }).pipe(Effect.flip);
    expect(resumeFailure.message).toBe("This goal has ended. Start a new goal instead.");

    const updateFailure = yield* service
      .update({ id: created.goal.id, objective: "Something else" })
      .pipe(Effect.flip);
    expect(updateFailure.message).toBe("This goal has ended. Start a new goal for further work.");
  }).pipe(Effect.provide(layer)),
);

it.effect("editing a goal bumps the revision and appends extra requirements", () =>
  Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());
    yield* service.pause({ id: created.goal.id });

    const updated = yield* service.update({
      id: created.goal.id,
      additionalRequirements: "Keep the existing email preference untouched.",
    });
    expect(updated.goal.revision).toBe(2);
    expect(updated.goal.objective).toContain("Keep the existing email preference untouched.");
    // An edit never resumes: the paused status is preserved, and Resume (or
    // Save & resume) restarts the work deliberately.
    expect(updated.goal.status).toBe("paused");
    expect(updated.goal.activities.map((activity) => activity.kind)).toContain("user");

    const replaced = yield* service.update({
      id: created.goal.id,
      objective: "Ship a per-channel notification page",
      acceptanceCriteria: ["Each channel persists after reload"],
    });
    expect(replaced.goal.objective).toBe("Ship a per-channel notification page");
    expect(replaced.goal.acceptanceCriteria).toEqual(["Each channel persists after reload"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("only accepts an answer while the goal is waiting for one", () =>
  Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const failure = yield* service
      .answer({ id: created.goal.id, text: "Use the email provider." })
      .pipe(Effect.flip);
    expect(failure.message).toBe("This goal is not waiting for an answer.");
  }).pipe(Effect.provide(layer)),
);

it.effect("retries a failed task without touching the completed ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());
    yield* service.pause({ id: created.goal.id });

    yield* sql`
      INSERT INTO goal_tasks (goal_id, task_id, title, detail, status, task_order, attempts)
      VALUES
        (${created.goal.id}, 'task:done', 'Inspect the page', NULL, 'completed', 0, 1),
        (${created.goal.id}, 'task:failed', 'Add the toggle', NULL, 'failed', 1, 1)
    `;

    const retried = yield* service.retryTask({
      id: created.goal.id,
      taskId: "task:failed",
    });
    const done = retried.goal.tasks.find((task) => task.id === "task:done");
    const failed = retried.goal.tasks.find((task) => task.id === "task:failed");
    expect(done?.status).toBe("completed");
    expect(failed?.status).toBe("pending");
    expect(retried.goal.status).toBe("paused");

    const unknown = yield* service
      .retryTask({ id: created.goal.id, taskId: "task:missing" })
      .pipe(Effect.flip);
    expect(unknown.message).toBe("Task not found in this goal.");
  }).pipe(Effect.provide(layer)),
);

it.effect("streams a snapshot and then a fresh list after a change", () =>
  Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const first = Option.getOrNull(yield* Stream.runHead(service.subscribeList({ projectId })));
    assert.isNotNull(first);
    expect(first.goals).toEqual([]);

    const created = yield* service.create(createInput());
    const snapshot = yield* service.list({ projectId });
    expect(snapshot.goals[0]?.id).toBe(created.goal.id);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps multiple goals and updates the newest first", () =>
  Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const first = yield* service.create(createInput({ objective: "First outcome" }));
    const second = yield* service.create(createInput({ objective: "Second outcome" }));
    // Listings order by updated_at, which has millisecond resolution.
    yield* TestClock.adjust("5 millis");
    const listed = yield* service.list({ projectId });
    expect(listed.goals).toHaveLength(2);
    expect(listed.goals.map((goal) => goal.id)).toContain(first.goal.id);
    expect(listed.goals.map((goal) => goal.id)).toContain(second.goal.id);

    yield* service.pause({ id: first.goal.id });
    const afterPause = yield* service.list({ projectId });
    expect(afterPause.goals[0]?.id).toBe(first.goal.id);
  }).pipe(Effect.provide(layer)),
);

// --- Turn-loop behavior ----------------------------------------------------

it.effect("an edit during planning keeps the goal in planning, not running", () =>
  Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());
    // The driver is parked in its first launch; the edit must not depend on a
    // turn having produced anything.
    const updated = yield* service.update({
      id: created.goal.id,
      objective: "Ship a per-channel notification page",
    });
    expect(updated.goal.status).toBe("planning");
    expect(updated.goal.revision).toBe(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("an edit that interrupts a running turn re-dispatches as an edit turn", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "run", status: "interrupted" },
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: needsInputReport },
    ],
    holdWaitAt: 0,
    gate,
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    // The first turn is now provably in flight; edit the goal underneath it.
    yield* Effect.promise(() => gate.reached);
    const updated = yield* service.update({
      id: created.goal.id,
      objective: "Ship it faster",
    });
    expect(updated.goal.revision).toBe(2);
    gate.release();

    const final = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.revision).toBe(2);
    expect(full.goal.tasks).toHaveLength(1);
    expect(final.blockedReason).toBe("Which provider should it use?");
    // Plan prompt, then the edit prompt with the new objective, then the task.
    expect(script.sentTexts).toHaveLength(3);
    expect(script.sentTexts[1]).toContain("Ship it faster");
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("editing a paused goal stays paused until the edit is resumed", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "run", status: "interrupted" },
      { kind: "completed", reply: needsInputReport },
    ],
    holdWaitAt: 1,
    gate,
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    // The first task turn is provably in flight, so the pause interrupts it.
    yield* Effect.promise(() => gate.reached);
    yield* service.pause({ id: created.goal.id });

    // The edit must keep the paused status instead of dragging the goal back
    // under the driver.
    const updated = yield* service.update({
      id: created.goal.id,
      objective: "Ship it faster",
    });
    expect(updated.goal.status).toBe("paused");
    expect(updated.goal.revision).toBe(2);
    gate.release();

    // Resuming runs the pending edit turn before the plan continues.
    yield* service.resume({ id: created.goal.id });
    const resumedSummary = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    expect(resumedSummary.blockedReason).toBe("Which provider should it use?");
    const resumed = yield* service.get({ id: created.goal.id });
    expect(resumed.goal.revision).toBe(2);
    expect(script.sentTexts).toHaveLength(3);
    expect(script.sentTexts[2]).toContain("Ship it faster");
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("a thread deleted mid-wait relaunches instead of failing the goal", () => {
  const script = makeScript({
    steps: [
      { kind: "waitError", error: "run" },
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: needsInputReport },
    ],
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const final = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    expect(final.threadId).toBe(ThreadId.make("thread:2"));
    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.activities.map((activity) => activity.summary)).toContain(
      "The goal's run was lost; starting a new thread",
    );
    expect(script.sentTexts).toHaveLength(3);
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("a turn in flight stamps turnStartedAt and heartbeats subscribers", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: needsInputReport },
    ],
    holdWaitAt: 0,
    gate,
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    // Wait until the first turn is provably in flight: the dispatch stamp is
    // written and the heartbeat fiber is sleeping on the test clock.
    yield* Effect.promise(() => gate.reached);
    // Subscribe from here so the snapshot proves the subscription is live
    // before the clock moves.
    const queue = yield* Queue.unbounded<GoalListResult>();
    const collector = yield* Effect.forkChild(
      service
        .subscribeList({ projectId })
        .pipe(Stream.runForEach((list) => Queue.offer(queue, list))),
    );
    const snapshot = yield* Queue.take(queue);
    expect(snapshot.goals[0]?.turnStartedAt).not.toBeNull();

    yield* TestClock.adjust(`${GoalService.GOAL_TURN_HEARTBEAT_MS} millis`);
    // Nothing writes to the goal while it waits, so this can only be the
    // heartbeat's re-notification.
    const heartbeat = yield* Queue.take(queue);
    expect(heartbeat.goals[0]?.turnStartedAt).not.toBeNull();

    // And it repeats on the interval itself: the next push lands one
    // heartbeat after the first, not two.
    yield* TestClock.adjust(`${GoalService.GOAL_TURN_HEARTBEAT_MS} millis`);
    const next = yield* Queue.take(queue);
    expect(next.goals[0]?.turnStartedAt).not.toBeNull();
    yield* Fiber.interrupt(collector);

    gate.release();
    const final = yield* awaitGoalState(
      service.subscribeList({ projectId }),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    // needs_input has no turn in flight, so the marker left with the status.
    expect(final.turnStartedAt).toBeNull();
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("a thread deleted at dispatch relaunches instead of stalling the goal", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: needsInputReport },
    ],
    failNextSendWith: "thread",
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const final = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    // The failed send cleared the dead thread; the retry launched a new one.
    expect(final.threadId).toBe(ThreadId.make("thread:2"));
    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.activities.map((activity) => activity.summary)).toContain(
      "The goal's thread was deleted; starting a new one",
    );
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("an archived thread blocks the goal with an actionable reason", () => {
  const script = makeScript({
    steps: [{ kind: "waitError", error: "archived" }],
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const final = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "blocked",
    );
    expect(final.threadId).toBeNull();
    expect(final.blockedReason).toContain("archived");
    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.activities.map((activity) => activity.summary)).toContain(
      "The goal's thread is archived",
    );
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("a failed run marks the goal failed, and resume recovers it", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "run", status: "failed" },
      { kind: "completed", reply: needsInputReport },
    ],
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const failed = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "failed",
    );
    expect(failed.failureReason).toBe("The provider turn failed.");

    const resumed = yield* service.resume({ id: created.goal.id });
    expect(resumed.goal.status).toBe("running");
    expect(resumed.goal.failureReason).toBeNull();

    const final = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    expect(final.failureReason).toBeNull();
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("a launch without a run still records the thread it created", () => {
  const script = makeScript({ launchMode: "noRun" });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const blocked = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "blocked",
    );
    expect(blocked.blockedReason).toBe("The thread launched without a run. Resume to try again.");
    // Without the thread recorded, Resume would launch a second thread and
    // abandon the one that already holds the goal's first turn.
    expect(blocked.threadId).toBe(ThreadId.make("thread:1"));
    const rows = yield* sql<{ thread_id: string | null }>`
      SELECT thread_id FROM goals WHERE goal_id = ${created.goal.id}
    `;
    expect(rows[0]?.thread_id).toBe("thread:1");
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("a pause during an answer turn keeps the answer until the turn completes", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: needsInputReport },
      { kind: "run", status: "interrupted" },
      { kind: "completed", reply: needsInputReport },
    ],
    holdWaitAt: 2,
    gate,
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    // Drive to needs_input: plan, then a task turn that asks a question.
    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    yield* service.answer({ id: created.goal.id, text: "Use the email provider." });

    // The answer turn is in flight; pause must not swallow the answer.
    yield* Effect.promise(() => gate.reached);
    yield* service.pause({ id: created.goal.id });
    const held = yield* sql<{ pending_answer: string | null }>`
      SELECT pending_answer FROM goals WHERE goal_id = ${created.goal.id}
    `;
    expect(held[0]?.pending_answer).toBe("Use the email provider.");
    gate.release();

    yield* service.resume({ id: created.goal.id });
    const final = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    // The resumed answer turn received the stored answer, then consumed it.
    expect(script.sentTexts[3]).toContain("The user answered: Use the email provider.");
    const consumed = yield* sql<{ pending_answer: string | null }>`
      SELECT pending_answer FROM goals WHERE goal_id = ${created.goal.id}
    `;
    expect(consumed[0]?.pending_answer).toBeNull();
    expect(final.blockedReason).toBe("Which provider should it use?");
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("a report after an answer turn resets the idle counter", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: null },
      { kind: "completed", reply: answerProgressReport },
      { kind: "completed", reply: null },
      { kind: "completed", reply: null },
    ],
    holdWaitAt: 1,
    gate,
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    // A reply normally arrives while no driver runs, but it can also race a
    // turn in flight, and the loop reads pendingAnswer every iteration. Stage
    // exactly that: a task turn reports nothing, then the answer turns up.
    yield* Effect.promise(() => gate.reached);
    yield* sql`
      UPDATE goals SET pending_answer = 'Use the email provider.'
      WHERE goal_id = ${created.goal.id}
    `;
    gate.release();

    // Fail, then a successful answer, then fail must not block: the report
    // resets the idle counter, so blocking still needs two no-report turns
    // after it. A lost reset blocks one turn early, at four sends instead of
    // the five this run dispatches.
    const blocked = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "blocked",
    );
    expect(blocked.blockedReason).toBe(
      "Two consecutive turns produced no progress report. Check the thread, then resume or edit the goal.",
    );
    expect(script.sentTexts).toHaveLength(5);
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("verification records per-criterion results on the goal", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: taskDoneReport },
      { kind: "completed", reply: verifyReport },
    ],
  });
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
      { criterion: "Each channel persists after reload", met: true },
    ]);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a failed task is retried automatically and the goal completes untouched", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: taskFailedReport },
      { kind: "completed", reply: taskDoneReport },
      { kind: "completed", reply: verifyReport },
    ],
  });
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
    // Plan, failed attempt, automatic retry, verification: no user turn.
    expect(script.sentTexts).toHaveLength(4);

    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.verification.status).toBe("passed");
    expect(full.goal.tasks[0]?.attempts).toBe(2);
    const requeued = full.goal.activities.find((activity) =>
      activity.summary.startsWith("Requeued 1 failed task"),
    );
    expect(requeued).toBeDefined();
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a failed task does not hold up independent pending work", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: twoTaskPlanReport },
      { kind: "completed", reply: firstFailedReport },
      { kind: "completed", reply: secondDoneReport },
      { kind: "completed", reply: firstDoneReport },
      { kind: "completed", reply: verifyReport },
    ],
  });
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

    const runs = script.sentTexts
      .map((text, index) => ({ text, index }))
      .filter(({ text }) => text.includes("Your task this turn:"));
    const firstRuns = runs.filter(({ text }) => text.includes(`"First"`));
    const secondRun = runs.find(({ text }) => text.includes(`"Second"`));
    expect(firstRuns).toHaveLength(2);
    assert.isDefined(secondRun);
    // The unstarted task runs between the two attempts at the failed one.
    expect(secondRun.index).toBeGreaterThan(firstRuns[0]!.index);
    expect(secondRun.index).toBeLessThan(firstRuns[1]!.index);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("a task that exhausts its automatic attempts stops the goal", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: taskFailedReport },
      { kind: "completed", reply: taskFailedReport },
      { kind: "completed", reply: taskFailedReport },
    ],
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    const stopped = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "blocked",
    );
    expect(stopped.blockedReason).toContain("Exhausted 3 attempts on: Do the thing.");
    expect(script.sentTexts).toHaveLength(4);

    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.tasks[0]?.attempts).toBe(3);
    expect(full.goal.tasks[0]?.status).toBe("failed");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("verification that claims a criterion without evidence repairs, then passes", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: taskDoneReport },
      { kind: "completed", reply: verifyWithoutEvidence },
      { kind: "completed", reply: repairReport },
      { kind: "completed", reply: verifyReport },
    ],
  });
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
    // The evidence-less verdict cost a repair turn instead of completing.
    expect(script.sentTexts).toHaveLength(5);

    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.verification.status).toBe("passed");
    expect(full.goal.verification.criteria).toEqual([
      { criterion: "Each channel persists after reload", met: true },
    ]);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("verification failure triggers repair instead of blocking", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: taskDoneReport },
      { kind: "completed", reply: verifyWithoutEvidence },
      { kind: "completed", reply: repairReport },
      { kind: "completed", reply: verifyReport },
    ],
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    // After verification failure, the goal goes back to running (repair),
    // not blocked. After repair + successful verification, it completes.
    const done = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    expect(done.completedTaskCount).toBe(1);

    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.verification.status).toBe("passed");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("pausing mid-turn pauses the goal and resuming finishes it", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: taskDoneReport },
      { kind: "completed", reply: taskDoneReport },
      { kind: "completed", reply: verifyReport },
      { kind: "completed", reply: verifyReport },
    ],
    holdWaitAt: 1,
    gate,
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    // The task turn is provably in flight: two sends, and the turn the pause
    // lands under has not come back yet. Pausing takes effect right now rather
    // than waiting for the turn, which is what lets a user hold a goal that is
    // already working.
    yield* Effect.promise(() => gate.reached);
    expect(script.sentTexts).toHaveLength(2);
    yield* service.pause({ id: created.goal.id });
    const held = yield* service.get({ id: created.goal.id });
    expect(held.goal.status).toBe("paused");
    expect(held.goal.turnStartedAt).toBeNull();

    // Releasing ends the held turn, and resuming picks the goal back up. The
    // loop finishes on its own whether that turn's report lands before or
    // after the resume, so either interleaving must reach the same end state.
    gate.release();
    yield* service.resume({ id: created.goal.id });
    const done = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    expect(done.completedTaskCount).toBe(1);
    // Plan, the held task turn, then the task/verification rounds each
    // interleaving needs: four when the paused turn was dropped, five when it
    // was applied and cost an extra repair round.
    expect(script.sentTexts.length).toBeGreaterThanOrEqual(4);
    expect(script.sentTexts.length).toBeLessThanOrEqual(5);

    const full = yield* service.get({ id: created.goal.id });
    expect(full.goal.verification.status).toBe("passed");
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("cancelling during automatic execution stops the loop", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: taskDoneReport },
    ],
    holdWaitAt: 1,
    gate,
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    yield* Effect.promise(() => gate.reached);
    yield* service.cancel({ id: created.goal.id });
    gate.release();

    const cancelled = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "cancelled",
    );
    expect(cancelled.status).toBe("cancelled");
    expect(script.sentTexts).toHaveLength(2);
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("resuming a driven goal never dispatches the same task twice", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: taskDoneReport },
      { kind: "completed", reply: verifyReport },
    ],
    holdWaitAt: 1,
    gate,
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(
      createInput({ acceptanceCriteria: ["Each channel persists after reload"] }),
    );

    // Two extra triggers while the only driver already owns the goal.
    yield* Effect.promise(() => gate.reached);
    yield* service.resume({ id: created.goal.id });
    yield* service.resume({ id: created.goal.id });
    gate.release();

    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "completed",
    );
    expect(script.sentTexts).toHaveLength(3);
    expect(script.sentTexts.filter((text) => text.includes("Your task this turn:"))).toHaveLength(
      1,
    );
  }).pipe(Effect.provide(scriptedLayer(script)));
});

it.effect("attempts and task state survive a server restart", () => {
  const script = makeScript();
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* GoalService.GoalService;
    const goalId = "goal:seed-attempts";
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
        evidence, attempts
      ) VALUES (
        ${goalId}, 'task:seeded', 'Do the thing', NULL, 'failed', 0, ${at}, NULL,
        'port 4000 already in use', 3
      )
    `;

    // Recovery wakes on the virtual clock and drives the seeded goal.
    yield* TestClock.adjust("15 seconds");
    const stopped = yield* awaitGoalState(
      service.subscribeList({}),
      GoalId.make(goalId),
      (goal) => goal.status === "blocked",
    );
    expect(stopped.blockedReason).toContain("Exhausted 3 attempts on: Do the thing.");

    // The stored budget is what stopped it: a restart must not reset it.
    const loaded = yield* service.get({ id: GoalId.make(goalId) });
    expect(loaded.goal.tasks[0]?.attempts).toBe(3);
    expect(loaded.goal.tasks[0]?.evidence).toBe("port 4000 already in use");
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("restart recovery resumes the 20 most recently updated goals", () => {
  const launchGate = { at: 20, gate: makeGate() };
  const script = makeScript({ launchMode: "never", launchGate });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const seeded: Array<{ readonly goalId: string; readonly updatedAt: string }> = [];
    for (let index = 0; index < 25; index += 1) {
      const goalId = `goal:seed-${index}`;
      const updatedAt = `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
      seeded.push({ goalId, updatedAt });
      yield* sql`
        INSERT INTO goals (
          goal_id, project_id, thread_id, title, objective, acceptance_criteria_json, status,
          current_task_id, model_selection_json, runtime_mode, interaction_mode,
          workspace_strategy_json, revision, cycle_count, verification_json, blocked_reason,
          failure_reason, pending_edit, pending_answer, created_by,
          creation_source, created_at, updated_at, started_at, completed_at, last_activity_at
        ) VALUES (
          ${goalId}, ${projectId}, NULL, 'Seeded goal', 'Objective', '[]', 'planning',
          NULL, ${JSON.stringify(modelSelection)}, 'auto', 'default',
          '{"type":"root"}', 1, 0, '{"status":"pending","summary":null,"checkedAt":null}',
          NULL, NULL, 0, NULL, 'user', 'web', ${updatedAt}, ${updatedAt}, ${updatedAt},
          NULL, ${updatedAt}
        )
      `;
    }

    // The recovery pass sleeps on the test clock; waking it starts drivers.
    yield* TestClock.adjust("15 seconds");
    yield* Effect.promise(() => launchGate.gate.reached);

    const resumed = yield* sql<{ goal_id: string }>`
      SELECT goal_id FROM goal_activities
      WHERE summary = 'Resumed after a server restart'
    `;
    const expectedNewest = seeded
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20);
    expect(new Set(resumed.map((row) => row.goal_id))).toEqual(
      new Set(expectedNewest.map((seed) => seed.goalId)),
    );
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("lists lightweight summaries while get returns detail", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: needsInputReport },
    ],
    holdWaitAt: 1,
    gate,
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    yield* Effect.promise(() => gate.reached);
    const listed = yield* service.list({ projectId });
    const summary = listed.goals.find((goal) => goal.id === created.goal.id);
    expect(summary?.status).toBe("running");
    expect(summary?.totalTaskCount).toBeGreaterThan(0);
    expect(summary?.completedTaskCount).toBe(0);
    expect(summary?.currentTaskTitle).not.toBeNull();
    expect(summary).not.toHaveProperty("activities");
    expect(summary).not.toHaveProperty("tasks");
    expect(summary).not.toHaveProperty("objective");

    const detail = yield* service.get({ id: created.goal.id });
    expect(detail.goal.tasks.length).toBeGreaterThan(0);
    expect(detail.goal.activities.length).toBeGreaterThan(0);
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("refuses to pause or resume a goal that is waiting for an answer", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: needsInputReport },
      { kind: "completed", reply: needsInputReport },
    ],
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());
    const asking = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    expect(asking.blockedReason).toBe("Which provider should it use?");

    const pauseFailure = yield* service.pause({ id: created.goal.id }).pipe(Effect.flip);
    expect(pauseFailure.message).toBe(
      "This goal is waiting for an answer. Answer the question to continue.",
    );
    const resumeFailure = yield* service.resume({ id: created.goal.id }).pipe(Effect.flip);
    expect(resumeFailure.message).toBe(
      "This goal is waiting for an answer. Answer the question to continue.",
    );

    // Both rejections left the question where the agent put it.
    const unchanged = yield* service.get({ id: created.goal.id });
    expect(unchanged.goal.status).toBe("needs_input");
    expect(unchanged.goal.blockedReason).toBe("Which provider should it use?");

    // Answering is still the way out, and the answer turn runs.
    yield* service.answer({ id: created.goal.id, text: "Use the email provider." });
    const answered = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    expect(answered.blockedReason).toBe("Which provider should it use?");
    expect(script.sentTexts).toHaveLength(3);
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("a queued drive attempt is consumed on exit without a spurious restart", () => {
  const gate = makeGate();
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: needsInputReport },
      { kind: "completed", reply: needsInputReport },
    ],
    holdWaitAt: 1,
    gate,
  });
  return Effect.gen(function* () {
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());

    // The plan turn finished; the driver is parked on the question turn, and
    // it is still the only loop on the goal.
    yield* Effect.promise(() => gate.reached);
    expect(script.waitCount).toBe(2);

    // Driven and active, so this drive attempt is queued instead of starting
    // a second loop over the same goal.
    const resumed = yield* service.resume({ id: created.goal.id });
    expect(resumed.goal.status).toBe("running");
    gate.release();

    // The question applies and the driver exits; the queued attempt must be
    // consumed there, not spawn a replacement for a goal only waiting on the
    // user.
    const asking = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    expect(asking.blockedReason).toBe("Which provider should it use?");
    expect(script.waitCount).toBe(2);
    expect(script.sentTexts).toHaveLength(2);

    // Answering starts a fresh loop and the answer turn runs.
    yield* service.answer({ id: created.goal.id, text: "Use the email provider." });
    const answered = yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );
    expect(answered.blockedReason).toBe("Which provider should it use?");
    expect(script.waitCount).toBe(3);
    expect(script.sentTexts).toHaveLength(3);
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("blocks driven goals nobody is driving and leaves the rest alone", () => {
  const script = makeScript({ launchMode: "never" });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* GoalService.GoalService;

    const seedDriven = (goalId: string, at: string) => sql`
      INSERT INTO goals (
        goal_id, project_id, thread_id, title, objective, acceptance_criteria_json, status,
        current_task_id, model_selection_json, runtime_mode, interaction_mode,
        workspace_strategy_json, revision, cycle_count, verification_json, blocked_reason,
        failure_reason, pending_edit, pending_answer, created_by,
        creation_source, created_at, updated_at, started_at, turn_started_at,
        completed_at, last_activity_at
      ) VALUES (
        ${goalId}, ${projectId}, NULL, 'Orphaned goal', 'Objective', '[]', 'running',
        NULL, ${JSON.stringify(modelSelection)}, 'auto', 'default',
        '{"type":"root"}', 1, 0, '{"status":"pending","summary":null,"checkedAt":null}',
        NULL, NULL, 0, NULL, 'user', 'web',
        ${at}, ${at}, ${at}, ${at}, NULL, ${at}
      )
    `;

    // Orphaned before a restart: driven, stale, past recovery's reach.
    const staleId = GoalId.make("goal:sweep-stale");
    yield* seedDriven(staleId, "1969-12-31T23:59:00.000Z");
    const before = yield* service.get({ id: staleId });
    expect(before.goal.status).toBe("running");
    expect(before.goal.turnStartedAt).not.toBeNull();

    // A driven goal with a live driver the sweep must not touch: the loop is
    // parked in its launch, so it holds the goal for the whole test.
    const created = yield* service.create(createInput());

    yield* TestClock.adjust("10 seconds");
    // Fresh at the current clock, so it lands on the far side of the cutoff.
    const freshId = GoalId.make("goal:sweep-fresh");
    const now = yield* DateTime.now;
    yield* seedDriven(freshId, DateTime.formatIso(DateTime.toUtc(now)));

    yield* service.sweepStuckGoals();

    const blocked = yield* service.get({ id: staleId });
    expect(blocked.goal.status).toBe("blocked");
    expect(blocked.goal.blockedReason).toBe(
      "The goal stopped making progress. Resume to continue.",
    );
    // The dispatch marker leaves with the non-driven status, so the card
    // cannot count a turn nobody is waiting on.
    expect(blocked.goal.turnStartedAt).toBeNull();
    expect(blocked.goal.activities.map((activity) => activity.summary)).toContain(
      "The goal stopped making progress",
    );

    const parked = yield* service.get({ id: created.goal.id });
    expect(parked.goal.status).toBe("planning");
    expect(parked.goal.blockedReason).toBeNull();

    const fresh = yield* service.get({ id: freshId });
    expect(fresh.goal.status).toBe("running");
    expect(fresh.goal.blockedReason).toBeNull();
  }).pipe(Effect.provide(scriptedLayer(script)));
});
it.effect("a question stays open while restart recovery and the sweep pass", () => {
  const script = makeScript({
    steps: [
      { kind: "completed", reply: planReport },
      { kind: "completed", reply: needsInputReport },
    ],
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* GoalService.GoalService;
    const created = yield* service.create(createInput());
    yield* awaitGoalState(
      service.subscribeList({}),
      created.goal.id,
      (goal) => goal.status === "needs_input",
    );

    // Recovery fires at 15s and the sweep at 60s; neither may re-drive a
    // goal that is only waiting on the user.
    yield* TestClock.adjust("70 seconds");

    const after = yield* service.get({ id: created.goal.id });
    expect(after.goal.status).toBe("needs_input");
    expect(after.goal.blockedReason).toBe("Which provider should it use?");
    expect(script.waitCount).toBe(2);
    expect(script.sentTexts).toHaveLength(2);
    const resumed = yield* sql<{ summary: string }>`
      SELECT summary FROM goal_activities WHERE goal_id = ${created.goal.id}
    `;
    expect(resumed.map((row) => row.summary)).not.toContain("Resumed after a server restart");
  }).pipe(Effect.provide(scriptedLayer(script)));
});
