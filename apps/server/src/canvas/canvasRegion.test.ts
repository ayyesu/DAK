// @effect-diagnostics nodeBuiltinImport:off - This test rasterizes with the real CanvasKit runtime and
// reads a committed JSON fixture from disk.
import * as NodeFS from "node:fs";

import { it as effectIt } from "@effect/vitest";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  createDocumentModel,
  encodeState,
} from "@dak/canvas-engine/upstream/src/document-model.mjs";
import { Effect } from "effect";

import { make as makeEngine } from "./CanvasEngineLive.ts";
import { make as makeStore } from "./CanvasStoreLive.ts";
import { make as makeCanvasService } from "./CanvasService.ts";
import { normalizeForRender } from "./canvasNormalize.ts";

/**
 * `renderRegion` is the one raster primitive.
 *
 * The test that matters is the first one: if a region is not byte-identical to the same part of a
 * whole-frame render, then a screenshot, an export and a future tile are three different pictures of
 * one design, and every comparison the user makes between them is a lie.
 */

const fixture = JSON.parse(
  NodeFS.readFileSync(new URL("./fixtures/portfolio-landing-page.json", import.meta.url), "utf8"),
) as {
  readonly title: string;
  readonly module: "web";
  readonly frameId: string;
  readonly document: any;
};

const engine = makeEngine();
const roots: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const root = await NodeFS.promises.mkdtemp(`${process.env.TEMP ?? "."}/dak-canvas-region-`);
  roots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    roots.map((root) =>
      NodeFS.promises.rm(root, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

const payloadOf = (document: unknown) => {
  const model = createDocumentModel(document);
  try {
    return {
      snapshot: { throughSequence: 0, state: encodeState(model), source: document },
      updates: [],
    };
  } finally {
    model.doc.destroy();
  }
};

const serviceOver = async () => {
  const root = await makeWorkspace();
  const store = makeStore({ workspaceRoot: root });
  const blank = await engine.createBlankDocument({ module: "generic" });
  const { documentId } = await store.createDocument({
    title: fixture.title,
    module: "generic",
    snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
    starterFrameId: blank.starterFrameId,
  });
  return { documentId, service: makeService({ store, workspaceRoot: root }) };
};

const makeService = (deps: { store: ReturnType<typeof makeStore>; workspaceRoot: string }) =>
  makeCanvasService({
    store: deps.store,
    engine,
    workspaceRoot: deps.workspaceRoot,
    newOperationId: () => "op",
    newClientUpdateId: () => "cu",
  });

describe("renderRegion", () => {
  it("renders a region byte-identical to the same region of a whole-frame render", async () => {
    const payload = payloadOf(await normalizeForRender(fixture.document));
    const frameId = fixture.frameId;
    const frame = (fixture.document as any).children[0];

    // The whole frame at 1x.
    const whole = await engine.renderFrames({ payload, nodeIds: [frameId], maxEdge: 10_000 });
    expect(whole[0]?.width).toBe(frame.width);
    expect(whole[0]?.height).toBe(frame.height);

    // The same pixels requested as an explicit region equal to the frame's own bounds.
    const region = await engine.renderRegion({
      payload,
      nodeId: frameId,
      bounds: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      scale: 1,
    });

    expect(region.width).toBe(whole[0]?.width);
    expect(region.height).toBe(whole[0]?.height);
    // Exact, not approximate: the same bounds through the same path must produce the same bytes.
    expect(region.data).toBe(whole[0]?.data);
  }, 120_000);

  it("renders a sub-region at the size it asks for", async () => {
    const payload = payloadOf(await normalizeForRender(fixture.document));
    const frame = (fixture.document as any).children[0];
    const region = await engine.renderRegion({
      payload,
      nodeId: fixture.frameId,
      bounds: { x: frame.x, y: frame.y + 200, width: frame.width, height: 400 },
      scale: 1,
    });
    expect(region.width).toBe(frame.width);
    expect(region.height).toBe(400);
    expect(region.mimeType).toBe("image/png");
  }, 120_000);

  it("scales a region, so a phone page is legible on a retina panel", async () => {
    const payload = payloadOf(await normalizeForRender(fixture.document));
    const frame = (fixture.document as any).children[0];
    const at2x = await engine.renderRegion({
      payload,
      nodeId: fixture.frameId,
      bounds: { x: frame.x, y: frame.y, width: frame.width, height: 400 },
      scale: 2,
    });
    expect(at2x.width).toBe(frame.width * 2);
    expect(at2x.height).toBe(800);
  }, 120_000);

  it("refuses a region past the raster cap instead of quietly returning a strip", async () => {
    const payload = payloadOf(await normalizeForRender(fixture.document));
    await expect(
      engine.renderRegion({
        payload,
        nodeId: fixture.frameId,
        bounds: { x: 0, y: 0, width: 20_000, height: 20_000 },
        scale: 1,
      }),
    ).rejects.toThrow(/8192/);
  }, 120_000);

  it("reports a tall region at scale 1 rather than fitting it to an edge", async () => {
    // The whole reason this primitive exists: a 1210px-tall section at 1x is 1210px, not fitted
    // down to a thumbnail because some caller wanted a long edge.
    const payload = payloadOf(await normalizeForRender(fixture.document));
    const blog = (fixture.document as any).children.find((frame: any) => frame.id === "frame-blog");
    expect(blog).toBeDefined();
    const region = await engine.renderRegion({
      payload,
      nodeId: blog.id,
      bounds: { x: blog.x, y: blog.y, width: blog.width, height: blog.height },
      scale: 1,
    });
    expect(region.height).toBe(blog.height);
    expect(region.width).toBe(blog.width);
  }, 120_000);

  effectIt.effect("refuses an oversized region through the service with a readable failure", () =>
    Effect.gen(function* () {
      const { documentId, service } = yield* Effect.promise(serviceOver);
      const outcome = yield* service
        .renderRegion({
          documentId,
          nodeId: fixture.frameId,
          bounds: { x: 0, y: 0, width: 30_000, height: 30_000 },
          scale: 1,
        })
        .pipe(Effect.flip);
      expect(outcome.code).toBe("region_too_large");
      expect(outcome.message).toContain("8192");
    }).pipe(Effect.timeout("120 seconds")),
  );
});
