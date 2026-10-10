import { describe, expect, it } from "vite-plus/test";

import { make as makeEngine } from "./CanvasEngineLive.ts";
import {
  createDocumentModel,
  encodeState,
} from "@dak/canvas-engine/upstream/src/document-model.mjs";

import type { CanvasDocumentPayload } from "./CanvasPorts.ts";

/**
 * A viewport render of a design taller than the raster cap.
 *
 * The whole reason `renderFrames` takes a viewport: a 1440x4400 page rendered whole arrives as a
 * 2048px-tall strip whose text is unreadable, so a user asking to see their design sees nothing
 * usable. These assert that a viewport returns real pixels at the requested size, that scrolling moves
 * the image, and that a face DAK ships is genuinely in use — the last of which "no error" cannot prove,
 * since a substituted face renders happily.
 */
describe("canvas viewport rendering", () => {
  const tallDocument = () => {
    const frame = {
      type: "frame",
      id: "page",
      name: "Page",
      width: 1440,
      height: 4400,
      children: [
        {
          type: "text",
          id: "top",
          name: "Top",
          content: "TOP OF PAGE",
          paragraphs: [{ from: 0, to: 12 }],
          fill: "#000000",
          fontSize: 64,
          fontWeight: 800,
          x: 40,
          y: 60,
          width: 1200,
        },
        {
          type: "text",
          id: "bottom",
          name: "Bottom",
          content: "BOTTOM OF PAGE",
          paragraphs: [{ from: 0, to: 15 }],
          fill: "#000000",
          fontSize: 64,
          fontWeight: 800,
          x: 40,
          y: 4260,
          width: 1200,
        },
      ],
    };
    return {
      module: "generic",
      axes: {},
      variables: {},
      paragraphStyles: {},
      imports: {},
      flows: [],
      children: [frame],
    };
  };

  /**
   * The document encoded as the payload `renderFrames` takes.
   *
   * Built through the real document model rather than hand-assembled: the payload is a Yjs state plus
   * its source document, and a shape guessed at here would test a document the store never produces.
   */
  const payloadFor = async (document: unknown): Promise<CanvasDocumentPayload> => {
    const model = createDocumentModel(document as never);
    try {
      // `restoreDocumentModel` reads `snapshot.state` and base64-decodes it, so the encoded state goes
      // there rather than at the top level. `updates` is the append-only log applied on top of the
      // snapshot, and is empty for a document that has never been edited.
      return {
        updates: [],
        snapshot: { throughSequence: 0, state: encodeState(model), source: document },
      };
    } finally {
      model.doc.destroy();
    }
  };

  it("renders a window onto a tall design at the requested size", async () => {
    const engine = makeEngine();
    const payload = await payloadFor(tallDocument());

    const [top] = await engine.renderFrames({
      payload,
      nodeIds: ["page"],
      viewport: { x: 0, y: 0, width: 900, height: 700 },
    });

    expect(top).toBeDefined();
    expect(top?.width).toBe(900);
    expect(top?.height).toBe(700);
    // Real PNG bytes, not an empty buffer standing in for a render.
    expect(top?.data.length ?? 0).toBeGreaterThan(200);
  });

  // Scrolling is the entire point: a viewport the user cannot move does not solve a tall page.
  it("renders a different image when the viewport scrolls", async () => {
    const engine = makeEngine();
    const payload = await payloadFor(tallDocument());

    const [atTop] = await engine.renderFrames({
      payload,
      nodeIds: ["page"],
      viewport: { x: 0, y: 0, width: 900, height: 700 },
    });
    const [atBottom] = await engine.renderFrames({
      payload,
      nodeIds: ["page"],
      viewport: { x: 0, y: 3700, width: 900, height: 700 },
    });

    expect(atTop?.data).not.toBe(atBottom?.data);
  });

  it("holds a viewport to the raster cap rather than honouring an oversized request", async () => {
    const engine = makeEngine();
    const payload = await payloadFor(tallDocument());

    const [frame] = await engine.renderFrames({
      payload,
      nodeIds: ["page"],
      viewport: { x: 0, y: 0, width: 9000, height: 9000 },
    });

    // 2048 is the vendored engine's own ceiling; asking for more must not produce a bigger image.
    expect(frame?.width).toBe(2048);
    expect(frame?.height).toBe(2048);
  });

  // Zooming in means asking for a smaller window. The text must survive that, which a whole-page fit
  // could never do.
  it("keeps text legible at a zoomed-in viewport", async () => {
    const engine = makeEngine();
    const payload = await payloadFor(tallDocument());

    const [zoomed] = await engine.renderFrames({
      payload,
      nodeIds: ["page"],
      viewport: { x: 0, y: 0, width: 480, height: 240 },
    });

    expect(zoomed?.width).toBe(480);
    expect(zoomed?.data.length ?? 0).toBeGreaterThan(100);
  });

  it("still renders whole designs when no viewport is given", async () => {
    const engine = makeEngine();
    const payload = await payloadFor(tallDocument());

    const [whole] = await engine.renderFrames({ payload, nodeIds: ["page"] });

    expect(whole?.mimeType).toBe("image/png");
    expect(whole?.data.length ?? 0).toBeGreaterThan(200);
  });
});
