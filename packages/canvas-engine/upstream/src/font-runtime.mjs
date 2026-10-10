import { fontManager } from "../vendor/open-pencil/engine.source.mjs";

const DATABASE_NAME = "penkra-canvas-fonts";
const STORE_NAME = "faces";
const DATABASE_VERSION = 1;

export function configureCanvasFonts(runtime, options = {}) {
  if (!runtime?.network?.fetch) {
    throw new Error("Canvas font loading requires the Penkra network service.");
  }
  const cache = options.cache ?? createDownloadedFontCache(options.indexedDB ?? globalThis.indexedDB);
  fontManager.setDownloadedFontCache(cache);
  fontManager.setOnlineFontProviders({
    google: true,
    fontsource: true,
    bunny: false,
    fontshare: false,
  });
  fontManager.setWebFontFetch(async (url, init = {}) => {
    const startedAt = performance.now();
    try {
      const response = await runtime.network.fetch({
        url,
        method: normalizeMethod(init.method),
        headers: headersObject(init.headers),
        ...(init.body === undefined || init.body === null
          ? {}
          : { body: await requestBody(init.body) }),
      });
      options.performanceMonitor?.record("font.network-fetch", performance.now() - startedAt, {
        host: new URL(response.url || url).hostname,
        status: response.status,
        bytes: response.body.byteLength,
      });
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      options.performanceMonitor?.record("font.network-fetch-failed", performance.now() - startedAt, {
        host: safeHostname(url),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

export function createDownloadedFontCache(indexedDB) {
  if (!indexedDB) return null;
  let databasePromise;
  const database = () => {
    databasePromise ??= openDatabase(indexedDB);
    return databasePromise;
  };
  return {
    async read(family, style, characters = "") {
      const record = await transaction(await database(), "readonly", (store) => store.get(key(family, style)));
      if (!record?.bytes) return null;
      const coverage = new Set(Array.from(record.characters ?? ""));
      if (Array.from(characters).some((character) => !coverage.has(character))) return null;
      return record.bytes.slice(0);
    },
    async write(family, style, bytes, characters = "") {
      await transaction(await database(), "readwrite", (store) => store.put({
        id: key(family, style),
        family,
        style,
        characters: Array.from(new Set(characters)).sort().join(""),
        bytes: bytes.slice(0),
        updatedAt: new Date().toISOString(),
      }));
    },
  };
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the Canvas font cache."));
    request.onblocked = () => reject(new Error("The Canvas font cache upgrade is blocked by another tab."));
  });
}

function transaction(database, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, mode);
    const request = operation(tx.objectStore(STORE_NAME));
    let result;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error ?? new Error("Canvas font cache operation failed."));
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error("Canvas font cache transaction was aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("Canvas font cache transaction failed."));
  });
}

function key(family, style) {
  return `${family}\u0000${style}`;
}

function normalizeMethod(method) {
  const normalized = String(method ?? "GET").toUpperCase();
  if (!["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"].includes(normalized)) {
    throw new Error(`Canvas font request does not support ${normalized}.`);
  }
  return normalized;
}

function headersObject(headers) {
  return Object.fromEntries(new Headers(headers).entries());
}

async function requestBody(body) {
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error("Canvas font requests require a string or binary body.");
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid-url";
  }
}
