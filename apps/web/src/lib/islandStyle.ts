import type { IslandStyle } from "@dak/contracts/settings";

/** What the root island actually draws once the setting and the display are known. */
export type EffectiveIslandStyle = "classic" | "notch";

/**
 * "auto" draws the classic pill unless the window's display has a physical notch.
 * There the always-visible pill would read as a second, fake notch under the real
 * one, so the island stays out of sight until an activity is running.
 */
export const resolveIslandStyle = (
  setting: IslandStyle,
  displayHasNotch: boolean,
): EffectiveIslandStyle => (setting === "auto" && displayHasNotch ? "notch" : "classic");
