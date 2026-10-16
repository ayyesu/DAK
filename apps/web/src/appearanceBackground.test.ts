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

const decodePreferencesJson = Schema.decodeSync(
  Schema.fromJsonString(AppearanceBackgroundPreferences),
);

describe("AppearanceBackgroundPreferences", () => {
  it("round-trips a stored record through JSON", () => {
    expect(decodePreferencesJson(JSON.stringify(PICTURE))).toEqual(PICTURE);
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
