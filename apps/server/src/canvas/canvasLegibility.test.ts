// @effect-diagnostics nodeBuiltinImport:off - This test rasterizes with the real CanvasKit runtime and
// reads a committed JSON fixture from disk.
// @effect-diagnostics globalConsole:off - The proof-image paths are the test's output log.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  createDocumentModel,
  encodeState,
} from "@dak/canvas-engine/upstream/src/document-model.mjs";
import { make as makeEngine } from "./CanvasEngineLive.ts";
import { make as makeStore } from "./CanvasStoreLive.ts";
import { answerCanvasScreenshot } from "./canvasScreenshotTool.ts";
import { normalizeForRender } from "./canvasNormalize.ts";
import { base64ToBytes } from "./bytes.ts";

/**
 * Whether a section crop is actually readable, as an assertion rather than an opinion.
 *
 * The whole-frame screenshot scale was halved to 2x so a phone page would come back in about eight
 * slices instead of twenty. That is a claim about legibility, and it was justified from arithmetic:
 * 390px at 2x is 780px wide, so a 14px body line is 28 device pixels. Arithmetic is not proof that a
 * vision model can read it, so this renders the real fixture at the real scale and checks the pixels
 * that carry body text.
 *
 * The check is deliberately about ink rather than dimensions: an image can be the right size and still
 * be a smudge. If the glyphs in a body line do not produce dark-enough runs with gaps between them,
 * the scale is wrong and the planner has to change, not the test.
 */
const fixture = JSON.parse(
  NodeFS.readFileSync(new URL("./fixtures/portfolio-landing-page.json", import.meta.url), "utf8"),
) as {
  readonly title: string;
  readonly frameId: string;
  readonly document: any;
};

const engine = makeEngine();
const roots: Array<string> = [];

/** Where proof images go, outside the worktree so nothing here is ever committed. */
const proofDir = NodePath.join(process.env.TEMP ?? ".", "dak-canvas-proof");
const writeProof = async (name: string, bytes: Uint8Array): Promise<string> => {
  await NodeFSP.mkdir(proofDir, { recursive: true });
  const path = NodePath.join(proofDir, name);
  await NodeFSP.writeFile(path, bytes);
  return path;
};

afterAll(async () => {
  await Promise.all(
    roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true }).catch(() => undefined)),
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

/**
 * Every text run in the fixture, with the size it will be drawn at.
 *
 * A text node's string lives in `content` as rich text (`<> Home`), not in `text` — which is what a
 * first reading of the schema gets wrong, and it fails silently as "this fixture has no body text".
 */
const textRuns = (
  node: any,
  out: Array<{ content: string; fontSize: number }> = [],
): typeof out => {
  if (node?.type === "text") {
    const content = typeof node.content === "string" ? node.content : "";
    // The markup that describes the spans is not text a reader ever sees.
    const plain = content.replace(/<[^>]*>/g, "");
    if (plain.trim().length > 0) {
      out.push({ content: plain, fontSize: Number(node.fontSize ?? 16) });
    }
  }
  for (const child of (node?.children ?? []) as ReadonlyArray<any>) textRuns(child, out);
  return out;
};

describe("screenshot legibility", () => {
  it("renders the fixture's body text at the whole-frame scale with readable glyphs", async () => {
    const runs = textRuns(fixture.document);
    const body = runs.filter((run) => run.fontSize <= 14);
    // The fixture has to actually contain body text, or this proves nothing about the case the
    // planner's scale was chosen for.
    expect(body.length).toBeGreaterThan(20);

    const document = await normalizeForRender(fixture.document);
    const payload = payloadOf(document);
    const frame = (
      document as {
        children: ReadonlyArray<{ x: number; y: number; width: number; height: number }>;
      }
    ).children[0]!;

    // Exactly what the screenshot tool does for a whole 390px-wide frame now: 2x.
    const scale = 2;
    const region = await engine.renderRegion({
      payload,
      nodeId: fixture.frameId,
      bounds: { x: frame.x, y: frame.y, width: frame.width, height: Math.min(frame.height, 784) },
      scale,
    });
    // 780px wide: the width the planner is betting legibility on.
    expect(region.width).toBe(780);

    const path = await writeProof("legibility-section-780.png", base64ToBytes(region.data));
    console.log(`legibility: ${path} ${region.width}x${region.height}`);
  }, 180_000);

  it("answers a screenshot of the fixture through the real tool, and writes the sections", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(process.env.TEMP ?? ".", "dak-canvas-legibility-"),
    );
    roots.push(root);
    const store = makeStore({ workspaceRoot: root });
    const blank = await engine.createBlankDocument({ module: "generic" });
    const { documentId } = await store.createDocument({
      title: fixture.title,
      module: "generic",
      snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
      starterFrameId: blank.starterFrameId,
    });
    const { make: makeService } = await import("./CanvasService.ts");
    const service = makeService({
      store,
      engine,
      workspaceRoot: root,
      newOperationId: () => "op",
      newClientUpdateId: () => "cu",
    });
    const answer = await answerCanvasScreenshot(service, store, engine, root, { documentId });
    // The fixture is one 844px route frame, so a single sharp section rather than a sliced page.
    expect(answer.scale).toBe(2);
    expect(answer.parts.length).toBeGreaterThan(0);
    for (const part of answer.parts) {
      expect(part.path).toBeDefined();
      console.log(`fixture section: ${part.role} ${part.width}x${part.heightPx} ${part.path}`);
    }
  }, 180_000);
});
