export function normalizePencilMeshGradient(fill) {
  const columns = integerDimension(fill?.columns, "columns");
  const rows = integerDimension(fill?.rows, "rows");
  const count = columns * rows;
  if (!Array.isArray(fill.colors) || fill.colors.length !== count) {
    throw new Error(`Pencil mesh gradient requires exactly ${count} colors.`);
  }
  if (!Array.isArray(fill.points) || fill.points.length !== count) {
    throw new Error(`Pencil mesh gradient requires exactly ${count} points.`);
  }
  const horizontal = 0.25 / Math.max(columns - 1, 1);
  const vertical = 0.25 / Math.max(rows - 1, 1);
  const defaults = {
    leftHandle: [-horizontal, 0],
    rightHandle: [horizontal, 0],
    topHandle: [0, -vertical],
    bottomHandle: [0, vertical],
  };
  const points = fill.points.map((point, index) => {
    const value = Array.isArray(point) ? { position: point } : point;
    if (!value || typeof value !== "object") throw new Error(`Pencil mesh point ${index} is invalid.`);
    return {
      position: finitePair(value.position, `point ${index} position`),
      leftHandle: finitePair(value.leftHandle ?? defaults.leftHandle, `point ${index} left handle`),
      rightHandle: finitePair(value.rightHandle ?? defaults.rightHandle, `point ${index} right handle`),
      topHandle: finitePair(value.topHandle ?? defaults.topHandle, `point ${index} top handle`),
      bottomHandle: finitePair(value.bottomHandle ?? defaults.bottomHandle, `point ${index} bottom handle`),
    };
  });
  return { columns, rows, colors: structuredClone(fill.colors), points };
}

export function evaluatePencilMeshPatch(mesh, column, row, u, v) {
  if (column < 0 || column >= mesh.columns - 1 || row < 0 || row >= mesh.rows - 1) {
    throw new RangeError("Pencil mesh patch coordinate is outside the grid.");
  }
  const p00 = mesh.points[row * mesh.columns + column];
  const p10 = mesh.points[row * mesh.columns + column + 1];
  const p01 = mesh.points[(row + 1) * mesh.columns + column];
  const p11 = mesh.points[(row + 1) * mesh.columns + column + 1];
  const top = cubic(p00.position, add(p00.position, p00.rightHandle), add(p10.position, p10.leftHandle), p10.position, u);
  const bottom = cubic(p01.position, add(p01.position, p01.rightHandle), add(p11.position, p11.leftHandle), p11.position, u);
  const left = cubic(p00.position, add(p00.position, p00.bottomHandle), add(p01.position, p01.topHandle), p01.position, v);
  const right = cubic(p10.position, add(p10.position, p10.bottomHandle), add(p11.position, p11.topHandle), p11.position, v);
  const bilinear = mix(mix(p00.position, p10.position, u), mix(p01.position, p11.position, u), v);
  return subtract(add(mix(top, bottom, v), mix(left, right, u)), bilinear);
}

function integerDimension(value, name) {
  if (!Number.isInteger(value) || value < 2) throw new Error(`Pencil mesh gradient ${name} must be an integer of at least 2.`);
  return value;
}

function finitePair(value, name) {
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`Pencil mesh ${name} must be a finite [x, y] pair.`);
  }
  return [...value];
}

function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function subtract(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function mix(a, b, t) { return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t]; }
function cubic(a, b, c, d, t) {
  const inverse = 1 - t;
  return [0, 1].map((axis) => inverse ** 3 * a[axis]
    + 3 * inverse ** 2 * t * b[axis]
    + 3 * inverse * t ** 2 * c[axis]
    + t ** 3 * d[axis]);
}
