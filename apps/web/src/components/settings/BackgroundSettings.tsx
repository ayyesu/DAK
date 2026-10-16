import { ImageIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useCallback, useRef, useState, type ChangeEvent, type CSSProperties } from "react";

import {
  APPEARANCE_BACKGROUND_STORAGE_KEY,
  AppearanceBackgroundPreferences,
  DEFAULT_APPEARANCE_BACKGROUND,
  DEFAULT_BACKGROUND_BLUR,
  DEFAULT_BACKGROUND_DIM,
  DEFAULT_BACKGROUND_OPACITY,
  MAX_BACKGROUND_BLUR,
  MAX_BACKGROUND_DIM,
  MAX_BACKGROUND_IMAGE_FILE_MB,
  MAX_BACKGROUND_OPACITY,
  MIN_BACKGROUND_OPACITY,
  encodeBackgroundImageFile,
  hasBackgroundImage,
  type BackgroundImageFit,
} from "~/appearanceBackground";
import { useLocalStorage } from "~/hooks/useLocalStorage";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const FIT_LABELS: Readonly<Record<BackgroundImageFit, string>> = {
  cover: "Fill screen",
  contain: "Fit picture",
};

/**
 * Ratio to a 0–100% slider track, plus the fill offset the shared settings
 * slider style expects.
 */
function sliderTrack(value: number, min: number, max: number): CSSProperties {
  const ratio = (value - min) / (max - min);
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

function BackgroundSliderRow({
  id,
  title,
  description,
  value,
  min,
  max,
  step,
  defaultValue,
  maxLabel,
  onChange,
  onReset,
}: {
  id: string;
  title: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  maxLabel?: string;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      resetAction={
        value === defaultValue ? null : <SettingResetButton label={title} onClick={onReset} />
      }
      control={
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output
            className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
            htmlFor={id}
          >
            {maxLabel && value === max ? maxLabel : `${value}%`}
          </output>
          <input
            aria-label={title}
            className="settings-slider min-w-0 flex-1"
            id={id}
            max={max}
            min={min}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
            }}
            step={step}
            style={sliderTrack(value, min, max)}
            type="range"
            value={value}
          />
        </div>
      }
    />
  );
}

/**
 * Uploads a picture that shows through the interface's large surfaces. The
 * picture is stored on this device only, so it never travels with the rest of
 * the user's settings, and every control stays inert-but-visible when it is
 * absent.
 */
export function BackgroundImageSection() {
  const [preferences, setPreferences] = useLocalStorage(
    APPEARANCE_BACKGROUND_STORAGE_KEY,
    DEFAULT_APPEARANCE_BACKGROUND,
    AppearanceBackgroundPreferences,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isReading, setIsReading] = useState(false);
  const hasPicture = hasBackgroundImage(preferences);

  const patch = useCallback(
    (next: Partial<AppearanceBackgroundPreferences>) => {
      setPreferences((current) => ({ ...current, ...next }));
    },
    [setPreferences],
  );

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Reset the input so picking the same file again still fires a change.
    event.currentTarget.value = "";
    if (!file) return;
    setIsReading(true);
    try {
      const result = await encodeBackgroundImageFile(file);
      if (!result.ok) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              result.reason === "too-large"
                ? "That picture is too large"
                : "That file could not be read as an image",
            description:
              result.reason === "too-large"
                ? `Please pick an image smaller than ${MAX_BACKGROUND_IMAGE_FILE_MB}MB.`
                : "Try a PNG, JPEG, WebP, or HEIC photo.",
          }),
        );
        return;
      }
      patch({ image: result.dataUrl });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Background picture set",
        }),
      );
    } finally {
      setIsReading(false);
    }
  };

  const fileInput = (
    <input
      accept="image/*"
      className="sr-only"
      onChange={(event) => void onFileChange(event)}
      ref={fileInputRef}
      tabIndex={-1}
      type="file"
    />
  );

  if (!hasPicture) {
    return (
      <SettingsSection id="appearance-background" title="Background">
        <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl border border-border/70 bg-muted/40 text-muted-foreground">
            <ImageIcon className="size-5" />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Add a background picture</p>
            <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
              Your picture shows through the sidebar, chat, and panels while cards, code, and menus
              stay solid. It is saved on this device only and follows your theme.
            </p>
          </div>
          <Button
            disabled={isReading}
            onClick={() => fileInputRef.current?.click()}
            size="sm"
            variant="outline"
          >
            <UploadIcon />
            {isReading ? "Reading picture…" : "Choose picture"}
          </Button>
        </div>
        {fileInput}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="appearance-background" title="Background">
      <SettingsRow
        {...searchableSetting("setting-background-image")}
        description="Shows through large surfaces; cards, code, and menus stay solid."
        control={
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            <Button
              className="relative overflow-hidden"
              disabled={isReading}
              onClick={() => fileInputRef.current?.click()}
              size="sm"
              variant="outline"
            >
              <span
                aria-hidden
                className="absolute inset-0 bg-cover bg-center opacity-45"
                style={{ backgroundImage: `url("${preferences.image}")` }}
              />
              <span className="relative flex items-center gap-1.5">
                <UploadIcon />
                {isReading ? "Reading…" : "Replace"}
              </span>
            </Button>
            <Button
              aria-label="Remove background picture"
              onClick={() => patch({ image: null })}
              size="icon-sm"
              variant="ghost-destructive"
            >
              <Trash2Icon />
            </Button>
          </div>
        }
      />
      <BackgroundSliderRow
        defaultValue={DEFAULT_BACKGROUND_OPACITY}
        description="How strongly the picture reads behind the interface."
        id="background-opacity"
        max={MAX_BACKGROUND_OPACITY}
        maxLabel="Off"
        min={MIN_BACKGROUND_OPACITY}
        onChange={(opacity) => patch({ opacity })}
        onReset={() => patch({ opacity: DEFAULT_BACKGROUND_OPACITY })}
        step={1}
        title="Picture opacity"
        value={preferences.opacity}
      />
      <BackgroundSliderRow
        defaultValue={DEFAULT_BACKGROUND_DIM}
        description="Darkens the picture toward your theme so text stays legible."
        id="background-dim"
        max={MAX_BACKGROUND_DIM}
        min={0}
        onChange={(dim) => patch({ dim })}
        onReset={() => patch({ dim: DEFAULT_BACKGROUND_DIM })}
        step={1}
        title="Dim"
        value={preferences.dim}
      />
      <BackgroundSliderRow
        defaultValue={DEFAULT_BACKGROUND_BLUR}
        description="Softens the picture so fine detail never fights the interface."
        id="background-blur"
        max={MAX_BACKGROUND_BLUR}
        maxLabel="Max"
        min={0}
        onChange={(blur) => patch({ blur })}
        onReset={() => patch({ blur: DEFAULT_BACKGROUND_BLUR })}
        step={2}
        title="Blur"
        value={preferences.blur}
      />
      <SettingsRow
        id="background-fit"
        title="Fit"
        description="Fill crops the picture to the window; Fit keeps the whole frame."
        control={
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            <Button
              onClick={() => patch({ fit: preferences.fit === "cover" ? "contain" : "cover" })}
              size="sm"
              variant="outline"
            >
              {FIT_LABELS[preferences.fit]}
            </Button>
          </div>
        }
      />
      {fileInput}
    </SettingsSection>
  );
}
