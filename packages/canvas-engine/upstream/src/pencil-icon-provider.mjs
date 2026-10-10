import { icons } from "lucide";
import svgpath from "svgpath";
import chunkRouting from "./icon-chunk-routing.mjs";

const loadedChunks = new Map();
const chunkLoads = new Map();
let searchIndexPromise;

function catalogKey(library) {
  if (library?.startsWith("Material Symbols ")) return "material";
  if (library === "phosphor" || library === "feather") return library;
  return null;
}

function requestedName(library, name, weight = 400) {
  if (typeof name !== "string") return null;
  if (library?.startsWith("Material Symbols ")) {
    const suffix = ({
      "Material Symbols Outlined": "outline",
      "Material Symbols Rounded": "outline-rounded",
      "Material Symbols Sharp": "outline-sharp",
    })[library];
    return suffix ? `${name.replaceAll("_", "-")}-${suffix}` : null;
  }
  if (library === "phosphor") {
    const suffix = ({ 100: "thin", 300: "light", 400: "", 700: "bold" })[Number(weight)];
    return suffix === undefined ? null : suffix && !name.endsWith(`-${suffix}`) ? `${name}-${suffix}` : name;
  }
  return name;
}

function chunkKey(library, name, weight) {
  const family = catalogKey(library);
  const requested = requestedName(library, name, weight);
  if (!family || !requested || !/^[a-z0-9-]+$/u.test(requested)) return null;
  const base = requested.slice(0, 3).padEnd(3, "_");
  const length = chunkRouting[family]?.[base] ?? 3;
  return `${family}/${requested.slice(0, length).padEnd(length, "_")}`;
}

export function missingPencilIconCatalogs(document) {
  const needed = new Set();
  const visited = new WeakSet();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    // Traverse component sources, ref descendants, props and conditional
    // branches. A binding can choose a different library than its source icon.
    if (value.type === "icon" || (value.library && value.icon)) {
      const key = chunkKey(value.library, value.icon, value.weight ?? 400);
      if (key && !loadedChunks.has(key)) needed.add(key);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(document);
  return [...needed];
}

async function readLocalJson(url) {
  if (url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    try { return JSON.parse(await readFile(url, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Canvas icon asset ${url} failed: ${response.status}`);
  return response.json();
}

export async function ensurePencilIconChunks(keys) {
  await Promise.all([...new Set(keys)].map(async (key) => {
    if (!key || loadedChunks.has(key)) return;
    let pending = chunkLoads.get(key);
    if (!pending) {
      pending = readLocalJson(new URL(`./icon-chunks/${key}.json`, import.meta.url))
        .then((value) => { loadedChunks.set(key, value ?? {}); })
        .finally(() => { chunkLoads.delete(key); });
      chunkLoads.set(key, pending);
    }
    await pending;
  }));
}

export async function ensurePencilIconDefinitions(requests) {
  await ensurePencilIconChunks(requests.map(({ library, icon, weight }) => chunkKey(library, icon, weight ?? 400)));
}

export async function ensurePencilDocumentIconCatalogs(document) {
  const { collectPencilRenderIconRequests } = await import("./openpencil-render-document.mjs");
  await ensurePencilIconDefinitions(collectPencilRenderIconRequests(document));
}

function loadedIcon(library, name, weight) {
  const key = chunkKey(library, name, weight);
  if (!key) return null;
  const chunk = loadedChunks.get(key);
  if (!chunk) throw new Error(`Canvas icon chunk ${key} was not loaded before rendering.`);
  return chunk[requestedName(library, name, weight)] ?? null;
}

const ICON_PROVIDERS = new Map([
  ["lucide", (name) => lucideIcon(name)],
  ["feather", (name) => iconifyIcon(loadedIcon("feather", name), "stroke")],
  ["Material Symbols Outlined", (name, weight) => materialIcon(name, "outline", weight)],
  ["Material Symbols Rounded", (name, weight) => materialIcon(name, "outline-rounded", weight)],
  ["Material Symbols Sharp", (name, weight) => materialIcon(name, "outline-sharp", weight)],
  ["phosphor", (name, weight) => phosphorIcon(name, weight)],
]);
export const CANVAS_ICON_LIBRARIES = Object.freeze([...ICON_PROVIDERS.keys()]);
const iconCatalogs = new Map();

export function pencilIconDefinition(library, name, weight = 400) {
  if (typeof library !== "string" || typeof name !== "string") return null;
  return ICON_PROVIDERS.get(library)?.(name, normalizeWeight(weight)) ?? null;
}

export async function searchCanvasIcons(query, options = {}) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  if (!normalizedQuery) throw new TypeError("Icon search requires a non-empty query.");
  const limit = options.limit ?? 40;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Icon search limit must be an integer from 1 through 100.");
  }
  const libraries = options.library === undefined
    ? CANVAS_ICON_LIBRARIES
    : CANVAS_ICON_LIBRARIES.includes(options.library)
      ? [options.library]
      : (() => { throw new TypeError(`Unknown Canvas icon library ${JSON.stringify(options.library)}.`); })();
  const terms = normalizedQuery.split(/\s+/u);
  searchIndexPromise ??= readLocalJson(new URL("./icon-chunks/search-index.json", import.meta.url))
    .catch((error) => { searchIndexPromise = null; throw error; });
  const searchIndex = await searchIndexPromise;
  const matches = libraries.flatMap((library) => iconCatalog(library, searchIndex)
    .filter((icon) => terms.every((term) => icon.includes(term)))
    .map((icon) => ({ library, icon, rank: iconRank(icon, normalizedQuery) })));
  matches.sort((left, right) => left.rank - right.rank
    || left.icon.length - right.icon.length
    || left.icon.localeCompare(right.icon)
    || left.library.localeCompare(right.library));
  return {
    items: matches.slice(0, limit).map(({ library, icon }) => ({ library, icon })),
    total: matches.length,
    truncated: matches.length > limit,
  };
}

function iconCatalog(library, searchIndex) {
  if (iconCatalogs.has(library)) return iconCatalogs.get(library);
  let names;
  if (library === "lucide") {
    names = Object.keys(icons).map(pascalToKebab);
  } else if (library === "feather") {
    names = searchIndex.feather;
  } else if (library === "phosphor") {
    names = searchIndex.phosphor;
  } else {
    const suffix = ({
      "Material Symbols Outlined": "-outline",
      "Material Symbols Rounded": "-outline-rounded",
      "Material Symbols Sharp": "-outline-sharp",
    })[library];
    names = searchIndex.material
      .filter((name) => name.endsWith(suffix))
      .map((name) => name.slice(0, -suffix.length).replaceAll("-", "_"));
  }
  const catalog = Object.freeze([...new Set(names)].sort());
  iconCatalogs.set(library, catalog);
  return catalog;
}

function pascalToKebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase();
}

function iconRank(icon, query) {
  if (icon === query) return 0;
  if (icon.startsWith(`${query}-`) || icon.startsWith(`${query}_`)) return 1;
  if (icon.split(/[-_]/u).includes(query)) return 2;
  return 3;
}

function lucideIcon(name) {
  if (typeof name !== "string") return null;
  const icon = icons[toPascalCase(name)];
  if (!icon) return null;
  const geometry = icon.map(([element, attributes]) => primitivePath(element, attributes));
  if (geometry.some((path) => path === null)) return null;
  return {
    geometry: geometry.map(isolateSvgSubpath).join(" "),
    viewBox: [0, 0, 24, 24],
    paint: "stroke",
    strokeWidth: 2,
  };
}

function materialIcon(name, suffix, weight) {
  if (weight < 100 || weight > 700) return null;
  const catalogName = name.replaceAll("_", "-");
  if (!loadedIcon(({
    outline: "Material Symbols Outlined",
    "outline-rounded": "Material Symbols Rounded",
    "outline-sharp": "Material Symbols Sharp",
  })[suffix], name, weight)) return null;
  return {
    fontFamily: ({
      outline: "Material Symbols Outlined",
      "outline-rounded": "Material Symbols Rounded",
      "outline-sharp": "Material Symbols Sharp",
    })[suffix],
    content: catalogName.replaceAll("-", "_"),
    weight,
    paint: "font",
  };
}

function phosphorIcon(name, weight) {
  return iconifyIcon(loadedIcon("phosphor", name, weight), "fill");
}

function normalizeWeight(value) {
  const weight = Number(value);
  return Number.isFinite(weight) ? weight : 400;
}

function iconifyIcon(resolved, paint) {
  if (!resolved) return null;
  const layers = [...resolved.body.matchAll(/<path\b([^>]*)>/gu)].flatMap((match) => {
    const attributes = match[1];
    const path = attributes.match(/\bd=(?:"([^"]+)"|'([^']+)')/u);
    if (!path) return [];
    const opacity = attributes.match(/\bopacity=(?:"([^"]+)"|'([^']+)')/u);
    return [{
      geometry: paint === "fill"
        ? closeSvgFillSubpaths(path[1] ?? path[2])
        : isolateSvgSubpath(path[1] ?? path[2]),
      opacity: opacity ? Number(opacity[1] ?? opacity[2]) : 1,
    }];
  });
  if (layers.length === 0 || layers.some(({ opacity }) => !Number.isFinite(opacity))) return null;
  return {
    geometry: layers.map(({ geometry }) => geometry).join(" "),
    layers: layers.some(({ opacity }) => opacity !== 1) ? layers : undefined,
    viewBox: [0, 0, resolved.width, resolved.height],
    paint,
    strokeWidth: paint === "stroke" ? 2 : undefined,
  };
}

function isolateSvgSubpath(path) {
  // An initial relative moveto is relative to the origin in its own SVG path,
  // but relative to the preceding endpoint after paths are combined. Resetting
  // the current point before every source path preserves the complete command,
  // including relative coordinate pairs after its first moveto.
  return `M0 0 ${String(path)}`;
}

function closeSvgFillSubpaths(path) {
  const normalized = svgpath(String(path)).abs().unshort().unarc().toString();
  let firstMove = true;
  const closed = normalized.replace(/M/gu, () => {
    if (firstMove) {
      firstMove = false;
      return "M";
    }
    return "Z M";
  });
  return `M0 0 ${closed} Z`;
}

function primitivePath(element, attributes) {
  if (element === "path") return attributes.d ?? null;
  if (element === "line") {
    return `M${attributes.x1} ${attributes.y1} L${attributes.x2} ${attributes.y2}`;
  }
  if (element === "polyline") return pointsPath(attributes.points, false);
  if (element === "polygon") return pointsPath(attributes.points, true);
  if (element === "circle") {
    return ellipsePath(attributes.cx, attributes.cy, attributes.r, attributes.r);
  }
  if (element === "ellipse") {
    return ellipsePath(attributes.cx, attributes.cy, attributes.rx, attributes.ry);
  }
  if (element === "rect") return rectanglePath(attributes);
  return null;
}

function pointsPath(points, closed) {
  const coordinates = String(points ?? "").match(/-?\d*\.?\d+/gu)?.map(Number) ?? [];
  if (coordinates.length < 2 || coordinates.length % 2 !== 0) return null;
  const commands = [];
  for (let index = 0; index < coordinates.length; index += 2) {
    commands.push(`${index === 0 ? "M" : "L"}${coordinates[index]} ${coordinates[index + 1]}`);
  }
  return `${commands.join(" ")}${closed ? " Z" : ""}`;
}

function ellipsePath(cxValue, cyValue, rxValue, ryValue) {
  const cx = Number(cxValue);
  const cy = Number(cyValue);
  const rx = Number(rxValue);
  const ry = Number(ryValue);
  if (![cx, cy, rx, ry].every(Number.isFinite)) return null;
  return `M${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}`;
}

function rectanglePath(attributes) {
  const x = Number(attributes.x ?? 0);
  const y = Number(attributes.y ?? 0);
  const width = Number(attributes.width);
  const height = Number(attributes.height);
  const radius = Math.min(Number(attributes.rx ?? attributes.ry ?? 0), width / 2, height / 2);
  if (![x, y, width, height, radius].every(Number.isFinite)) return null;
  if (radius <= 0) return `M${x} ${y} H${x + width} V${y + height} H${x} Z`;
  return `M${x + radius} ${y} H${x + width - radius} A${radius} ${radius} 0 0 1 ${x + width} ${y + radius} V${y + height - radius} A${radius} ${radius} 0 0 1 ${x + width - radius} ${y + height} H${x + radius} A${radius} ${radius} 0 0 1 ${x} ${y + height - radius} V${y + radius} A${radius} ${radius} 0 0 1 ${x + radius} ${y} Z`;
}

function toPascalCase(value) {
  return value.split("-").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("");
}
