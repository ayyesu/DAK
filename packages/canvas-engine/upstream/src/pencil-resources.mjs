const RESOURCE_KINDS = new Set(["image", "script", "shader", "font"]);

export function collectPencilResourceReferences(document) {
  const references = new Map();
  const add = (path, kind) => {
    if (typeof path !== "string") return;
    validatePencilResourceReference(path);
    const previous = references.get(path);
    if (previous && previous !== kind) {
      throw new Error(`Pencil resource ${path} is used as both ${previous} and ${kind}.`);
    }
    references.set(path, kind);
  };

  for (const font of document?.fonts ?? []) add(font?.url, "font");
  visit(document?.children, (value) => {
    if (value.type === "image") add(value.url, "image");
    if (value.type === "shader") add(value.url, "shader");
    if (value.type === "script") add(value.scriptUri, "script");
  });
  return [...references].map(([path, kind]) => ({ path, kind }));
}

export function collectPencilDocumentFonts(document, assets, containerPath = "") {
  const fonts = new Map();
  const collect = (source, sourcePath) => {
    for (const definition of source?.fonts ?? []) {
      if (!definition || typeof definition.name !== "string" || !definition.name.trim()) {
        throw new Error("Pencil document font names must be non-empty strings.");
      }
      const url = resolvePencilResourcePath(sourcePath, definition.url);
      const asset = pencilResourceAsset(assets, url);
      if (!asset) throw new Error(`Pencil document font resource ${url} is unavailable.`);
      const previous = fonts.get(definition.name);
      if (previous && previous.sha256 !== asset.sha256) {
        throw new Error(`Pencil document font ${definition.name} resolves to more than one file.`);
      }
      fonts.set(definition.name, { family: definition.name, url, bytes: asset.bytes, sha256: asset.sha256 });
    }
  };
  collect(document, containerPath);
  return [...fonts.values()];
}

export function resolvePencilResourcePath(containerPath, reference) {
  validatePencilResourceReference(reference);
  const base = typeof containerPath === "string" && containerPath
    ? containerPath.split("/").slice(0, -1)
    : [];
  const output = [...base];
  for (const encodedPart of reference.split("/")) {
    let part;
    try {
      part = decodeURIComponent(encodedPart);
    } catch {
      throw new Error(`Pencil resource ${reference} contains invalid URL encoding.`);
    }
    if (part.includes("/") || part.includes("\\") || part.includes("\0")) {
      throw new Error(`Pencil resource ${reference} contains an invalid path segment.`);
    }
    if (!part || part === ".") continue;
    if (part === "..") {
      if (output.length > 0 && output.at(-1) !== "..") output.pop();
      else output.push("..");
    } else {
      output.push(part);
    }
  }
  return output.join("/");
}

export function pencilResourceAsset(assets, reference, containerPath = "") {
  if (!(assets instanceof Map) || typeof reference !== "string") return null;
  return assets.get(resolvePencilResourcePath(containerPath, reference))
    ?? assets.get(reference)
    ?? null;
}

export function validatePencilResourceReference(reference) {
  if (
    !reference
    || reference.startsWith("/")
    || reference.startsWith("\\")
    || reference.includes("\\")
    || reference.includes("//")
  ) {
    throw new Error(`Pencil resource ${reference || "(empty)"} is not a relative URL.`);
  }
  let url;
  try {
    url = new URL(reference, "https://penkra.invalid/");
  } catch {
    throw new Error(`Pencil resource ${reference} is not a valid relative URL.`);
  }
  if (url.origin !== "https://penkra.invalid" || /^(?:data|blob|https?):/iu.test(reference)) {
    throw new Error(`Pencil resource ${reference} is not a local relative URL.`);
  }
  if (url.search || url.hash || reference.endsWith("/") || /(?:^|\/)\.{1,2}$/u.test(reference)) {
    throw new Error(`Pencil resource ${reference} does not identify one local file.`);
  }
}

export function pencilResourceMimeType(path, kind = null) {
  if (kind !== null && !RESOURCE_KINDS.has(kind)) throw new Error(`Unknown Pencil resource kind ${kind}.`);
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    mjs: "text/javascript",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    frag: "text/x-glsl",
    fs: "text/x-glsl",
    glsl: "text/x-glsl",
    otf: "font/otf",
    ttf: "font/ttf",
    woff: "font/woff",
    woff2: "font/woff2",
  })[extension] ?? (kind === "script" ? "text/javascript" : kind === "shader" ? "text/x-glsl" : "application/octet-stream");
}

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) callback(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, callback);
}
