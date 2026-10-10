// @effect-diagnostics nodeBuiltinImport:off - This test rasterizes with the real CanvasKit runtime,
// creates real temporary directories, and reads a committed JSON fixture from disk.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CanvasModule } from "@dak/contracts";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  createDocumentModel,
  encodeState,
} from "@dak/canvas-engine/upstream/src/document-model.mjs";

import { make as makeEngine } from "./CanvasEngineLive.ts";
import {
  authoritativeSequence,
  detectFrameOverflow,
  detectModuleViewportMismatch,
} from "./canvasInvariants.ts";
import { NORMALIZE_VERSION, normalizeForRender } from "./canvasNormalize.ts";
import {
  absoluteBoxes,
  CanvasUnknownFontError,
  findEmptyButtonShapes,
  measureTextNodes,
  textNodeIds,
} from "./canvasText.ts";
import { make as makeStore } from "./CanvasStoreLive.ts";

/**
 * Step 0 acceptance, on a copy of the portfolio fixture.
 *
 * The two things this design actually gets wrong — an unlabelled navigation button, and a phone-width
 * design declared as `web` — are fixed here through real `execute` edits, and the detectors are then
 * required to come back silent. The developer's own design is never touched: every document in this
 * file is built in a temporary directory from the committed fixture.
 */

const fixture = JSON.parse(
  NodeFS.readFileSync(new URL("./fixtures/portfolio-landing-page.json", import.meta.url), "utf8"),
) as { readonly title: string; readonly module: CanvasModule; readonly document: any };

const engine = makeEngine();
const roots: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dak-canvas-step0-"));
  roots.push(root);
  return root;
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
 * Everything the detectors say about a document, which is what inspect will report.
 *
 * Measured, because a text node with no measured box has no position to be tested for overlap, and
 * then every small filled shape in the design reads as an unlabelled button.
 */
const allIssues = async (document: unknown) => {
  const normalized = (await normalizeForRender(document)) as never;
  const measured = await measureTextNodes(normalized, textNodeIds(normalized));
  return [
    ...detectFrameOverflow(normalized),
    ...detectModuleViewportMismatch(normalized),
    ...findEmptyButtonShapes(normalized, absoluteBoxes(normalized, measured)).map((shape) => ({
      nodeId: shape.id,
      kind: "empty_control",
      severity: "major",
    })),
  ];
};

const findNode = (root: any, id: string): any =>
  root?.id === id
    ? root
    : (root?.children ?? []).map((child: any) => findNode(child, id)).find(Boolean);

describe("step 0 acceptance on a copy of the portfolio design", () => {
  it("fixes the unlabelled navigation button, and proves the viewport mismatch is not fixable in place", async () => {
    // The two real problems on the fixture, before anything is changed.
    const before = await allIssues(fixture.document);
    expect(before.filter((issue) => issue.kind === "empty_control")).toHaveLength(1);
    expect(before.filter((issue) => issue.kind === "viewport_mismatch")).toHaveLength(1);

    // --- Fix 1: label the navigation button, through a real execute.
    //
    // A rectangle cannot hold children, so a label cannot simply be inserted into the shape: it
    // has to become a frame. That is the only way this is fixable, and worth knowing before an
    // agent spends an edit discovering it.
    const labelled = await engine.execute({
      payload: payloadOf(fixture.document),
      code: `
const shape = Get("nav-cta")[0];
Replace("nav-cta", {
  id: "nav-cta", type: "frame", name: "Hire me",
  x: shape.node.x, y: shape.node.y, width: shape.node.width, height: shape.node.height,
  fill: shape.node.fill, cornerRadius: shape.node.cornerRadius,
  children: [{ id: "nav-cta-label", type: "text", content: "Hire me",
    paragraphs: [{ from: 0, to: 7 }],
    x: 9, y: 11, width: 26, fontSize: 11, fill: "#ffffff" }],
});
return Get("nav-cta-label").length;
`,
      module: fixture.module,
    });
    expect(labelled.changed).toBe(true);
    expect(findNode(labelled.document, "nav-cta").type).toBe("frame");

    const afterLabel = await allIssues(labelled.document);
    expect(afterLabel.filter((issue) => issue.kind === "empty_control")).toEqual([]);

    // --- Fix 2: the viewport. SetModule cannot do this, and the reason matters more than the fix.
    //
    // The sandbox refuses a module change unless the document is `generic`, and refuses it again
    // if any frame carries a role. This design is `web` and all six frames are `role: "route"`,
    // so the module is fixed at creation and the design cannot be converted in place at all.
    const refusal = await engine
      .execute({
        payload: payloadOf(labelled.document),
        code: `return SetModule("mobile");`,
        module: fixture.module,
      })
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(refusal).toMatch(/generic/);

    // The only conversion that exists is to build the design again with the right module. Once
    // it is, every detector is silent: the acceptance the whole of step 0 exists to reach.
    const rebuilt = {
      ...(labelled.document as Record<string, unknown>),
      module: "mobile",
      children: (labelled.document as { children: Array<Record<string, unknown>> }).children.map(
        ({ role: _role, ...frame }) => frame,
      ),
    };
    expect(await allIssues(rebuilt)).toEqual([]);

    // And the labelled document is down to the one problem that cannot be fixed where it stands.
    const remaining = await allIssues(labelled.document);
    expect(remaining.filter((issue) => issue.kind === "empty_control")).toEqual([]);
    expect(remaining.filter((issue) => issue.kind === "viewport_mismatch")).toHaveLength(1);
  }, 120_000);

  it("advances the sequence by exactly one for one edit, with no measured heights committed", async () => {
    const root = await makeWorkspace();
    const store = makeStore({ workspaceRoot: root });
    const blank = await engine.createBlankDocument({ module: "generic" });
    const { documentId } = await store.createDocument({
      title: fixture.title,
      module: "generic",
      snapshot: { throughSequence: 0, state: blank.state, source: blank.document },
      starterFrameId: blank.starterFrameId,
    });

    // The fixture carries 78 text nodes and none of them has a height yet.
    const ids = textNodeIds(fixture.document);
    expect(ids.length).toBeGreaterThan(70);
    expect(ids.filter((id) => typeof findNode(fixture.document, id)?.height === "number")).toEqual(
      [],
    );

    const edit = await engine.execute({
      payload: payloadOf(fixture.document),
      code: `Update("hero-badge", { fill: "#16a34a" });`,
      module: "generic",
    });
    expect(edit.changed).toBe(true);

    // The committed document is exactly what the script produced: one mutation, no derived heights.
    const committedIds = textNodeIds(edit.document);
    expect(
      committedIds.filter((id) => typeof findNode(edit.document, id)?.height === "number"),
    ).toEqual([]);

    const appended = await store.appendUpdate({
      documentId,
      clientUpdateId: "one-edit",
      update: edit.forward,
      operationId: "op-one",
      inverseUpdate: edit.inverse,
      expectedSequence: 0,
    });
    expect(appended.sequence).toBe(1);

    const after = await store.getDocumentForExecution(documentId);
    expect(after.summary.sequence).toBe(1);
    expect(authoritativeSequence(after.payload)).toBe(1);
  });

  it("honours an explicit height an author set alongside fixed-width growth", async () => {
    const document = {
      module: "generic",
      axes: {},
      variables: {},
      paragraphStyles: {},
      imports: {},
      flows: [],
      children: [
        {
          type: "frame",
          id: "f",
          x: 0,
          y: 0,
          width: 390,
          height: 300,
          children: [
            {
              type: "text",
              id: "authored",
              content: "An author set this box themselves and it is not ours to change",
              x: 16,
              y: 16,
              width: 358,
              height: 20,
              textGrowth: "fixed-width-height",
              fontSize: 18,
              fill: "#000000",
            },
          ],
        },
      ],
    };
    const normalized = (await normalizeForRender(document)) as any;
    expect(findNode(normalized, "authored").height).toBe(20);
    expect(findNode(normalized, "authored").textGrowth).toBe("fixed-width-height");
  });

  it("carries its normalization version so a changed rule cannot reuse a cached document", () => {
    expect(NORMALIZE_VERSION).toBeGreaterThan(0);
  });

  it("refuses an unshipped font as unknown_font and never measures it with a fallback", async () => {
    // Measured first, so the assertion is about what really happens and not about what we hope.
    const built = (fontFamily: string) => ({
      module: "generic",
      axes: {},
      variables: {},
      paragraphStyles: {},
      imports: {},
      flows: [],
      children: [
        {
          type: "frame",
          id: "f",
          x: 0,
          y: 0,
          width: 390,
          height: 200,
          children: [
            {
              type: "text",
              id: "t",
              content: "Set in a face we do not ship at all",
              paragraphs: [{ from: 0, to: 30 }],
              x: 16,
              y: 16,
              width: 358,
              fontSize: 20,
              fontFamily,
              fill: "#000000",
            },
          ],
        },
      ],
    });

    // The control: a face DAK does ship measures normally.
    const shipped = await measureTextNodes(await normalizeForRender(built("Inter")), ["t"]);
    expect(shipped.get("t")?.derivedHeight).toBeGreaterThan(0);

    // The case under test: it must throw, name the family, and never return a height.
    let thrown: unknown;
    try {
      await normalizeForRender(built("Nonexistent Grotesk"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CanvasUnknownFontError);
    const error = thrown as CanvasUnknownFontError;
    expect(error.code).toBe("CANVAS_UNKNOWN_FONT");
    expect(error.family).toBe("Nonexistent Grotesk");
    // It has to say what it could have used instead, or the author is left guessing.
    expect(error.available).toContain("Inter");
    expect(error.message).toContain("Nonexistent Grotesk");
    expect(error.message).toContain("Inter");
  });
});
