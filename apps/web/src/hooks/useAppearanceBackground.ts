import {
  APPEARANCE_BACKGROUND_STORAGE_KEY,
  AppearanceBackgroundPreferences,
  DEFAULT_APPEARANCE_BACKGROUND,
  hasBackgroundImage,
} from "~/appearanceBackground";

import { useLocalStorage } from "./useLocalStorage";

/**
 * Whether this device has a background picture set.
 *
 * The picture is painted by CSS (`applyAppearanceBackground` in the root
 * route), which is enough for the surfaces that only need to let it through.
 * Components use this when they have to change *shape* because the app is no
 * longer sitting on an opaque canvas — a surface that has to carry its own
 * contrast rather than inheriting the theme's.
 */
export function useHasBackgroundPicture(): boolean {
  const [background] = useLocalStorage(
    APPEARANCE_BACKGROUND_STORAGE_KEY,
    DEFAULT_APPEARANCE_BACKGROUND,
    AppearanceBackgroundPreferences,
  );
  return hasBackgroundImage(background);
}
