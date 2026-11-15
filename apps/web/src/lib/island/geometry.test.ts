import { expect, it } from "vite-plus/test";

import { emptyMeasure, islandScreenWidth, shapeTarget } from "./geometry";
import { islandMetrics } from "./metrics";

it("draws a grown expanded shape at the width its content grew to", () => {
  // `shapeTarget` takes the stage width; an expanded width passed in its place has the side
  // insets taken off a second time (27.66 pt too narrow), which cut off a notice's last button.
  // The width the content grew to goes in as the override, already net of the insets.
  const stage = islandScreenWidth(1400, islandMetrics);
  const shape = shapeTarget(
    "expanded",
    { ...emptyMeasure, expandedHeight: 80 },
    stage,
    islandMetrics,
    460,
  );
  expect(shape.right - shape.left).toBe(460);
  expect(shape.left + shape.right).toBeCloseTo(0, 5);
});
