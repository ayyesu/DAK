// @effect-diagnostics nodeBuiltinImport:off - This test rasterizes with the real CanvasKit runtime,
// copies the committed fixture into a real temporary workspace, and reads it back off disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Project } from "@dak/contracts";
import { CanvasDocumentId, ProjectId } from "@dak/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, describe, expect } from "vite-plus/test";

import * as CanvasChangeBus from "./CanvasChangeBus.ts";
import { layerCanvasRenderLimiter, renderCanvas, subscribeCanvas } from "./CanvasSocket.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * The panel's own path, end to end, on the committed Portfolio Landing Page design.
 *
 * Every other Canvas test calls a service or the engine directly. That is what let a renderer that
 * worked perfectly in isolation fail in the live panel: nothing drove `canvas.render` and
 * `canvas.subscribe` — the two handlers `ws.ts` actually registers — on a real document, so the
 * render limiter, the project lookup and the font preload were each exercised only by a test that
 * had already stubbed whatever it was about to get wrong.
 *
 * This file is that missing test. It is in `canvas:verify` for the same reason: the gap was never a
 * flaky test, it was the verification scope.
 *
 * Cold process matters here and is why the fixture is rasterized rather than served from a warm
 * module cache: the font preload resolves once per process, so a warm run passes whether or not the
 * first measure in a fresh server has its fonts.
 */

const PROJECT_ID = ProjectId.make("project-canvas-render");

/** The PNG signature. A frame that is not a PNG is a broken view, whatever its byte count says. */
const PNG_MAGIC = "89504e470d0a1a0a";

const isPng = (base64: string): boolean =>
  Buffer.from(base64.slice(0, 16), "base64").toString("hex").startsWith(PNG_MAGIC);

const roots: string[] = [];

/**
 * A design written into a project workspace through the real store.
 *
 * Copied rather than pointed at, for the same reason every other Canvas test copies: a design lives
 * at `<workspace>/.dak/canvas/<id>/`, and the developer's own project directory is not a fixture. The
 * snapshot, projection and log are produced by the same writer the server uses, so what is rendered
 * here is what a server would render.
 */
const seedDesign = async (
  document: unknown,
  title: string,
): Promise<{ workspaceRoot: string; documentId: CanvasDocumentId }> => {
  const workspaceRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dak-canvas-render-"));
  roots.push(workspaceRoot);

  const { make: makeStore } = await import("./CanvasStoreLive.ts");
  const store = makeStore({ workspaceRoot });

  const model = (
    await import("@dak/canvas-engine/upstream/src/document-model.mjs")
  ).createDocumentModel(document);
  const state = (await import("@dak/canvas-engine/upstream/src/document-model.mjs")).encodeState(
    model,
  );
  model.doc.destroy();

  await store.createDocument({
    title,
    module: "web",
    snapshot: { throughSequence: 0, state, source: document },
    starterFrameId: (document as { children: Array<{ id: string }> }).children[0]!.id,
  });
  // The store mints its own id, so the design that exists is the one named here.
  const [created] = await store.listDocuments({});
  return { workspaceRoot, documentId: CanvasDocumentId.make(created?.id ?? "") };
};

const readPortfolioFixture = async (): Promise<any> =>
  JSON.parse(
    await NodeFSP.readFile(
      new URL("./fixtures/portfolio-landing-page.json", import.meta.url),
      "utf8",
    ),
  );

const seedPortfolioDesign = async () => {
  const fixture = await readPortfolioFixture();
  return seedDesign(fixture.document, fixture.title);
};

afterAll(async () => {
  await Promise.all(
    roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true }).catch(() => undefined)),
  );
});

/**
 * Merged rather than `Layer.provide`d: `provide` satisfies a layer's requirements without adding to
 * what it exposes, so a mock provided underneath a layer that does not itself require
 * `ProjectService` never reaches the effect — and the symptom is "Service not found" on a service
 * the layer plainly contains.
 */
const layerFor = (workspaceRoot: string) =>
  Layer.mergeAll(
    CanvasChangeBus.layer,
    layerCanvasRenderLimiter,
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === PROJECT_ID
            ? Option.some({
                id: PROJECT_ID,
                title: "Canvas",
                workspaceRoot,
                repositoryIdentity: null,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-01T00:00:00.000Z",
                updatedAt: "2026-10-01T00:00:00.000Z",
                deletedAt: null,
              } satisfies Project)
            : Option.none(),
        ),
    }),
  );

describe("the panel's canvas.render path", () => {
  effectIt.effect(
    "returns valid PNG frames for the portfolio design, through the real socket handler",
    () =>
      Effect.gen(function* () {
        const { workspaceRoot, documentId } = yield* Effect.promise(seedPortfolioDesign);
        const result = yield* renderCanvas({
          projectId: PROJECT_ID,
          documentId,
          maxEdge: 1024,
        }).pipe(Effect.provide(layerFor(workspaceRoot)));

        expect(result.title).toBe("Portfolio Landing Page");
        // Six frames in the fixture; anything less means the view silently showed a partial design.
        expect(result.frames.length).toBe(6);
        for (const frame of result.frames) {
          expect(frame.width).toBeGreaterThan(0);
          expect(frame.height).toBeGreaterThan(0);
          // The assertion that matters: a base64 string that decodes to a PNG, not merely to bytes.
          expect(isPng(frame.data)).toBe(true);
        }
      }),
    { timeout: 180_000 },
  );

  /**
   * A frame is laid out at its own size, not at the size of the bitmap.
   *
   * The portfolio design is a set of tall phone frames, so at a small edge the raster comes back
   * scaled down while the frame stays 390x1550. A client that laid out from the raster would shrink
   * every frame the moment it asked for less detail, which is the same class of bug as a frame
   * resizing with the panel.
   */
  effectIt.effect(
    "reports the design's own frame size alongside the reduced raster",
    () =>
      Effect.gen(function* () {
        const { workspaceRoot, documentId } = yield* Effect.promise(seedPortfolioDesign);

        const reduced = yield* renderCanvas({
          projectId: PROJECT_ID,
          documentId,
          maxEdge: 512,
        }).pipe(Effect.provide(layerFor(workspaceRoot)));

        const projects = reduced.frames.find((frame) => frame.nodeId === "frame-projects");
        expect(projects).toBeDefined();
        // 390x1550 in the design; the bitmap is capped by the edge.
        expect(projects?.designWidth).toBe(390);
        expect(projects?.designHeight).toBe(1550);
        expect(projects?.height).toBeLessThan(projects?.designHeight ?? 0);

        // At the ceiling the raster catches up to the design rather than exceeding it.
        const full = yield* renderCanvas({
          projectId: PROJECT_ID,
          documentId,
          maxEdge: 2048,
        }).pipe(Effect.provide(layerFor(workspaceRoot)));
        const fullFrame = full.frames.find((frame) => frame.nodeId === "frame-projects");
        expect(fullFrame?.height).toBe(1550);
        expect(fullFrame?.designHeight).toBe(1550);
      }),
    { timeout: 300_000 },
  );

  /**
   * The scale a view draws at is the scale it is rendered at.
   *
   * A frame rasterized at its own size is soft on any display whose pixel ratio is not 1, and worse
   * at zoom: the browser magnifies the bitmap, so a design shown at 200% was 100% detail drawn twice
   * as large. Asking for the scale is what the engine can act on — it renders text and shapes at
   * whatever scale it is given — so the raster comes back larger than the design, up to the ceiling.
   */
  effectIt.effect(
    "renders above the design's own size when the view asks for a scale",
    () =>
      Effect.gen(function* () {
        const { workspaceRoot, documentId } = yield* Effect.promise(seedPortfolioDesign);

        const scaled = yield* renderCanvas({
          projectId: PROJECT_ID,
          documentId,
          scale: 2,
        }).pipe(Effect.provide(layerFor(workspaceRoot)));
        expect(scaled.frames.length).toBe(6);

        const shortest = [...scaled.frames].sort((a, b) => a.designHeight - b.designHeight)[0];
        // Twice as many pixels across, not the same bitmap drawn twice as large.
        expect(shortest?.width).toBe((shortest?.designWidth ?? 0) * 2);
        // The design's own size is still what the view lays out from.
        expect(shortest?.height).toBe((shortest?.designHeight ?? 0) * 2);

        // And the ceiling still bounds it: the tallest frame is a phone screen, so it is capped below
        // the scale asked for rather than rasterized at 3100px.
        const tallest = scaled.frames.find((frame) => frame.designHeight === 1550);
        expect(tallest?.height).toBeGreaterThan(1550);
        expect(tallest?.height).toBeLessThanOrEqual(2048);

        // Below 1 the same request ships *fewer* pixels, which is the bandwidth half of the story: a
        // design fitted into a small panel no longer pays for full-size rasters nobody is looking at.
        const fitted = yield* renderCanvas({
          projectId: PROJECT_ID,
          documentId,
          scale: 0.5,
        }).pipe(Effect.provide(layerFor(workspaceRoot)));
        const fittedShortest = [...fitted.frames].sort(
          (a, b) => a.designHeight - b.designHeight,
        )[0];
        expect(fittedShortest?.width).toBe(Math.ceil((fittedShortest?.designWidth ?? 0) / 2));
      }),
    { timeout: 300_000 },
  );

  effectIt.effect(
    "reports the sequence through canvas.subscribe, so the view can tell a live design from a stale one",
    () =>
      Effect.gen(function* () {
        const { workspaceRoot, documentId } = yield* Effect.promise(seedPortfolioDesign);
        // `Stream.runHead` rather than a collect-and-take: the live half of this subscription is an
        // unbounded change stream, so anything waiting for the stream to end would wait forever.
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* subscribeCanvas({ projectId: PROJECT_ID, documentId });
            return yield* Stream.runHead(stream);
          }),
        ).pipe(Effect.provide(layerFor(workspaceRoot)));

        const item = Option.getOrNull(first);
        expect(item).not.toBeNull();
        expect(item?.kind).toBe("sequence");
        expect(typeof item?.sequence).toBe("number");
      }),
    { timeout: 180_000 },
  );

  effectIt.effect(
    "refuses a design this environment does not have, rather than failing on the engine",
    () =>
      Effect.gen(function* () {
        const { workspaceRoot } = yield* Effect.promise(seedPortfolioDesign);
        const error = yield* Effect.flip(
          renderCanvas({
            projectId: PROJECT_ID,
            documentId: CanvasDocumentId.make("design-does-not-exist"),
            maxEdge: 1024,
          }),
        ).pipe(Effect.provide(layerFor(workspaceRoot)));
        expect(error.code).toBe("document_not_found");
      }),
    { timeout: 180_000 },
  );

  /**
   * A design naming a face DAK does not ship must still render.
   *
   * `assertFontsAvailable` is right to refuse to *measure* against a face that was never loaded — a
   * fallback silently produces a plausible height that nothing contradicts. But that refusal sits
   * inside `normalizeForRender`, which every render path funnels through, so an unshipped family
   * took the whole panel down rather than one text node. The user loses the entire design because
   * one headline is set in a face DAK does not have.
   *
   * The fix is a visible fallback on the render path and a `font_unavailable` issue from inspect,
   * with the hard `CANVAS_UNKNOWN_FONT` failure kept on the edit path, where it tells the agent to
   * change the font rather than teaching it that a typo is a valid design.
   */
  effectIt.effect(
    "still renders a design that names a font DAK does not ship",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(readPortfolioFixture);
        const document = structuredClone(fixture.document);
        // The portfolio design names no family at all, so this is the only font declaration in it —
        // which is what makes the case sharp: one node, one bad family, whole panel at stake.
        const [firstFrame] = document.children;
        firstFrame.children.push({
          type: "text",
          id: "unshipped-font-probe",
          content: "Shipped in no font DAK has",
          paragraphs: [{ from: 0, to: 25 }],
          x: 16,
          y: 16,
          width: 320,
          fontSize: 18,
          fontFamily: "Nonexistent Grotesk",
          fill: "#111111",
        });

        const { workspaceRoot, documentId } = yield* Effect.promise(() =>
          seedDesign(document, "Unshipped font design"),
        );
        const result = yield* renderCanvas({
          projectId: PROJECT_ID,
          documentId,
          maxEdge: 1024,
        }).pipe(Effect.provide(layerFor(workspaceRoot)));

        expect(result.frames.length).toBeGreaterThan(0);
        for (const frame of result.frames) {
          expect(isPng(frame.data)).toBe(true);
        }
      }),
    { timeout: 180_000 },
  );
});
