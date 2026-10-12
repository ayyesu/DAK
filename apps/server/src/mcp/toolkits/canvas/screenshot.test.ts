// @effect-diagnostics nodeBuiltinImport:off -- Builds a real temp workspace on disk and reads back what the tool wrote there.
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
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
      deletedAt: null,
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

// Narrows by the block's own `type` tag. One predicate cannot describe both an image block and a
// text block, and a guard that only described images made every text assertion need a cast that
// TypeScript correctly rejected.
interface ToolTextBlock {
  readonly type: "text";
  readonly text: string;
}
interface ToolImageBlock {
  readonly type: "image";
  readonly data: Uint8Array;
  readonly mimeType: string;
}

const contentOfType = <T extends ToolTextBlock | ToolImageBlock>(
  result: { readonly content: ReadonlyArray<unknown> },
  type: T["type"],
): ReadonlyArray<T> =>
  result.content.filter(
    (entry): entry is T =>
      typeof entry === "object" && entry !== null && (entry as { type?: string }).type === type,
  );

const textBlocks = (result: {
  readonly content: ReadonlyArray<unknown>;
}): ReadonlyArray<ToolTextBlock> => contentOfType<ToolTextBlock>(result, "text");

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

        const images = contentOfType<ToolImageBlock>(result, "image");
        // One block per part, in order: the overview first, then every section on this page.
        expect(images.length).toBeGreaterThan(1);
        expect(images.length).toBeLessThanOrEqual(8);
        expect(images).toHaveLength(metadata.parts.length);
        for (const image of images) {
          expect(image.mimeType).toBe("image/png");
          // A real PNG, not a base64 string that only decodes to nothing.
          expect(Buffer.from(image.data).subarray(0, 8)).toEqual(PNG_MAGIC);
        }

        // Nothing is trimmed: the planner now keeps a page inside the cap on purpose, so the
        // transport cap is a backstop rather than the thing doing the work. This is the assertion
        // that would fail if the planner regressed back to slicing the whole page at once.
        const text = textBlocks(result);
        expect(text.length).toBeGreaterThan(0);
        const joined = text.map((entry) => entry.text).join("\n");
        expect(joined).not.toContain("image limit");
        // Every part is on disk regardless, so nothing is unreachable.
        expect(joined).toContain(".png");

        // The text carries the geometry but never the pixels: the base64 is what would bloat this
        // block, and it is already in the image blocks.
        for (const entry of text) {
          expect(entry.text).not.toMatch(/iVBORw0KGgo/);
          expect(Buffer.from(entry.text).length).toBeLessThan(60_000);
        }
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

        const images = contentOfType<ToolImageBlock>(result, "image");
        // Under the cap, so every part arrives and nothing is trimmed.
        expect(images).toHaveLength(metadata.parts.length);
        expect(Buffer.from(images[0]!.data).subarray(0, 8)).toEqual(PNG_MAGIC);

        const [text] = textBlocks(result);
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
        expect(contentOfType<ToolImageBlock>(result, "image")).toHaveLength(0);
        const joined = textBlocks(result)
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

/**
 * The scale and the paging.
 *
 * A 390x6000 page used to come back as twenty parts: the planner scaled it 4x to fill the width
 * budget, which left a 392px slice and therefore sixteen of them. Twenty images is not a page an
 * agent can read, so the whole-frame scale is capped lower and the sections are paged. This test
 * pins both halves: one call stays inside the image cap, and walking the cursor covers the entire
 * height with the same 64px overlap a single call would have had.
 */
it.effect(
  "pages a tall phone page so one call fits the cap and the pages cover it whole",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const created = yield* callTool("dak_canvas_create", {
          title: "Long page",
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

        type Page = {
          readonly tall: boolean;
          readonly scale: number;
          readonly bounds: { readonly height: number };
          readonly totalSections: number;
          readonly nextSectionIndex?: number;
          readonly parts: ReadonlyArray<{
            readonly role: string;
            readonly y: number;
            /** Design units; `heightPx` is the rendered pixel height. */
            readonly height: number;
            readonly width: number;
          }>;
        };

        // Page through until the cursor runs out, collecting what each page covered.
        const seen: Array<{ readonly y: number; readonly height: number }> = [];
        let page = yield* callTool("dak_canvas_screenshot", {
          documentId,
          projectId: PROJECT_ID,
        });
        let pages = 0;
        let first: Page | undefined;
        for (;;) {
          const metadata = page.structuredContent as Page;
          first ??= metadata;
          pages += 1;
          expect(contentOfType<ToolImageBlock>(page, "image").length).toBeLessThanOrEqual(8);
          for (const part of metadata.parts) {
            if (part.role === "section") seen.push({ y: part.y, height: part.height });
          }
          if (metadata.nextSectionIndex === undefined) break;
          page = yield* callTool("dak_canvas_screenshot", {
            documentId,
            projectId: PROJECT_ID,
            sectionIndex: metadata.nextSectionIndex,
          });
          // A cursor that never advances would page forever, so the loop is bounded too.
          expect(pages).toBeLessThan(20);
        }

        expect(first?.tall).toBe(true);
        expect(first?.bounds.height).toBe(6000);
        // A 390px frame at 2x is 780px wide: wide enough to read, and the reason a 6000px page is a
        // handful of slices rather than sixteen.
        expect(first?.scale).toBe(2);
        expect(first?.parts[0]?.role).toBe("overview");
        // 6000 / (1568/2 - 64) is a little over eight, so the page is two answers rather than one.
        expect(pages).toBe(2);
        expect(first?.nextSectionIndex).toBe(7);
        expect(first?.totalSections).toBeGreaterThan(7);

        // Covered from the top to the bottom with no hole, and consecutive sections overlap by the
        // documented 64px so a boundary is never only cut in one place.
        // `height` is design units and `heightPx` is the rendered height; an answer that reported the
        // pixel value under the name `height` made every section look twice as tall as it was.
        expect(seen[0]?.y).toBe(0);
        expect(seen.at(-1)!.y + seen.at(-1)!.height).toBe(6000);
        for (let index = 1; index < seen.length; index += 1) {
          const previous = seen[index - 1]!;
          const current = seen[index]!;
          expect(current.y).toBeLessThanOrEqual(previous.y + previous.height);
          if (current.y < previous.y + previous.height - 1) {
            expect(previous.y + previous.height - current.y).toBe(64);
          }
        }

        // A targeted crop is still allowed the full 4x budget, because there is nothing competing
        // for it when only one piece of the design was asked about.
        const cropped = yield* callTool("dak_canvas_screenshot", {
          documentId,
          projectId: PROJECT_ID,
          selector: frameId,
        });
        const croppedMeta = cropped.structuredContent as Page;
        expect(croppedMeta.scale).toBe(4);
      }),
    ).pipe(Effect.provide(layerTest)),
  { timeout: 300_000 },
);

/**
 * The planner keeping a page inside the cap, with the transport cap as a backstop underneath.
 *
 * A design with many section boundaries is the case most likely to overrun a page, so it is the one
 * worth pinning: every section must be reachable by following `nextSectionIndex`, and the agent must
 * never be told something was dropped when it was not.
 */
it.effect(
  "never overruns a page, and names what it dropped if it ever does",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const created = yield* callTool("dak_canvas_create", {
          title: "Many sections",
          module: "generic",
          projectId: PROJECT_ID,
        });
        const documentId = (created.structuredContent as { documentId: string }).documentId;
        const frameId = (created.structuredContent as { starterFrameId: string }).starterFrameId;
        // Twenty explicit inserts rather than a loop: the design script is a bounded expression
        // language, not a general JS sandbox, and a test should not depend on loop support.
        const band = (i: number) =>
          `Insert("${frameId}", { id: "band${i}", type: "rectangle", x: 0, y: ${i * 300}, ` +
          `width: 390, height: 280, fill: "#e2e8f0" }); `;
        const edited = yield* callTool("dak_canvas_edit", {
          documentId,
          projectId: PROJECT_ID,
          // The frame has to be tall enough to need slicing, or twenty boundaries produce one section
          // and the paging is never exercised.
          code:
            `Update("${frameId}", { width: 390, height: 6000 }); ` +
            Array.from({ length: 20 }, (_, i) => band(i)).join("") +
            "return 20;",
        });
        expect(edited.isError, JSON.stringify(edited.content)).toBeFalsy();
        // The bands have to be there for the boundaries to exist; an edit that silently did nothing
        // would leave a short frame and make this test pass for the wrong reason.
        const listed = yield* callTool("dak_canvas_read", {
          documentId,
          projectId: PROJECT_ID,
        });
        const outline = listed.structuredContent as {
          readonly frames: ReadonlyArray<{ readonly childCount: number }>;
        };
        expect(outline.frames[0]?.childCount).toBe(20);

        type Page = {
          readonly totalSections: number;
          readonly nextSectionIndex?: number;
          readonly parts: ReadonlyArray<{ readonly role: string; readonly y: number }>;
        };

        const seen: Array<number> = [];
        let page = yield* callTool("dak_canvas_screenshot", {
          documentId,
          projectId: PROJECT_ID,
        });
        let pages = 0;
        for (;;) {
          const metadata = page.structuredContent as Page;
          pages += 1;
          const text = textBlocks(page)
            .map((entry) => entry.text)
            .join("\n");
          expect(contentOfType<ToolImageBlock>(page, "image").length).toBeLessThanOrEqual(8);
          const sections = metadata.parts.filter((part) => part.role === "section");
          if (sections.length + 1 > 8) {
            // The backstop fired, so the agent has to be told what was left behind and where it is.
            expect(text).toContain("limit");
            expect(text).toContain("paths");
          } else {
            expect(text).not.toContain("image limit");
          }
          for (const part of sections) seen.push(part.y);
          if (metadata.nextSectionIndex === undefined) break;
          page = yield* callTool("dak_canvas_screenshot", {
            documentId,
            projectId: PROJECT_ID,
            sectionIndex: metadata.nextSectionIndex,
          });
          expect(pages).toBeLessThan(20);
        }

        // Every section was reachable exactly once, so paging does not skip or repeat.
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.length).toBeGreaterThan(7);
      }),
    ).pipe(Effect.provide(layerTest)),
  { timeout: 300_000 },
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
