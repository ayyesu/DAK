// @effect-diagnostics nodeBuiltinImport:off - The announcement test writes real designs to a real
// temporary directory, because the announcement it checks is built from what the store reads back.
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { ProjectId, type Project } from "@dak/contracts";

import * as CanvasChangeBus from "./CanvasChangeBus.ts";
import type { CanvasActivity, CanvasDocumentChange } from "./CanvasPorts.ts";
import { canvasActivity } from "./CanvasSocket.ts";
import { make as makeStore } from "./CanvasStoreLive.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * What a design view needs in order to open the design an agent just touched.
 *
 * Two separate promises are under test, and they fail differently. The store has to announce a
 * committed change with enough to label it, because a tab that waits for a render before it can say
 * what it is showing reads as a blank tab. And the socket has to hand a project only its own
 * designs, because opening another project's tab in a thread is worse than opening nothing.
 */

const PROJECT_ID = ProjectId.make("project-canvas");
const OTHER_PROJECT_ID = ProjectId.make("project-other");

const roots: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dak-canvas-activity-"));
  roots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true }).catch(() => undefined)),
  );
});

/**
 * Records announcements and lets a test wait for one.
 *
 * The store announces after the write it describes has already returned, so a test that reads the
 * array immediately races it. Waiting on a count is waiting on the milestone itself, which is what
 * the announcement is; a delay would pass on a slow machine and mask a store that never announced.
 */
const makeRecorder = () => {
  const changes: CanvasDocumentChange[] = [];
  const waiters: Array<() => void> = [];
  return {
    changes,
    publish: (change: CanvasDocumentChange) => {
      changes.push(change);
      for (const waiter of waiters.splice(0)) waiter();
    },
    waitFor: (count: number) =>
      new Promise<void>((resolve) => {
        if (changes.length >= count) {
          resolve();
          return;
        }
        waiters.push(resolve);
      }),
  };
};

describe("canvas change announcements", () => {
  it("announces a created design with the title and module a tab needs", async () => {
    const root = await makeWorkspace();
    const recorder = makeRecorder();
    const store = makeStore({ workspaceRoot: root, publish: recorder.publish });

    const { documentId } = await store.createDocument({
      title: "Launch poster",
      module: "generic",
      // The announcement only reads metadata, so a blank snapshot with no update log is a complete
      // design as far as this path is concerned — and it keeps CanvasKit out of the test.
      snapshot: { throughSequence: 0, state: "", source: {} },
      starterFrameId: "frame-1",
    });
    await recorder.waitFor(1);

    expect(recorder.changes).toEqual([
      {
        documentId,
        sequence: 0,
        trashed: false,
        title: "Launch poster",
        module: "generic",
      },
    ]);
  });

  it("announces an edit at the sequence it committed", async () => {
    const root = await makeWorkspace();
    const recorder = makeRecorder();
    const store = makeStore({ workspaceRoot: root, publish: recorder.publish });
    const { documentId } = await store.createDocument({
      title: "Deck",
      module: "deck",
      snapshot: { throughSequence: 0, state: "", source: {} },
      starterFrameId: "frame-1",
    });
    await recorder.waitFor(1);

    await store.appendUpdate({
      documentId,
      clientUpdateId: "client-1",
      update: "forward",
      operationId: "op-1",
      inverseUpdate: "inverse",
      expectedSequence: 0,
    });
    await recorder.waitFor(2);

    expect(recorder.changes[1]).toMatchObject({ documentId, sequence: 1, trashed: false });
  });

  it("announces a design moved to the trash and back", async () => {
    const root = await makeWorkspace();
    const recorder = makeRecorder();
    const store = makeStore({ workspaceRoot: root, publish: recorder.publish });
    // A title the trash guard would accept is irrelevant here: this checks what is announced, not
    // whether the caller was allowed to move it.
    const created = await store.createDocument({
      title: "Old work",
      module: "generic",
      snapshot: { throughSequence: 0, state: "", source: {} },
      starterFrameId: "frame-1",
    });
    await recorder.waitFor(1);

    await store.trashDocument(created.documentId);
    await recorder.waitFor(2);
    expect(recorder.changes[1]).toMatchObject({ documentId: created.documentId, trashed: true });

    await store.restoreDocument(created.documentId);
    await recorder.waitFor(3);
    expect(recorder.changes[2]).toMatchObject({ documentId: created.documentId, trashed: false });
  });
});

const project: Project = {
  id: PROJECT_ID,
  title: "Canvas project",
  workspaceRoot: "/tmp/does-not-matter",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null,
};

const projectLayer = Layer.mock(ProjectService.ProjectService)({
  getById: (projectId) =>
    Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
});

const activity = (input: {
  readonly projectId: ProjectId;
  readonly documentId: string;
  readonly sequence: number;
  readonly trashed?: boolean;
}): CanvasActivity => ({
  projectId: input.projectId,
  documentId: input.documentId,
  title: `${input.documentId} title`,
  module: "generic",
  sequence: input.sequence,
  trashed: input.trashed ?? false,
});

const busLayer = (changes: ReadonlyArray<CanvasActivity>) =>
  Layer.succeed(CanvasChangeBus.CanvasChangeBus, {
    publish: () => Effect.void,
    changes: Stream.fromIterable(changes),
  });

describe("canvas activity stream", () => {
  effectIt.effect("hands a project its own designs, one item per real change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* canvasActivity({ projectId: PROJECT_ID });
        const items = yield* Stream.runCollect(stream);
        expect([...items]).toEqual([
          {
            kind: "activity",
            documentId: "design-1",
            title: "design-1 title",
            module: "generic",
            sequence: 1,
            trashed: false,
          },
          {
            kind: "activity",
            documentId: "design-1",
            title: "design-1 title",
            module: "generic",
            sequence: 2,
            trashed: false,
          },
          {
            kind: "activity",
            documentId: "design-2",
            title: "design-2 title",
            module: "generic",
            sequence: 1,
            trashed: false,
          },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            projectLayer,
            busLayer([
              // Another project's design must not open a tab here.
              activity({ projectId: OTHER_PROJECT_ID, documentId: "elsewhere", sequence: 1 }),
              activity({ projectId: PROJECT_ID, documentId: "design-1", sequence: 1 }),
              // A republished sequence moved nothing, so it must not reach the client a second time.
              activity({ projectId: PROJECT_ID, documentId: "design-1", sequence: 1 }),
              activity({ projectId: PROJECT_ID, documentId: "design-1", sequence: 2 }),
              // A second design in the same project is a different tab, not a duplicate.
              activity({ projectId: PROJECT_ID, documentId: "design-2", sequence: 1 }),
            ]),
          ),
        ),
      ),
    ),
  );

  effectIt.effect("refuses a project this environment does not have", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A stream that simply never emitted would be indistinguishable from an idle project, so the
        // unknown project has to fail the call rather than look quiet.
        const exit = yield* Effect.exit(canvasActivity({ projectId: OTHER_PROJECT_ID }));
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(Layer.mergeAll(projectLayer, busLayer([])))),
    ),
  );
});
