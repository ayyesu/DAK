import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  VcsRepositoryDetectionError,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
} from "@dak/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it, vi } from "@effect/vitest";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";

const threadId = ThreadId.make("thread:checkpoint-multi-repo");
const runId = RunId.make("run:checkpoint-multi-repo");
const nodeId = NodeId.make("node:checkpoint-multi-repo");
const scopeId = CheckpointScopeId.make("scope:checkpoint-multi-repo");
const providerThreadId = ProviderThreadId.make("provider:checkpoint-multi-repo");
const checkpointRef = CheckpointRef.make("refs/dak/test/multi-repo");
const createdAt = DateTime.makeUnsafe("2026-11-27T12:00:00.000Z");

const makeScope = (): OrchestrationV2CheckpointScope => ({
  id: scopeId,
  threadId,
  runId,
  nodeId,
  parentScopeId: null,
  providerThreadId,
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd: "/repo",
  additionalCwds: ["/repo-api"],
  createdAt,
});

const makeCheckpoint = (): OrchestrationV2Checkpoint => ({
  id: CheckpointId.make("checkpoint:checkpoint-multi-repo"),
  threadId,
  scopeId,
  runId,
  nodeId,
  parentCheckpointId: null,
  ordinalWithinScope: 1,
  appRunOrdinal: null,
  ref: checkpointRef,
  status: "ready",
  files: [],
  capturedAt: createdAt,
});

it.effect("captures and summarizes every worktree in a checkpoint scope", () => {
  const captureCheckpoint = vi.fn((_input: CheckpointStore.CaptureCheckpointInput) => Effect.void);
  const diffCheckpoints = vi.fn((input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed(`1\t0\tfile.txt\0${input.cwd}`),
  );
  const layer = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          captureCheckpoint,
          hasCheckpointRef: () => Effect.succeed(true),
          diffCheckpoints,
        }),
        NodeCrypto.layer,
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointService.CheckpointServiceV2;
    const checkpoint = yield* service.capture({
      scope: makeScope(),
      runId,
      nodeId,
      ordinalWithinScope: 1,
      appRunOrdinal: null,
      capturedAt: createdAt,
    });

    assert.deepEqual(
      captureCheckpoint.mock.calls.map((call) => call[0].cwd),
      ["/repo", "/repo-api"],
    );
    assert.deepEqual(
      checkpoint.files.map((file) => file.path),
      ["repo/file.txt", "repo-api/file.txt"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("fails the whole restore when any worktree cannot be restored", () => {
  const restoreCheckpoint = vi.fn((input: CheckpointStore.RestoreCheckpointInput) =>
    input.cwd === "/repo-api"
      ? Effect.fail(
          new VcsRepositoryDetectionError({
            operation: "CheckpointService.test.restore",
            cwd: input.cwd,
            detail: "ref unavailable",
          }),
        )
      : Effect.succeed(true),
  );
  const layer = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          restoreCheckpoint,
        }),
        NodeCrypto.layer,
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointService.CheckpointServiceV2;
    const error = yield* service
      .restore({ scope: makeScope(), checkpoint: makeCheckpoint() })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointService.CheckpointRestoreError);
    assert.equal(restoreCheckpoint.mock.calls.length, 2);
  }).pipe(Effect.provide(layer));
});
