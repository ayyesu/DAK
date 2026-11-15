import { describe, expect, it } from "vite-plus/test";

import { resolveIslandStyle } from "./islandStyle";

describe("resolveIslandStyle", () => {
  it("hides the resting pill only for auto on a notched display", () => {
    expect(resolveIslandStyle("auto", true)).toBe("notch");
  });

  it("keeps the classic pill without a notch", () => {
    expect(resolveIslandStyle("auto", false)).toBe("classic");
  });

  it("keeps the classic pill when the user chose classic, notch or not", () => {
    expect(resolveIslandStyle("classic", true)).toBe("classic");
    expect(resolveIslandStyle("classic", false)).toBe("classic");
  });
});
