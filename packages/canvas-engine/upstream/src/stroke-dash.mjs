// SVG stroke-dasharray semantics for resolved numeric Canvas lengths.
// https://www.w3.org/TR/SVG/painting.html#StrokeDasharrayProperty
export function normalizeStrokeDash(dash = []) {
  if (dash === null) return [];
  if (!Array.isArray(dash) || dash.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError("Stroke dash must be an array of finite non-negative lengths.");
  }
  if (dash.every((value) => value === 0)) return [];
  return dash.length % 2 ? [...dash, ...dash] : [...dash];
}
