import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Project,
} from "@dak/contracts";

import { McpSchema, McpServer } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";

const PROJECT_ID = ProjectId.make("project-canvas-shot");

/**
 * The temp workspace the project below is rooted at. Set while the layer is built, because the
 * assertions about what was or was not written need the real path rather than a second copy of it.
 */
let testWorkspaceRoot = "";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(9),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "canvas-shot-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "canvas-shot-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-canvas-shot"),
  requestNamespace: "provider-session-canvas-shot",
  thread: {
    threadId: ThreadId.make("thread-canvas-shot"),
    providerSessionId: "provider-session-canvas-shot",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(["canvas", "orchestration"]),
  issuedAt: 1,
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A real project workspace, because the screenshots have to be rendered and written to disk for this
 * test to mean anything. Mocking the renderer would test the mock.
 */
const layerTest = Layer.unwrap(
  Effect.gen(function* () {
    const workspaceRoot = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dak-canvas-shot-")),
    );
    testWorkspaceRoot = workspaceRoot;
    const project: Project = {
      id: PROJECT_ID,
      title: "Canvas shots",
      workspaceRoot,
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: 1,
      updatedAt: 1,
    };
    // The registration resolves threads, projects and the bus from the fiber it is built in, and
    // needs the MCP server itself, so it is provided those rather than the other way round.
    return McpHttpServer.layerCanvasToolkitRegistration.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          McpServer.McpServer.layer,
          Layer.succeed(Crypto.Crypto, testCrypto),
          McpToolAccessTestkit.liveThreadsLayer,
          Layer.mock(ProjectService.ProjectService)({
            getById: (projectId) =>
              Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
          }),
        ),
      ),
    );
  }).pipe(Effect.orDie),
);

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const contentOfType = (result: { readonly content: ReadonlyArray<unknown> }, type: string) =>
  result.content.filter(
    (
      entry,
    ): entry is { readonly type: "image"; readonly data: Uint8Array; readonly mimeType: string } =>
      typeof entry === "object" && entry !== null && (entry as { type?: string }).type === type,
  );

/**
 * The image blocks are the whole point of registering this tool by hand, and they are assembled
 * after the handler returns, so the assertion has to be on a `CallToolResult` rather than on the
 * handler's answer. A tall frame is the case that distinguishes the two: the ordinary toolkit route
 * would deliver one JSON blob here, and the agent would have no image to look at.
 */
it.effect(
  "attaches every part of a tall frame as an image block and keeps base64 out of the text",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Tall enough to be sliced twice over: 6000px of 390px-wide page produces 20 parts, which is
        // past the 8-image cap. That is deliberate — it exercises both the attach path and the trim
        // path in one call, and a silent trim is the failure worth ruling out.
        const created = yield* callTool("dak_canvas_create", {
          title: "Tall page",
          module: "generic",
          projectId: PROJECT_ID,
        });
        const documentId = (created.structuredContent as { documentId: string }).documentId;
        const frameId = (created.structuredContent as { starterFrameId: string }).starterFrameId;
        yield* callTool("dak_canvas_edit", {
          documentId,
          projectId: PROJECT_ID,
          code: `Update("${frameId}", { width: 390, height: 6000 }); return 1;`,
        });

        const result = yield* callTool("dak_canvas_screenshot", {
          documentId,
          projectId: PROJECT_ID,
        });
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();

        const metadata = result.structuredContent as {
          readonly tall: boolean;
          readonly parts: ReadonlyArray<{ readonly role: string; readonly height: number }>;
        };
        expect(metadata.tall).toBe(true);
        const sections = metadata.parts.filter((part) => part.role === "section");
        expect(sections.length).toBeGreaterThan(1);

        const images = contentOfType(result, "image");
        // One block per attached part, in order: the overview first, then every section.
        expect(images.length).toBeGreaterThan(1);
        expect(images.length).toBeLessThanOrEqual(8);
        for (const image of images) {
          expect(image.mimeType).toBe("image/png");
          // A real PNG, not a base64 string that only decodes to nothing.
          expect(Buffer.from(image.data).subarray(0, 8)).toEqual(PNG_MAGIC);
        }

        // The cap is stated rather than silent, and it says where the rest still is.
        const trimmed = (contentOfType(result, "text") as ReadonlyArray<{ readonly text: string }>)
          .map((entry) => entry.text)
          .find((text) => text.includes("image limit"));
        expect(trimmed).toBeDefined();
        expect(trimmed).toContain("paths");

        // The text carries the geometry and the file paths but never the pixels: the base64 is what
        // would bloat this block, and it is already in the image blocks.
        const text = contentOfType(result, "text") as ReadonlyArray<{ readonly text: string }>;
        expect(text.length).toBeGreaterThan(0);
        for (const entry of text) {
          expect(entry.text).not.toMatch(/iVBORw0KGgo/);
          expect(Buffer.from(entry.text).length).toBeLessThan(60_000);
        }
        // Every part, attached or trimmed, is still written to disk, so nothing is unreachable.
        const joined = text.map((entry) => entry.text).join("\n");
        expect(joined).toContain(".png");
      }),
    ).pipe(Effect.provide(layerTest)),
  { timeout: 180_000 },
);

/**
 * A frame that fits in one image, which is the ordinary case and the one `device_screenshot` and
 * `html_preview` already cover for their own single-image tools. Nothing is trimmed here, so no
 * note about a cap is emitted and every part arrives.
 */
it.effect(
  "attaches a short frame whole, with nothing trimmed and no note",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const created = yield* callTool("dak_canvas_create", {
          title: "Short page",
          module: "generic",
          projectId: PROJECT_ID,
        });
        const documentId = (created.structuredContent as { documentId: string }).documentId;
        const frameId = (created.structuredContent as { starterFrameId: string }).starterFrameId;
        yield* callTool("dak_canvas_edit", {
          documentId,
          projectId: PROJECT_ID,
          code: `Update("${frameId}", { width: 390, height: 900 }); return 1;`,
        });

        const result = yield* callTool("dak_canvas_screenshot", {
          documentId,
          projectId: PROJECT_ID,
        });
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();

        const metadata = result.structuredContent as {
          readonly parts: ReadonlyArray<{ readonly role: string }>;
        };
        // 900px is already past the long-edge limit, so even this "short" frame is sliced into an
        // overview plus sections — the cap under test here is the 8-image one, not the slicer.
        expect(metadata.parts.length).toBeGreaterThan(1);
        expect(metadata.parts.length).toBeLessThanOrEqual(8);
        expect(metadata.parts[0]?.role).toBe("overview");

        const images = contentOfType(result, "image");
        // Under the cap, so every part arrives and nothing is trimmed.
        expect(images).toHaveLength(metadata.parts.length);
        expect(Buffer.from(images[0]!.data).subarray(0, 8)).toEqual(PNG_MAGIC);

        const [text] = contentOfType(result, "text") as ReadonlyArray<{ readonly text: string }>;
        expect(text!.text).not.toMatch(/iVBORw0KGgo/);
        expect(text!.text).not.toContain("limit");
        expect(text!.text).toContain(".png");
      }),
    ).pipe(Effect.provide(layerTest)),
  { timeout: 180_000 },
);

/**
 * `includeImage: false` is how a client that cannot render an image asks for paths alone. It must
 * not attach anything, and it must not claim it trimmed something: nothing was over a limit.
 */
it.effect(
  "attaches nothing and trims nothing when includeImage is false",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const created = yield* callTool("dak_canvas_create", {
          title: "No images",
          module: "generic",
          projectId: PROJECT_ID,
        });
        const documentId = (created.structuredContent as { documentId: string }).documentId;
        const frameId = (created.structuredContent as { starterFrameId: string }).starterFrameId;
        yield* callTool("dak_canvas_edit", {
          documentId,
          projectId: PROJECT_ID,
          code: `Update("${frameId}", { width: 390, height: 6000 }); return 1;`,
        });

        const result = yield* callTool("dak_canvas_screenshot", {
          documentId,
          projectId: PROJECT_ID,
          includeImage: false,
        });
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        expect(contentOfType(result, "image")).toHaveLength(0);
        const joined = (contentOfType(result, "text") as ReadonlyArray<{ readonly text: string }>)
          .map((entry) => entry.text)
          .join("\n");
        expect(joined).not.toContain("image limit");
        expect(joined).toContain(".png");
      }),
    ).pipe(Effect.provide(layerTest)),
  { timeout: 180_000 },
);

/**
 * The written files are the durable half of the answer: a client that cannot render an image, or a
 * call that was trimmed by the cap, still gets every part on disk.
 */
it.effect(
  "writes every part to disk as a real png",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const created = yield* callTool("dak_canvas_create", {
          title: "Looked at",
          module: "generic",
          projectId: PROJECT_ID,
        });
        const documentId = (created.structuredContent as { documentId: string }).documentId;
        const frameId = (created.structuredContent as { starterFrameId: string }).starterFrameId;
        // Offset so a crop taken at the page origin rather than the frame's own would be obviously
        // wrong: three quarters of the image would be empty page.
        yield* callTool("dak_canvas_edit", {
          documentId,
          projectId: PROJECT_ID,
          code: `Update("${frameId}", { x: 120, y: 100, width: 390, height: 900 }); return 1;`,
        });

        const result = yield* callTool("dak_canvas_screenshot", {
          documentId,
          projectId: PROJECT_ID,
        });
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        const metadata = result.structuredContent as {
          readonly bounds: { readonly x: number; readonly y: number };
          readonly parts: ReadonlyArray<{ readonly path?: string; readonly mimeType: string }>;
        };
        // The captured region is the frame's own box, not the page's.
        expect(metadata.bounds.x).toBe(120);
        expect(metadata.bounds.y).toBe(100);

        for (const part of metadata.parts) {
          expect(part.path).toBeDefined();
          expect(part.mimeType).toBe("image/png");
          const bytes = yield* Effect.promise(() => NodeFSP.readFile(part.path as string));
          expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);
          // The PNG header carries the real dimensions, so a crop from the wrong origin would show up
          // as a wider image than the frame is.
          const width = Buffer.from(bytes).readUInt32BE(16);
          const height = Buffer.from(bytes).readUInt32BE(20);
          expect(width).toBeGreaterThan(0);
          expect(height).toBeGreaterThan(0);
        }
      }),
    ).pipe(Effect.provide(layerTest)),
  { timeout: 180_000 },
);

/** `save: false` reports the geometry without writing anything. */
it.effect(
  "writes nothing when save is false",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const created = yield* callTool("dak_canvas_create", {
          title: "Unsaved",
          module: "generic",
          projectId: PROJECT_ID,
        });
        const documentId = (created.structuredContent as { documentId: string }).documentId;
        const frameId = (created.structuredContent as { starterFrameId: string }).starterFrameId;
        yield* callTool("dak_canvas_edit", {
          documentId,
          projectId: PROJECT_ID,
          code: `Update("${frameId}", { width: 390, height: 6000 }); return 1;`,
        });

        const result = yield* callTool("dak_canvas_screenshot", {
          documentId,
          projectId: PROJECT_ID,
          save: false,
        });
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        const metadata = result.structuredContent as {
          readonly parts: ReadonlyArray<{ readonly path?: string; readonly role: string }>;
        };
        expect(metadata.parts.length).toBeGreaterThan(2);
        for (const part of metadata.parts) expect(part.path).toBeUndefined();
        // The scratch directory is never created when nothing was asked to be written.
        const scratch = NodePath.join(testWorkspaceRoot, ".dak", "canvas-screenshots");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(scratch).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
    ).pipe(Effect.provide(layerTest)),
  { timeout: 180_000 },
);
