/**
 * Background picture support for Settings → Appearance.
 *
 * The picture is a per-device preference rather than a client setting: it lives
 * in localStorage beside the custom theme library so a multi-megabyte wallpaper
 * never crosses the websocket with the rest of the user's configuration, and it
 * follows the machine that owns the screen instead of the account.
 *
 * The palette itself stays authoritative. When a picture is set the shell only
 * lets it through the large surfaces (sidebar, chat column, panels); cards,
 * popovers, code and the terminal stay opaque so text contrast never depends on
 * the user's choice of photo.
 */

import * as Schema from "effect/Schema";

import { prepareImageForAttachment, readFileAsDataUrl } from "./lib/imageCompression";

export const APPEARANCE_BACKGROUND_STORAGE_KEY = "dak:appearance-background:v1";

/** Ceiling on the persisted data URL, inside the ~5MB origin quota. */
export const MAX_BACKGROUND_IMAGE_BYTES = 2_250_000;

/** Largest picture accepted, in megabytes of source file, for the error copy. */
export const MAX_BACKGROUND_IMAGE_FILE_MB = 1.7;

export const MIN_BACKGROUND_OPACITY = 5;
export const MAX_BACKGROUND_OPACITY = 60;
export const DEFAULT_BACKGROUND_OPACITY = 22;
export const MAX_BACKGROUND_BLUR = 48;
export const DEFAULT_BACKGROUND_BLUR = 10;
export const MAX_BACKGROUND_DIM = 70;
export const DEFAULT_BACKGROUND_DIM = 28;

/** How the picture fills the window: `cover` crops, `contain` letterboxes. */
export const BackgroundImageFit = Schema.Literals(["cover", "contain"]);
export type BackgroundImageFit = typeof BackgroundImageFit.Type;

export const AppearanceBackgroundPreferences = Schema.Struct({
  /** Downscaled data URL of the uploaded picture, or null when none is set. */
  image: Schema.NullOr(Schema.String),
  opacity: Schema.Int.check(
    Schema.isBetween({ minimum: MIN_BACKGROUND_OPACITY, maximum: MAX_BACKGROUND_OPACITY }),
  ),
  blur: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_BACKGROUND_BLUR })),
  /** Extra theme-tinted darkness over the picture, so light text stays legible. */
  dim: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_BACKGROUND_DIM })),
  fit: BackgroundImageFit,
});
export type AppearanceBackgroundPreferences = typeof AppearanceBackgroundPreferences.Type;

export const DEFAULT_APPEARANCE_BACKGROUND: AppearanceBackgroundPreferences = {
  image: null,
  opacity: DEFAULT_BACKGROUND_OPACITY,
  blur: DEFAULT_BACKGROUND_BLUR,
  dim: DEFAULT_BACKGROUND_DIM,
  fit: "cover",
};

export function hasBackgroundImage(preferences: AppearanceBackgroundPreferences): boolean {
  return typeof preferences.image === "string" && preferences.image.startsWith("data:image/");
}

/**
 * Apply the picture as CSS custom properties on the root element. The layer
 * itself is the root's own background (see `index.css`), so no element has to
 * be mounted, re-parented, or re-painted when the preference changes.
 *
 * `opacity` and `dim` are emitted as percentages rather than ratios: the
 * stylesheet composes them into a `color-mix` with `calc(100% - …)`, because a
 * background layer has no opacity property of its own to fade.
 */
export function applyAppearanceBackground(
  root: HTMLElement,
  preferences: AppearanceBackgroundPreferences,
): void {
  if (!root?.style) return;

  if (!hasBackgroundImage(preferences)) {
    root.removeAttribute("data-app-background");
    for (const variable of [
      "--app-background-image",
      "--app-background-opacity",
      "--app-background-blur",
      "--app-background-dim",
      "--app-background-fit",
    ]) {
      root.style.removeProperty(variable);
    }
    return;
  }

  root.dataset.appBackground = "on";
  root.style.setProperty("--app-background-image", `url("${preferences.image}")`);
  root.style.setProperty("--app-background-opacity", `${preferences.opacity}%`);
  root.style.setProperty("--app-background-blur", `${preferences.blur}px`);
  root.style.setProperty("--app-background-dim", `${preferences.dim}%`);
  root.style.setProperty(
    "--app-background-fit",
    preferences.fit === "contain" ? "contain" : "cover",
  );
}

export type BackgroundImageUploadResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: "unsupported" | "too-large" };

/**
 * Reads a user-supplied picture into a data URL small enough to persist.
 *
 * `maxBytes` budgets the *data URL* (what localStorage has to hold), so the
 * byte limit handed to the shared pipeline is scaled back by base64's 4/3
 * expansion — otherwise a file that fits the byte budget still overflows the
 * storage quota once encoded. HEIC and other browser-undecodable formats are
 * converted by the shared image pipeline; anything still over budget after
 * downscaling is refused rather than silently filling the origin quota.
 */
export async function encodeBackgroundImageFile(
  file: File,
  maxBytes: number = MAX_BACKGROUND_IMAGE_BYTES,
): Promise<BackgroundImageUploadResult> {
  const binaryBudget = Math.floor(maxBytes / 4) * 3;
  try {
    const prepared = await prepareImageForAttachment(file, binaryBudget);
    if (!prepared.ok) {
      return { ok: false, reason: prepared.reason === "too-large" ? "too-large" : "unsupported" };
    }
    return { ok: true, dataUrl: await readFileAsDataUrl(prepared.file) };
  } catch {
    return { ok: false, reason: "unsupported" };
  }
}
