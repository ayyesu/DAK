// @effect-diagnostics nodeBuiltinImport:off - Measures with the real engine against the shipped faces.
import { describe, expect, it } from "vite-plus/test";

import {
  CanvasUnknownFontError,
  loadedFamilies,
  measureTextNodes,
  nearestFamily,
  substituteMissingFonts,
  textNodeIds,
  unavailableFontsByFamily,
  withMeasuredWrap,
} from "./canvasText.ts";
import { normalizeForRender } from "./canvasNormalize.ts";
import { findUnavailableFonts } from "./canvasInspect.ts";
import { make as makeEngine } from "./CanvasEngineLive.ts";

/**
 * The engine is built for its side effects, not its return value: constructing it registers the host
 * font loader and preloads every shipped face into the engine's cache. Without it the measurer can
 * only see Inter, so `nearestFamily` would have nothing to suggest and every substitution would land
 * on the fallback — which would make these tests pass for the wrong reason.
 */
makeEngine();

/**
 * A face DAK does not ship has two opposite correct answers, and the difference is who can act.
 *
 * An agent that writes `fontFamily: "Playfair"` can be told, immediately, and should be: measuring it
 * silently against Inter teaches it that a typo is a design. A person opening that design cannot fix
 * it, and a panel that refused to draw would lose the whole page over one headline. So the edit path
 * throws and the render path substitutes — and then has to say so, or the substitution is invisible.
 */

const doc = (family: string) => ({
  children: [
    {
      id: "frame-1",
      type: "frame",
      name: "Home",
      width: 390,
      height: 844,
      children: [
        {
          id: "headline",
          type: "text",
          content: "Shipped in no font DAK has",
          paragraphs: [{ from: 0, to: 25 }],
          x: 0,
          y: 0,
          width: 300,
          fontSize: 20,
          fontFamily: family,
        },
        {
          id: "body",
          type: "text",
          content: "This one is fine",
          paragraphs: [{ from: 0, to: 15 }],
          x: 0,
          y: 40,
          width: 300,
          fontSize: 14,
          fontFamily: "Inter",
        },
      ],
    },
  ],
});

const loadedFor = async (document: unknown) =>
  loadedFamilies(await measureTextNodes(document, textNodeIds(document)));

describe("a family DAK does not ship", () => {
  it("refuses to measure on the edit path, naming the family and the nearest match", async () => {
    // `normalizeForRender` defaults to throwing, which is what the edit path gets.
    let thrown: unknown;
    try {
      await normalizeForRender(doc("Playfair"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CanvasUnknownFontError);
    expect((thrown as CanvasUnknownFontError).family).toBe("Playfair");
    expect(nearestFamily("Playfair", (thrown as CanvasUnknownFontError).available)).toBe(
      "Playfair Display",
    );
  });

  it("still refuses through withMeasuredWrap's default, so no caller gets leniency by accident", async () => {
    await expect(withMeasuredWrap(doc("Playfair"))).rejects.toBeInstanceOf(CanvasUnknownFontError);
  });

  it("renders instead, on the view path, in the nearest shipped face", async () => {
    const rendered = (await normalizeForRender(doc("Playfair"), "substitute")) as {
      children: Array<{ children: Array<{ id: string; fontFamily: string; height?: number }> }>;
    };
    const nodes = rendered.children[0]!.children;
    expect(nodes.find((n) => n.id === "headline")?.fontFamily).toBe("Playfair Display");
    // The frame that named a shipped family is left exactly as it was.
    expect(nodes.find((n) => n.id === "body")?.fontFamily).toBe("Inter");
  });

  it("re-measures after substituting, so the rescued text is not clipped", async () => {
    // The substituted family has its own metrics. Carrying a height measured against the fallback
    // would clip exactly the text the substitution was meant to save.
    const rendered = (await normalizeForRender(doc("Playfair"), "substitute")) as {
      children: Array<{ children: Array<{ id: string; fontSize: number; height?: number }> }>;
    };
    const headline = rendered.children[0]!.children.find((n) => n.id === "headline");
    expect(headline?.height).toBeGreaterThan(0);
    // Tall enough for its own font size: a one-line height would be the fallback's number carried over.
    expect(headline?.height).toBeGreaterThanOrEqual((headline?.fontSize ?? 0) * 1.2);
  });

  it("leaves a document that only uses shipped families completely untouched", async () => {
    const good = (await normalizeForRender(doc("Inter"), "substitute")) as {
      children: Array<{ children: Array<{ id: string; fontFamily: string }> }>;
    };
    expect(good.children[0]!.children.map((n) => n.fontFamily)).toEqual(["Inter", "Inter"]);
  });
});

describe("reporting a substituted family", () => {
  it("names the family the author actually wrote, from the document before substitution", async () => {
    // After substitution the document no longer says "Playfair", so the fact has to be
    // read from the input. This is that read.
    const original = doc("Playfair");
    const shipped = await loadedFor(original);
    const missing = unavailableFontsByFamily(original, shipped);
    expect(missing).toEqual([{ family: "Playfair", nodeIds: ["headline"] }]);
  });

  it("produces an issue with a fix that names a shipped family", () => {
    const shipped = ["Inter", "Playfair Display", "Space Grotesk"];
    const issues = findUnavailableFonts(
      [{ family: "Playfair", nodeIds: ["headline", "sub"] }],
      shipped,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("font_unavailable");
    expect(issues[0]?.severity).toBe("major");
    expect(issues[0]?.nodeIds).toEqual(["headline", "sub"]);
    // The fix has to be actionable: it names the closest family the agent can actually set.
    expect(issues[0]?.fix).toContain("Playfair Display");
  });

  it("says Inter when there is no closer match, rather than leaving the agent to guess", () => {
    const issues = findUnavailableFonts([{ family: "Zapfino", nodeIds: ["a"] }], ["Inter"]);
    expect(issues[0]?.fix).toContain("Inter");
  });

  it("reports nothing for a document that only uses shipped families", () => {
    expect(
      findUnavailableFonts(unavailableFontsByFamily(doc("Inter"), ["Inter"]), ["Inter"]),
    ).toEqual([]);
  });
});

describe("the substitution itself", () => {
  it("replaces only the nodes that asked for the missing family", () => {
    const document = doc("Playfair");
    const replaced = substituteMissingFonts(document, new Set(["Playfair"]), ["Inter"]);
    expect(replaced).toEqual(["Playfair"]);
    const nodes = (
      document as { children: Array<{ children: Array<{ id: string; fontFamily: string }> }> }
    ).children[0]!.children;
    expect(nodes.find((n) => n.id === "body")?.fontFamily).toBe("Inter");
  });

  it("does nothing when nothing is missing", () => {
    const document = doc("Inter");
    expect(substituteMissingFonts(document, new Set(), ["Inter"])).toEqual([]);
    expect(
      (document as { children: Array<{ children: Array<{ fontFamily: string }> }> }).children[0]!
        .children[0]!.fontFamily,
    ).toBe("Inter");
  });
});
