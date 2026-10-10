import { vectorForNode } from "./vector-path.mjs";

// Canvas's corner arrays are TL, TR, BR, BL; omitted entries are zero,
// not CSS shorthand. Scale all radii together when adjacent corners overlap,
// matching Skia's round-rectangle normalization.
export function roundedRectangleVector(node) {
  const { w, h } = node.geometry;
  const value = node.paint.cornerRadius ?? 0;
  const values = Array.isArray(value) ? value : [value, value, value, value];
  if (![w, h].every((size) => Number.isFinite(size) && size >= 0) || values.length > 4 || values.some((radius) => typeof radius !== "number" || !Number.isFinite(radius))) {
    throw new Error(`Rounded rectangle ${node.id} requires finite dimensions and numeric corner radii.`);
  }
  const radii = Array.from({ length: 4 }, (_, index) => Math.max(0, values[index] ?? 0));
  const [tl, tr, br, bl] = radii;
  const ratio = (side, sum) => sum > 0 ? side / sum : 1;
  const scale = Math.min(1, ratio(w, tl + tr), ratio(w, bl + br), ratio(h, tl + bl), ratio(h, tr + br));
  const [a, b, c, d] = radii.map((radius) => radius * scale);
  return vectorForNode({
    id: node.id, type: "path", viewBox: [0, 0, w || 1, h || 1],
    geometry: `M${a} 0 H${w - b} A${b} ${b} 0 0 1 ${w} ${b} V${h - c} A${c} ${c} 0 0 1 ${w - c} ${h} H${d} A${d} ${d} 0 0 1 0 ${h - d} V${a} A${a} ${a} 0 0 1 ${a} 0 Z`,
  });
}
