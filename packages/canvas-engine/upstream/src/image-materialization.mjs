import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_IMAGE_MATERIALIZATIONS = 4;

export async function materializeDocumentImages({
  api,
  documentId,
  document,
  existingAssets = [],
  skipSources = new Set(),
  generations = [],
  signal = new AbortController().signal,
  dependencies = {},
}) {
  const fetchImage = dependencies.fetch ?? fetch;
  const readLocalFile = dependencies.readFile ?? readBoundedLocalFile;
  const generateAi = dependencies.generateAi ?? ((input) => api.generateImage(documentId, input));
  const existingPaths = new Set(existingAssets.map((asset) => asset.path));
  const generatedByUrl = new Map(generations.map((generation) => [generation.url, generation]));
  const workBySource = new Map();
  const fillsBySource = new Map();
  let changed = false;

  for (const fill of collectImageFills(document)) {
    const source = fill.url;
    if (existingPaths.has(source) || skipSources.has(source)) continue;
    const fills = fillsBySource.get(source) ?? [];
    fills.push(fill);
    fillsBySource.set(source, fills);
    if (!workBySource.has(source)) {
      const generation = generatedByUrl.get(source);
      workBySource.set(source, async () => {
        signal.throwIfAborted();
        if (generation) {
          const generated = await resolveGeneration(generation, document, generateAi);
          signal.throwIfAborted();
          if (!generated || typeof generated.path !== "string" || generated.path.length === 0) {
            throw imageError("CANVAS_IMAGE_GENERATION_FAILED", "Canvas image generation returned no asset path.");
          }
          return generated;
        }
        const resolved = await resolveImageSource(source, { fetchImage, readLocalFile });
        signal.throwIfAborted();
        assertImageBytes(resolved.bytes, source);
        const sha256 = createHash("sha256").update(resolved.bytes).digest("hex");
        const path = `images/${sha256}${extensionForMimeType(resolved.mimeType)}`;
        return api.uploadAsset(documentId, {
          path,
          sha256,
          bytes: resolved.bytes,
          mimeType: resolved.mimeType,
        });
      });
    }
  }

  const entries = [...workBySource.entries()];
  const uploadedBySource = new Map();
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_IMAGE_MATERIALIZATIONS, entries.length) },
    async () => {
      while (next < entries.length) {
        const index = next++;
        const [source, materialize] = entries[index];
        const uploaded = await materialize();
        uploadedBySource.set(source, uploaded);
      }
    },
  ));
  signal.throwIfAborted();
  for (const [source, fills] of fillsBySource) {
    const uploaded = uploadedBySource.get(source);
    for (const fill of fills) fill.url = uploaded.path;
    changed = true;
  }
  return {
    changed,
    uploaded: entries.map(([source]) => uploadedBySource.get(source)),
  };
}

export function collectImageFills(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (!Array.isArray(value) && value.type === "image" && typeof value.url === "string") {
    output.push(value);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectImageFills(child, output);
  }
  return output;
}

async function resolveGeneration(generation, document, generateAi) {
  const node = findNode(document.children, generation.nodeId);
  const dimensions = {
    width: finiteDimension(node?.width),
    height: finiteDimension(node?.height),
  };
  if (generation.kind === "ai") {
    return generateAi({ prompt: generation.prompt, ...dimensions });
  }
  throw imageError("CANVAS_IMAGE_SOURCE_INVALID", `Unsupported G source ${generation.kind}.`);
}

async function resolveImageSource(source, dependencies) {
  if (source.startsWith("data:")) return decodeDataUrl(source);
  if (source.startsWith("file:")) {
    return localImage(fileURLToPath(source), dependencies.readLocalFile);
  }
  if (isAbsolute(source)) return localImage(source, dependencies.readLocalFile);
  let url;
  try {
    url = new URL(source);
  } catch {
    throw imageError(
      "CANVAS_IMAGE_RELATIVE_PATH_UNAVAILABLE",
      `Image ${JSON.stringify(source)} is relative and is not already stored in this Canvas document. Pass an absolute path, file:// URL, HTTP(S) URL, or data URL.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw imageError("CANVAS_IMAGE_SOURCE_INVALID", `Image URL protocol ${url.protocol} is not supported.`);
  }
  return remoteImage(url, dependencies.fetchImage);
}

async function localImage(path, readLocalFile) {
  const bytes = new Uint8Array(await readLocalFile(path));
  return { bytes, mimeType: detectMimeType(bytes, basename(path)) };
}

async function readBoundedLocalFile(path) {
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    if (stats.size > MAX_IMAGE_BYTES) {
      throw imageError("CANVAS_IMAGE_TOO_LARGE", "Image exceeds the 24 MiB limit.");
    }
    const bytes = new Uint8Array(stats.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function remoteImage(url, request) {
  const response = await request(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml" },
  });
  if (!response.ok) {
    throw imageError("CANVAS_IMAGE_FETCH_FAILED", `Image request failed (${response.status}).`);
  }
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
    throw imageError("CANVAS_IMAGE_TOO_LARGE", "Image exceeds the 24 MiB limit.");
  }
  const bytes = await boundedResponseBytes(response);
  return {
    bytes,
    mimeType: detectMimeType(bytes, url.pathname, response.headers.get("content-type")),
  };
}

async function boundedResponseBytes(response) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertImageBytes(bytes, "remote response");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_IMAGE_BYTES) {
        await reader.cancel("Canvas image exceeds the 24 MiB limit.");
        throw imageError("CANVAS_IMAGE_TOO_LARGE", "Image exceeds the 24 MiB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeDataUrl(source) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/su.exec(source);
  if (!match) throw imageError("CANVAS_IMAGE_SOURCE_INVALID", "Image data URL is invalid.");
  const bytes = match[2]
    ? new Uint8Array(Buffer.from(match[3], "base64"))
    : new TextEncoder().encode(decodeURIComponent(match[3]));
  return { bytes, mimeType: detectMimeType(bytes, "", match[1]) };
}

function findNode(nodes = [], id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children, id);
    if (child) return child;
  }
  return null;
}

function finiteDimension(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1024;
}

function detectMimeType(bytes, name = "", declared = "") {
  const normalized = String(declared).split(";", 1)[0].trim().toLowerCase();
  if (normalized.startsWith("image/")) return normalized;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (String.fromCharCode(...bytes.subarray(0, 6)).startsWith("GIF8")) return "image/gif";
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  const extension = extname(name).toLowerCase();
  const fromExtension = ({ ".avif": "image/avif", ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" })[extension];
  if (fromExtension) return fromExtension;
  const prefix = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (prefix.startsWith("<svg") || prefix.startsWith("<?xml")) return "image/svg+xml";
  throw imageError("CANVAS_IMAGE_TYPE_UNSUPPORTED", "Canvas could not identify a supported image type.");
}

function extensionForMimeType(mimeType) {
  return ({ "image/avif": ".avif", "image/gif": ".gif", "image/jpeg": ".jpg", "image/png": ".png", "image/svg+xml": ".svg", "image/webp": ".webp" })[mimeType] ?? ".img";
}

function assertImageBytes(bytes, source) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw imageError("CANVAS_IMAGE_EMPTY", `Image ${JSON.stringify(source)} is empty.`);
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw imageError("CANVAS_IMAGE_TOO_LARGE", "Image exceeds the 24 MiB limit.");
  }
}

function imageError(code, message) {
  return Object.assign(new Error(message), { code });
}
