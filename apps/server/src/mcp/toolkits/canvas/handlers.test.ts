// @effect-diagnostics nodeBuiltinImport:off - These tests assert on where Canvas actually wrote
// on disk, so they read the filesystem directly rather than through the service that wrote it.
import {
  CanvasFailure,
  EnvironmentId,
  OrchestratorMcpFailure,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@dak/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as CanvasChangeBus from "../../../canvas/CanvasChangeBus.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as CanvasHandlers from "./handlers.ts";
import { CanvasToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-canvas");
const PROJECT_ID = ProjectId.make("project-canvas");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(9),
  digest: (_algorithm, data) => Effect.succeed(data),
});

/**
 * A thread caller with an active run, which is what the access gate requires
 * before it lets any write happen. The `client` field is what separates a
 * thread caller from an MCP client signed in from outside DAK.
 */
const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  client: McpInvocationContext.McpClientCaller | undefined = undefined,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-canvas"),
  requestNamespace: "provider-session-canvas",
  thread:
    client === undefined
      ? {
          threadId: THREAD_ID,
          providerSessionId: "provider-session-canvas",
          providerInstanceId: ProviderInstanceId.make("codex"),
        }
      : undefined,
  client,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

/**
 * A harness over a real temporary workspace, because the properties worth
 * testing here are filesystem ones: that a design is stored inside the project,
 * that a stale trash title is refused, and that an export outside the project
 * never writes anything. Mocking the store would test nothing but the mock.
 */
const makeHarness = Effect.fn("makeCanvasHarness")(function* () {
  const workspaceRoot = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dak-canvas-")),
  );
  const project: Project = {
    id: PROJECT_ID,
    title: "Canvas project",
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
  };
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    // The real bus, so a test that edits a design exercises the same announcement path a live
    // view depends on rather than a stub that publishes nothing.
    CanvasChangeBus.layer,
    // The shared testkit answers with its own project, which is not the one registered above, so
    // the caller's project is pinned here. That is what makes an omitted projectId resolve here.
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          ...McpToolAccessTestkit.liveThreadShell(threadId),
          projectId: PROJECT_ID,
        }),
    }),
  );

  const toolkit = yield* CanvasToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(CanvasHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );

  /**
   * The failure a canvas tool can deliver: its own `CanvasFailure` codes, or the access gate's
   * `OrchestratorMcpFailure`. Typing it concretely is what lets a test assert on the code it
   * expects rather than on an opaque error.
   */
  type CanvasToolRefusal = CanvasFailure | OrchestratorMcpFailure;

  const call = <Name extends keyof typeof CanvasToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    options: {
      readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
      readonly client?: McpInvocationContext.McpClientCaller | undefined;
    } = {},
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // These tools declare `failureMode: "return"`, so a refusal arrives as a delivered chunk
      // rather than a failed effect. Surfacing it as a failure is what lets a test assert on it
      // with `Effect.flip`, and it is the shape the transport converts back into an error result.
      Effect.flatMap(
        (
          chunks,
        ): Effect.Effect<Tool.Success<(typeof CanvasToolkit.tools)[Name]>, CanvasToolRefusal> => {
          const last = chunks.at(-1)!;
          return last.isFailure
            ? Effect.fail(last.encodedResult as CanvasToolRefusal)
            : Effect.succeed(last.result as Tool.Success<(typeof CanvasToolkit.tools)[Name]>);
        },
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        // `orchestration` is what `readCaller` checks, so a real thread session's canvas
        // credential carries both. The capability tests below narrow this deliberately.
        invocation(options.capabilities ?? ["canvas", "orchestration"], options.client),
      ),
      Effect.provide(layerDependencies),
    );

  return { call, workspaceRoot };
});

const exists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    ),
  );

describe("canvas toolkit handlers", () => {
  it.effect("refuses a credential without the canvas capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("dak_canvas_list", {}, { capabilities: ["orchestration"] })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "capability_denied",
      });
    }),
  );

  it.effect("refuses every write for an MCP client outside a thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const client: McpInvocationContext.McpClientCaller = {
        sessionId: "session-canvas",
        label: "outside agent",
        access: "full-access",
      };
      // An OAuth client never receives the canvas capability, so grant it here to prove the
      // thread requirement is enforced separately from the capability check.
      for (const write of [
        ["dak_canvas_create", { title: "Deck", module: "deck" as const }],
        ["dak_canvas_edit", { documentId: "design-1" as never, code: "return 1;" }],
        ["dak_canvas_undo", { documentId: "design-1" as never }],
        ["dak_canvas_trash", { documentId: "design-1" as never, confirmTitle: "Deck" }],
        ["dak_canvas_restore", { documentId: "design-1" as never }],
        [
          "dak_canvas_export",
          {
            documentId: "design-1" as never,
            nodeIds: ["frame-1"],
            format: "png" as const,
            destination: "/tmp/out.png",
          },
        ],
      ] as const) {
        const error = yield* harness.call(write[0], write[1], { client }).pipe(Effect.flip);
        expect(error, write[0]).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: "thread_credential_required",
        });
      }
    }),
  );

  it.effect("refuses reads for a client that names a project but lacks the capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const client: McpInvocationContext.McpClientCaller = {
        sessionId: "session-canvas",
        label: "outside agent",
        access: "full-access",
      };
      // This is the credential `McpOAuth` actually issues: every capability except `canvas`.
      // Naming a project gets it nowhere, because the capability check runs first.
      for (const read of [
        ["dak_canvas_list", { projectId: PROJECT_ID }],
        ["dak_canvas_read", { documentId: "design-1" as never, projectId: PROJECT_ID }],
      ] as const) {
        const error = yield* harness
          .call(read[0], read[1], {
            client,
            capabilities: ["orchestration", "worktree", "pull-requests"],
          })
          .pipe(Effect.flip);
        expect(error, read[0]).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: "capability_denied",
        });
      }

      // With no thread to default to and no capability, a client is told to name a project
      // rather than having one guessed at.
      const unnamed = yield* harness
        .call("dak_canvas_list", {}, { client, capabilities: ["canvas", "orchestration"] })
        .pipe(Effect.flip);
      expect(unnamed).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "target_required",
      });
    }),
  );

  it.effect("creates a design inside the project workspace and reads it back", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const created = yield* harness.call("dak_canvas_create", {
        title: "Launch deck",
        module: "deck",
      });
      expect(created.title).toBe("Launch deck");
      expect(created.starterFrameId.length).toBeGreaterThan(0);
      // The design belongs to the project, not to some server-side bucket.
      expect(
        yield* exists(NodePath.join(harness.workspaceRoot, ".dak", "canvas", created.documentId)),
      ).toBe(true);

      const listed = yield* harness.call("dak_canvas_list", {});
      expect(listed.items.map((item) => item.id)).toEqual([created.documentId]);

      const outline = yield* harness.call("dak_canvas_read", {
        documentId: created.documentId,
      });
      expect(outline.summary.title).toBe("Launch deck");
      expect(outline.frames.map((frame) => frame.id)).toContain(created.starterFrameId);
      expect(outline.omitted).toBe(0);
    }),
  );

  it.effect("reports a missing project rather than guessing one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      // An unknown projectId is reported, not silently substituted with the caller's own.
      const missing = yield* harness
        .call("dak_canvas_list", { projectId: ProjectId.make("project-nope") })
        .pipe(Effect.flip);
      expect(missing).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "invalid_request",
        message: "The project was not found.",
      });

      // With projectId omitted, the caller's own project is used and an empty project lists empty.
      const listed = yield* harness.call("dak_canvas_list", {});
      expect(listed.items).toEqual([]);
    }),
  );

  it.effect("trash refuses a stale title and restore brings the design back", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const created = yield* harness.call("dak_canvas_create", {
        title: "Quarterly review",
        module: "deck",
      });

      const mismatch = yield* harness
        .call("dak_canvas_trash", {
          documentId: created.documentId,
          confirmTitle: "Quarterly reviews",
        })
        .pipe(Effect.flip);
      expect(mismatch).toMatchObject({
        _tag: "CanvasFailure",
        code: "trash_confirmation_mismatch",
      });
      // The refusal left it where it was.
      expect((yield* harness.call("dak_canvas_list", {})).items).toHaveLength(1);

      const trashed = yield* harness.call("dak_canvas_trash", {
        documentId: created.documentId,
        confirmTitle: "Quarterly review",
      });
      expect(trashed).toEqual({
        documentId: created.documentId,
        title: "Quarterly review",
        trashed: true,
      });
      // Trashed designs are hidden until asked for.
      expect((yield* harness.call("dak_canvas_list", {})).items).toHaveLength(0);
      expect((yield* harness.call("dak_canvas_list", { includeTrash: true })).items).toHaveLength(
        1,
      );

      const restored = yield* harness.call("dak_canvas_restore", {
        documentId: created.documentId,
      });
      expect(restored).toEqual({
        documentId: created.documentId,
        title: "Quarterly review",
        restored: true,
      });
      expect((yield* harness.call("dak_canvas_list", {})).items).toHaveLength(1);
    }),
  );

  it.effect("refuses to edit a trashed design and names the way out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const created = yield* harness.call("dak_canvas_create", {
        title: "Archived",
        module: "generic",
      });
      yield* harness.call("dak_canvas_trash", {
        documentId: created.documentId,
        confirmTitle: "Archived",
      });
      const error = yield* harness
        .call("dak_canvas_edit", { documentId: created.documentId, code: "return 1;" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "CanvasFailure", code: "document_deleted" });
    }),
  );

  it.effect("refuses an export outside the project and writes nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const created = yield* harness.call("dak_canvas_create", {
        title: "Exportable",
        module: "deck",
      });
      // A path outside the project that does not exist, so a write here would be visible.
      const outside = NodePath.join(
        NodeOS.tmpdir(),
        `dak-canvas-escape-${yield* Clock.currentTimeMillis}.png`,
      );
      const error = yield* harness
        .call("dak_canvas_export", {
          documentId: created.documentId,
          nodeIds: [created.starterFrameId],
          format: "png",
          destination: outside,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "CanvasFailure", code: "destination_unsafe" });
      expect(yield* exists(outside)).toBe(false);
    }),
  );

  it.effect("refuses to export over a path that already exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const created = yield* harness.call("dak_canvas_create", {
        title: "Exportable",
        module: "deck",
      });
      const destination = NodePath.join(harness.workspaceRoot, "already-here.png");
      yield* Effect.promise(() => NodeFSP.writeFile(destination, "not mine to overwrite"));
      const error = yield* harness
        .call("dak_canvas_export", {
          documentId: created.documentId,
          nodeIds: [created.starterFrameId],
          format: "png",
          destination,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "CanvasFailure", code: "destination_exists" });
      // The refusal happened before any write, so the file is untouched.
      expect(yield* Effect.promise(() => NodeFSP.readFile(destination, "utf8"))).toBe(
        "not mine to overwrite",
      );
    }),
  );
  it.effect("checks the canvas capability before touching the project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      // A credential with every other capability still gets nowhere: the canvas check runs
      // before the project is resolved, so nothing about the workspace is disclosed.
      const error = yield* harness
        .call(
          "dak_canvas_list",
          { projectId: ProjectId.make("project-nope") },
          { capabilities: ["orchestration", "worktree", "pull-requests"] },
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "capability_denied",
      });
    }),
  );

  describe("the tools an agent reviews a design with", () => {
    it.effect("inspects a design and reports what is wrong with it", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const created = yield* harness.call("dak_canvas_create", {
          title: "Reviewed",
          module: "web",
        });

        // A brand new design is a blank frame, and a blank frame is exactly what `empty_frame` is
        // for — so a design is not clean until it has something in it. The other assertion below is
        // measured from here.
        const blank = yield* harness.call("dak_canvas_inspect", {
          documentId: created.documentId,
        });
        expect(blank.issues.map((issue) => issue.code)).toEqual(["empty_frame"]);
        expect(blank.issues[0]?.nodeIds).toEqual([created.starterFrameId]);
        expect(blank.omitted).toBe(0);

        // A filled shape with no label is the defect this exists for.
        yield* harness.call("dak_canvas_edit", {
          documentId: created.documentId,
          code: `Insert("${created.starterFrameId}", { id: "btn", type: "rectangle", x: 16, y: 16, width: 140, height: 44, fill: "#0f172a" }); return 1;`,
        });

        const after = yield* harness.call("dak_canvas_inspect", {
          documentId: created.documentId,
        });
        expect(after.counts.empty_control).toBe(1);
        // The frame now has a child, so the one problem it had is gone and only the new one is left.
        expect(after.counts.empty_frame).toBeUndefined();
        const issue = after.issues.find((entry) => entry.code === "empty_control");
        expect(issue?.nodeIds).toEqual(["btn"]);
        expect(issue?.fix).toContain("frame");
        expect(issue?.numbers.width).toBe(140);
      }),
    );

    it.effect("measures nodes, and says so when a selector matches nothing", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const created = yield* harness.call("dak_canvas_create", {
          title: "Measured",
          module: "web",
        });

        const all = yield* harness.call("dak_canvas_measure", {
          documentId: created.documentId,
        });
        expect(all.nodes.map((node) => node.id)).toEqual([created.starterFrameId]);
        expect(all.unmatchedSelectors).toEqual([]);

        const one = yield* harness.call("dak_canvas_measure", {
          documentId: created.documentId,
          selectors: [created.starterFrameId],
        });
        expect(one.nodes).toHaveLength(1);
        expect(one.nodes[0]?.width).toBeGreaterThan(0);

        const missing = yield* harness.call("dak_canvas_measure", {
          documentId: created.documentId,
          selectors: ["nope"],
        });
        // An empty answer about a node that does not exist reads as "nothing there", so the
        // selector that matched nothing is reported instead.
        expect(missing.nodes).toEqual([]);
        expect(missing.unmatchedSelectors).toEqual(["nope"]);
      }),
    );
  });
});
