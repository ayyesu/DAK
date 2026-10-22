// @effect-diagnostics nodeBuiltinImport:off - reads index.css from disk so the
// test can assert the stylesheet, not JavaScript, owns the background layer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AppearanceBackgroundPreferences,
  DEFAULT_APPEARANCE_BACKGROUND,
  MAX_BACKGROUND_IMAGE_BYTES,
  applyAppearanceBackground,
  encodeBackgroundImageFile,
  hasBackgroundImage,
  MAX_BACKGROUND_OPACITY,
  MIN_BACKGROUND_OPACITY,
} from "./appearanceBackground";

/**
 * The shared image pipeline is stubbed so the size arithmetic can be asserted
 * without decoding real pixels: it takes a byte budget and returns whatever
 * fits it, which is the contract this module relies on. Hoisted because
 * `vi.mock` runs before the module under test is imported.
 */
const pipelineMock = vi.hoisted(() => ({
  seenBudgets: [] as number[],
  /** Set by a test to force the next call to fail with this reason. */
  failure: null as "too-large" | "throw" | null,
  prepare: vi.fn(),
}));

vi.mock("./lib/imageCompression", () => ({
  prepareImageForAttachment: async (file: File, maxBytes: number) => {
    pipelineMock.seenBudgets.push(maxBytes);
    if (pipelineMock.failure === "throw") throw new Error("decode failed");
    if (pipelineMock.failure === "too-large") return { ok: false, reason: "too-large" };
    return {
      ok: true,
      file: new File(["x".repeat(maxBytes)], "wallpaper.webp", { type: "image/webp" }),
      recompressed: true,
    };
  },
  readFileAsDataUrl: async (blob: Blob) => `data:${blob.type};base64,${"y".repeat(blob.size)}`,
}));

/**
 * The unit project runs without a DOM, so the root element is the small
 * surface `applyAppearanceBackground` actually touches: inline style
 * properties and the dataset flag.
 */
function root(): HTMLElement {
  const properties = new Map<string, string>();
  const attributes = new Set<string>();
  const style = {
    setProperty: (name: string, value: string) => properties.set(name, value),
    getPropertyValue: (name: string) => properties.get(name) ?? "",
    removeProperty: (name: string) => properties.delete(name),
  };
  return {
    dataset: {} as DOMStringMap,
    style,
    hasAttribute: (name: string) => attributes.has(name),
    removeAttribute: (name: string) => attributes.delete(name),
  } as unknown as HTMLElement & { dataset: DOMStringMap };
}

const PICTURE = {
  image: "data:image/png;base64,AAAA",
  opacity: 30,
  blur: 8,
  dim: 40,
  fit: "cover",
} as const;

/**
 * The picture is painted by a stylesheet rule rather than by an element this
 * module mounts, so the two halves have to agree. These assertions read
 * `index.css` and pin the parts a browser enforces silently: which element
 * carries the picture, and that nothing opaque sits on top of it.
 */
describe("index.css background picture contract", () => {
  const css = NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "index.css"),
    "utf8",
  );
  // The formatter wraps declarations across lines, so match against a
  // whitespace-collapsed copy rather than fighting its layout.
  const flat = css.replace(/\s+/g, " ");

  it("paints the picture on the root element's own background", () => {
    // The root's background is the only layer nothing can paint over except a
    // descendant with its own background. A negative-z pseudo-element instead
    // is invisible whenever anything fills body's background.
    expect(flat).toMatch(
      /html\[data-app-background\] \{[^}]*background-image: linear-gradient\(var\(--app-background-veil\)[^}]*var\(--app-background-image, none\)/,
    );
  });

  it("keeps body transparent while a picture is set", () => {
    // Body is positioned, so it paints after the root's background: an opaque
    // background-color here would cover the picture and the theme canvas.
    expect(flat).toMatch(/html\[data-app-background\] body \{[^}]*background-color: transparent/);
  });

  it("blurs the picture without depending on a pseudo-element carrying it", () => {
    // The blur is the only thing at risk if the layer fails to composite.
    expect(flat).toMatch(
      /html\[data-app-background\] body::before \{[^}]*backdrop-filter: blur\(var\(--app-background-blur, 0px\)\)/,
    );
  });

  it("lets the picture through the shells that cover the viewport", () => {
    // The two full-height shells, plus the right-hand panel. Each mixes the
    // picture in through the shared opacity token, so the slider moves every
    // shell at once instead of a hardcoded percentage per surface.
    expect(flat).toMatch(
      /html\[data-app-background\] :is\(\[data-slot="sidebar-inset"\], \[data-slot="sidebar-inner"\]\) \{[^}]*background-color: color-mix\(\s*in srgb, var\(--background\) var\(--app-background-surface\)/,
    );
    expect(flat).toMatch(
      /html\[data-app-background\] \[data-slot="sidebar-inner"\] \{[^}]*background-color: color-mix\(\s*in srgb, var\(--sidebar\) var\(--app-background-surface\)/,
    );
    expect(flat).toMatch(
      /html\[data-app-background\] \[data-panel-shell\] \{[^}]*background-color: color-mix\(\s*in srgb, var\(--background\) calc\(100% - var\(--app-background-opacity, 22%\) \/ 2\)/,
    );
  });

  it("keeps the new-thread screen's shells clear of the picture", () => {
    // The chat column fills the viewport: one opaque ancestor here would hide
    // the picture on the very screen meant to show it.
    expect(flat).toMatch(
      /html\[data-app-background\] \[data-chat-draft-hero\], html\[data-app-background\] \[data-chat-draft-hero\] \[data-timeline-loading\] \{[^}]*background-color: transparent/,
    );
  });
});

describe("hasBackgroundImage", () => {
  it("only accepts a data URL picture", () => {
    expect(hasBackgroundImage(PICTURE)).toBe(true);
    expect(hasBackgroundImage({ ...PICTURE, image: null })).toBe(false);
    expect(hasBackgroundImage({ ...PICTURE, image: "https://example.com/a.png" })).toBe(false);
    expect(hasBackgroundImage({ ...PICTURE, image: "" })).toBe(false);
  });
});

describe("applyAppearanceBackground", () => {
  it("paints the picture, its scrim, and its treatment as custom properties", () => {
    const element = root();

    applyAppearanceBackground(element, PICTURE);

    expect(element.dataset.appBackground).toBe("on");
    expect(element.style.getPropertyValue("--app-background-image")).toBe(
      `url("${PICTURE.image}")`,
    );
    expect(element.style.getPropertyValue("--app-background-opacity")).toBe("30%");
    expect(element.style.getPropertyValue("--app-background-blur")).toBe("8px");
    expect(element.style.getPropertyValue("--app-background-dim")).toBe("40%");
    expect(element.style.getPropertyValue("--app-background-fit")).toBe("cover");
  });

  it("keeps the whole frame when the picture is set to fit", () => {
    const element = root();

    applyAppearanceBackground(element, { ...PICTURE, fit: "contain" });

    expect(element.style.getPropertyValue("--app-background-fit")).toBe("contain");
  });

  it("removes every trace when no picture is set", () => {
    const element = root();
    applyAppearanceBackground(element, PICTURE);

    applyAppearanceBackground(element, { ...PICTURE, image: null });

    expect(element.hasAttribute("data-app-background")).toBe(false);
    expect(element.style.getPropertyValue("--app-background-image")).toBe("");
    expect(element.style.getPropertyValue("--app-background-opacity")).toBe("");
    expect(element.style.getPropertyValue("--app-background-blur")).toBe("");
    expect(element.style.getPropertyValue("--app-background-dim")).toBe("");
    expect(element.style.getPropertyValue("--app-background-fit")).toBe("");
  });
});

/** Compiled once: the round-trip test would otherwise rebuild it per call. */
const decodeBackgroundJson = Schema.decodeSync(
  Schema.fromJsonString(AppearanceBackgroundPreferences),
);

describe("AppearanceBackgroundPreferences", () => {
  it("round-trips a stored record through JSON", () => {
    const record = decodeBackgroundJson(JSON.stringify(PICTURE));

    expect(record).toEqual(PICTURE);
  });

  it("rejects values outside the sliders' range", () => {
    const decode = Schema.decodeUnknownOption(AppearanceBackgroundPreferences);

    expect(Option.isSome(decode(PICTURE))).toBe(true);
    expect(Option.isNone(decode({ ...PICTURE, opacity: 1 }))).toBe(true);
    expect(Option.isNone(decode({ ...PICTURE, opacity: 99 }))).toBe(true);
    expect(Option.isNone(decode({ ...PICTURE, blur: 500 }))).toBe(true);
    expect(Option.isNone(decode({ ...PICTURE, fit: "stretch" }))).toBe(true);
  });

  it("keeps the picture subtle out of the box", () => {
    expect(DEFAULT_APPEARANCE_BACKGROUND.image).toBeNull();
    expect(DEFAULT_APPEARANCE_BACKGROUND.opacity).toBeGreaterThanOrEqual(MIN_BACKGROUND_OPACITY);
    expect(DEFAULT_APPEARANCE_BACKGROUND.opacity).toBeLessThanOrEqual(MAX_BACKGROUND_OPACITY);
    expect(DEFAULT_APPEARANCE_BACKGROUND.dim).toBeGreaterThan(0);
  });
});

describe("encodeBackgroundImageFile", () => {
  beforeEach(() => {
    pipelineMock.seenBudgets.length = 0;
    pipelineMock.failure = null;
  });

  it("budgets the byte limit below the data URL budget", async () => {
    const result = await encodeBackgroundImageFile(new File(["x"], "a.png"));

    expect(result.ok).toBe(true);
    expect(pipelineMock.seenBudgets).toHaveLength(1);
    // Base64 expands bytes by 4/3, so the binary budget must be smaller than
    // the storage budget or an encoded picture overflows the origin quota.
    const budget = pipelineMock.seenBudgets[0]!;
    expect(budget).toBeLessThan(MAX_BACKGROUND_IMAGE_BYTES);
    expect((budget * 4) / 3).toBeLessThanOrEqual(MAX_BACKGROUND_IMAGE_BYTES);
  });

  it("reports an oversized picture instead of persisting it", async () => {
    pipelineMock.failure = "too-large";

    const result = await encodeBackgroundImageFile(new File(["x"], "a.png"));

    expect(result).toEqual({ ok: false, reason: "too-large" });
  });

  it("reports an unreadable file instead of throwing", async () => {
    pipelineMock.failure = "throw";

    const result = await encodeBackgroundImageFile(new File(["x"], "a.png"));

    expect(result).toEqual({ ok: false, reason: "unsupported" });
  });
});
