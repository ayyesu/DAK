import { getCanvasKit } from "../vendor/open-pencil/engine.source.mjs";
import svgpath from "svgpath";

export function vectorForNode(node) {
  if (!["path", "polygon"].includes(node.type)) return null;
  if (typeof node.geometry !== "string" || !node.geometry.trim()) throw vectorError(node.id, "geometry must be a non-empty SVG path string");
  if (!Array.isArray(node.viewBox) || node.viewBox.length !== 4 || node.viewBox.some((value) => !Number.isFinite(value)) || node.viewBox[2] <= 0 || node.viewBox[3] <= 0) {
    throw vectorError(node.id, "viewBox must contain four finite numbers with positive width and height");
  }
  const fillRule = node.fillRule ?? "nonzero";
  if (!["evenodd", "nonzero"].includes(fillRule)) throw vectorError(node.id, "fillRule must be evenodd or nonzero");
  const parsed = svgpath(node.geometry);
  if (parsed.err) throw vectorError(node.id, parsed.err);
  const commands = [];
  parsed.abs().unshort().unarc().iterate((segment, index, x, y) => {
    const [type, ...v] = segment;
    if (type === "M") commands.push({ type: "move", x: v[0], y: v[1] });
    else if (type === "L") commands.push({ type: "line", x: v[0], y: v[1] });
    else if (type === "H") commands.push({ type: "line", x: v[0], y });
    else if (type === "V") commands.push({ type: "line", x, y: v[0] });
    else if (type === "C") commands.push({ type: "cubic", c1x: v[0], c1y: v[1], c2x: v[2], c2y: v[3], x: v[4], y: v[5] });
    else if (type === "Q") commands.push({ type: "cubic", c1x: x + (v[0] - x) * 2 / 3, c1y: y + (v[1] - y) * 2 / 3, c2x: v[2] + (v[0] - v[2]) * 2 / 3, c2y: v[3] + (v[1] - v[3]) * 2 / 3, x: v[2], y: v[3] });
    else if (type.toUpperCase() === "Z") commands.push({ type: "close" });
    else throw vectorError(node.id, `unsupported normalized command ${type}`);
  });
  if (commands.some((command) => Object.values(command).some((value) => typeof value === "number" && !Number.isFinite(value)))) throw vectorError(node.id, "geometry contains non-finite coordinates");
  if (!commands.some((command) => ["line", "cubic"].includes(command.type))) throw vectorError(node.id, "geometry did not produce any path segments");
  return { d: node.geometry, viewBox: [...node.viewBox], fillRule, commands };
}

export function scaledVectorCommands(vector, width, height, offsetX = 0, offsetY = 0, options = {}) {
  const [vx, vy, vw, vh] = vector.viewBox;
  const sx = width / vw;
  const sy = height / vh;
  const result = vector.commands.map((source) => {
    const command = { ...source };
    for (const key of ["x", "c1x", "c2x"]) if (key in command) command[key] = offsetX + (command[key] - vx) * sx;
    for (const key of ["y", "c1y", "c2y"]) if (key in command) command[key] = offsetY + (command[key] - vy) * sy;
    return command;
  });
  if (options.flipY) for (const command of result) {
    if ("y" in command) command.y = offsetY + height - (command.y - offsetY);
    if ("c1y" in command) command.c1y = offsetY + height - (command.c1y - offsetY);
    if ("c2y" in command) command.c2y = offsetY + height - (command.c2y - offsetY);
  }
  return result;
}

export function commandsToSvgPath(commands) {
  return commands.map((command) => {
    if (command.type === "move") return `M${number(command.x)} ${number(command.y)}`;
    if (command.type === "line") return `L${number(command.x)} ${number(command.y)}`;
    if (command.type === "cubic") return `C${number(command.c1x)} ${number(command.c1y)} ${number(command.c2x)} ${number(command.c2y)} ${number(command.x)} ${number(command.y)}`;
    return "Z";
  }).join(" ");
}

export async function drawingMlCommands(vector, extent = 100000) {
  const ck = await getCanvasKit();
  const path = ck.Path.MakeFromSVGString(vector.d);
  if (!path) throw vectorError("DrawingML", "Skia rejected the fill path");
  try {
    // PowerPoint's compound custom paths do not preserve authored nonzero
    // overlap semantics. Simplify using the source rule, then emit disjoint
    // boundaries whose coverage agrees under either destination fill rule.
    path.setFillType(vector.fillRule === "evenodd" ? ck.FillType.EvenOdd : ck.FillType.Winding);
    if (!path.simplify()) throw vectorError("DrawingML", "Skia could not simplify the authored fill");
    if (path.isEmpty()) return [];
    const lowered = vectorForNode({ id: "DrawingML", type: "path", geometry: path.toSVGString(), viewBox: vector.viewBox });
    // Keep Skia's float32 containment probes near unit scale. DrawingML's
    // large integer coordinate space loses precision for near-curve probes.
    const commands = orientDisjointContours(scaledVectorCommands(lowered, 1, 1), ck, 1);
    return scaledVectorCommands({ commands, viewBox: [0, 0, 1, 1] }, extent, extent);
  } finally { path.delete(); }
}

// PathOps splits intersections without flattening curves. Its result can still
// use even-odd filling. Orient those now-disjoint contours using interior probes
// (never a shared boundary vertex) and exact polynomial signed areas.
function orientDisjointContours(commands, ck, extent) {
  const contours = [];
  for (const command of commands) {
    if (command.type === "move") contours.push([]);
    contours.at(-1).push(command);
  }
  const paths = contours.map((contour) => ck.Path.MakeFromSVGString(commandsToSvgPath(contour)));
  try {
    return contours.flatMap((contour, index) => {
      const segments = [];
      let previous = contour[0];
      for (const command of contour.slice(1)) {
        const end = command.type === "close" ? contour[0] : command;
        segments.push({ start: previous, end, command: command.type === "close" ? { type: "line", x: end.x, y: end.y } : command });
        previous = end;
      }
      const area = segments.reduce((sum, segment) => sum + segmentArea(segment), 0);
      if (Math.abs(area) < 1e-12) return [];
      let probe;
      for (const segment of segments) {
        const { point, tangent } = segmentPoint(segment, 0.371);
        const length = Math.hypot(tangent.x, tangent.y);
        if (!length) continue;
        const distance = extent * 1e-6;
        for (const sign of [1, -1]) {
          const candidate = { x: point.x - sign * tangent.y / length * distance, y: point.y + sign * tangent.x / length * distance };
          if (paths[index].contains(candidate.x, candidate.y)) { probe = candidate; break; }
        }
        if (probe) break;
      }
      if (!probe) throw vectorError("DrawingML", "could not locate a contour interior for winding conversion");
      const depth = paths.filter((other, otherIndex) => otherIndex !== index && other.contains(probe.x, probe.y)).length;
      if ((area > 0) === (depth % 2 === 0)) return contour;
      const reversed = [{ type: "move", x: contour[0].x, y: contour[0].y }];
      for (const { start, command } of segments.reverse()) {
        reversed.push(command.type === "cubic"
          ? { type: "cubic", c1x: command.c2x, c1y: command.c2y, c2x: command.c1x, c2y: command.c1y, x: start.x, y: start.y }
          : { type: "line", x: start.x, y: start.y });
      }
      reversed.push({ type: "close" });
      return reversed;
    });
  } finally { for (const path of paths) path?.delete(); }
}

function coefficients({ start, end, command }, axis) {
  if (command.type !== "cubic") return [start[axis], end[axis] - start[axis]];
  const a = start[axis], b = command[`c1${axis}`], c = command[`c2${axis}`], d = end[axis];
  return [a, 3 * (b - a), 3 * (a - 2 * b + c), -a + 3 * b - 3 * c + d];
}
function segmentArea(segment) {
  const x = coefficients(segment, "x"), y = coefficients(segment, "y");
  let area = 0;
  for (let i = 0; i < x.length; i++) for (let j = 1; j < y.length; j++) area += (x[i] * j * y[j] - y[i] * j * x[j]) / (i + j);
  return area / 2;
}
function segmentPoint(segment, t) {
  const point = {}, tangent = {};
  for (const axis of ["x", "y"]) {
    const values = coefficients(segment, axis);
    point[axis] = values.reduce((sum, value, power) => sum + value * t ** power, 0);
    tangent[axis] = values.slice(1).reduce((sum, value, power) => sum + (power + 1) * value * t ** power, 0);
  }
  return { point, tangent };
}

function vectorError(id, message) {
  const error = new Error(`Vector node ${id}: ${message}.`);
  error.code = "CANVAS_VECTOR_INVALID";
  return error;
}
function number(value) { return Number(Number(value).toFixed(4)); }
