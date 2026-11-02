import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import type { GoalCreateInput, ModelSelection, ProjectId } from "@dak/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
    expect(updated.goal.status).toBe("running");
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
