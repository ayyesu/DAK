import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

const MAX_SCRIPT_BYTES = 100_000;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const EXECUTION_TIMEOUT_MS = 5_000;

let quickJsPromise;

export async function executeCanvasScript(document, code, inspection = {}) {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new Error("Canvas script code must be a non-empty string.");
  }
  assertByteLimit(code, MAX_SCRIPT_BYTES, "Canvas script");
  const input = JSON.stringify(document);
  const inspectionInput = JSON.stringify(inspection);
  assertByteLimit(input, MAX_INPUT_BYTES, "Canvas document");
  assertByteLimit(inspectionInput, MAX_INPUT_BYTES, "Canvas inspection context");

  quickJsPromise ??= getQuickJS();
  const QuickJS = await quickJsPromise;
  try {
    const output = QuickJS.evalCode(
      `const __canvasDocumentJson = ${JSON.stringify(input)};\nconst __canvasInspectionJson = ${JSON.stringify(inspectionInput)};\nconst __canvasCode = ${JSON.stringify(code)};\n${SANDBOX_SOURCE}`,
      {
        shouldInterrupt: shouldInterruptAfterDeadline(
          Date.now() + EXECUTION_TIMEOUT_MS,
        ),
        memoryLimitBytes: 64 * 1024 * 1024,
        maxStackSizeBytes: 4 * 1024 * 1024,
      },
    );
    assertByteLimit(output, MAX_OUTPUT_BYTES, "Canvas script result");
    return JSON.parse(output);
  } catch (error) {
    if (error?.code?.startsWith?.("CANVAS_")) throw error;
    throw scriptError(error);
  }
}

export function scriptNeedsInspection(code) {
  return typeof code === "string" && /\b(?:bounds|problems)\b/u.test(code);
}

function assertByteLimit(value, limit, label) {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > limit) {
    const nextAction =
      label === "Canvas script"
        ? "Split the edit into smaller documents.execute calls and validate between them."
        : "Reduce the document or output size and retry with a narrower operation.";
    throw new Error(
      `${label} is ${bytes} bytes; the limit is ${limit} bytes. ${nextAction}`,
    );
  }
}

function scriptError(value) {
  const message =
    typeof value?.message === "string" ? value.message : String(value);
  const error = new Error(`Canvas script failed: ${message}`);
  error.code = message.includes("interrupted")
    ? "CANVAS_SCRIPT_TIMEOUT"
    : "CANVAS_SCRIPT_FAILED";
  return error;
}

const SANDBOX_SOURCE = String.raw`
"use strict";
const __document = JSON.parse(__canvasDocumentJson);
const __inspection = JSON.parse(__canvasInspectionJson);
const __prints = [];
const __touched = new Set();
const __generations = [];
const __svgConversions = [];
const __screenshots = [];
let __changed = false;
let __copyCounter = 0;
const __containerTypes = new Set(["frame", "group"]);
const __clone = (value) => JSON.parse(JSON.stringify(value));
const __cloneShared = (value, cache) => {
  if (!value || typeof value !== "object") return value;
  if (cache.has(value)) return cache.get(value);
  const clone = Array.isArray(value) ? [] : {};
  cache.set(value, clone);
  for (const [key, child] of Object.entries(value)) clone[key] = __cloneShared(child, cache);
  return clone;
};
const __readonly = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) __readonly(child);
  return Object.freeze(value);
};

function __walk(nodes = __document.children, parent = null, parentPath = [], output = []) {
  for (let index = 0; index < (nodes || []).length; index += 1) {
    const node = nodes[index];
    const path = [...parentPath, node.id];
    output.push({ node, parent, index, path });
    __walk(node.children || [], node, path, output);
  }
  return output;
}

function* __walkEntries(nodes = __document.children, parent = null, parentPath = []) {
  for (let index = 0; index < (nodes || []).length; index += 1) {
    const node = nodes[index];
    const path = [...parentPath, node.id];
    const entry = { node, parent, index, path };
    yield entry;
    yield* __walkEntries(node.children || [], node, path);
  }
}

function __unknownComponentProps() {
  const entries = __walk();
  const definitions = new Map(entries.map(({ node }) => [node.id, node]));
  const unknown = new Set();
  for (const { node } of entries) {
    if (node.type !== "ref" || typeof node.ref !== "string" || node.ref.includes(":")) continue;
    const target = definitions.get(node.ref);
    if (!target) continue;
    for (const name of Object.keys(node.props || {})) {
      if (!Object.hasOwn(target.properties || {}, name)) unknown.add(node.id + "\u0000" + name);
    }
  }
  return unknown;
}
const __initialUnknownComponentProps = __unknownComponentProps();

function __assertSelector(selector) {
  if (selector === "*" || selector === undefined || selector === null) return;
  if (typeof selector === "object") return;
  if (typeof selector !== "string") {
    throw new TypeError("A Canvas selector must be a string, node, or context.");
  }
  if (selector.startsWith("#") || selector.startsWith("type:") || selector.startsWith("name:") || selector.includes("/")) return;
  if (selector.includes(":")) {
    throw new Error("Unknown Canvas selector " + JSON.stringify(selector) + ". Expected #id, type:<type>, name:<name>, a slash-separated path, or an exact node id.");
  }
}

function __matches(entry, selector) {
  __assertSelector(selector);
  if (selector === "*" || selector === undefined || selector === null) return true;
  if (typeof selector === "object") {
    const selected = selector.node && typeof selector.node === "object" ? selector.node : selector;
    return typeof selected.id === "string" && entry.node.id === selected.id;
  }
  if (typeof selector !== "string") throw new TypeError("A Canvas selector must be a string, node, or context.");
  if (selector.startsWith("#")) return entry.node.id === selector.slice(1);
  if (selector.startsWith("type:")) return entry.node.type === selector.slice(5);
  if (selector.startsWith("name:")) return entry.node.name === selector.slice(5);
  if (selector.includes("/")) return entry.path.join("/") === selector;
  return entry.node.id === selector;
}

function __entries(selector) {
  const output = [];
  for (const entry of __walkEntries()) {
    if (__matches(entry, selector)) output.push(entry);
  }
  return output;
}

function __requireOne(target) {
  const entries = __entries(target);
  if (entries.length !== 1) {
    throw new Error("Expected one Canvas node, found " + entries.length + ".");
  }
  return entries[0];
}

function __context(entry, cloneCache) {
  const inspected = __inspection[entry.node.id] || {};
  return Object.freeze({
    node: __readonly(__cloneShared(entry.node, cloneCache)),
    parent: entry.parent ? __readonly(__cloneShared(entry.parent, cloneCache)) : null,
    index: entry.index,
    path: entry.path.join("/"),
    bounds: inspected.bounds === undefined ? null : __readonly(__clone(inspected.bounds)),
    problems: __readonly(__clone(inspected.problems || [])),
  });
}

function __touchTree(node) {
  __touched.add(node.id);
  for (const child of node.children || []) __touchTree(child);
}

function __assertContainer(node) {
  if (!__containerTypes.has(node.type)) {
    throw new Error("Canvas node " + node.id + " of type " + node.type + " cannot contain children; use a frame or group.");
  }
}

function __assertNodeTree(node, usedIds) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new TypeError("A Canvas node must be an object.");
  }
  if (typeof node.id !== "string" || node.id.length === 0) {
    throw new Error("Every inserted or replaced Canvas node requires a non-empty id.");
  }
  if (typeof node.type !== "string" || node.type.length === 0) {
    throw new Error("Canvas node " + node.id + " requires a non-empty type.");
  }
  if (usedIds.has(node.id)) throw new Error("Node " + node.id + " already exists.");
  usedIds.add(node.id);
  if (node.children !== undefined && !Array.isArray(node.children)) {
    throw new TypeError("Canvas node " + node.id + " children must be an array.");
  }
  if (node.children !== undefined) __assertContainer(node);
  for (const child of node.children || []) __assertNodeTree(child, usedIds);
}

function __assertParent(parent) {
  const entry = __requireOne(parent);
  __assertContainer(entry.node);
  return entry;
}

function __assertRootSizing(node, parent) {
  if (parent !== null && parent !== undefined) return;
  if (node.width === "fill_container" || node.height === "fill_container") {
    throw new Error("Top-level nodes cannot use fill_container because they have no parent layout container.");
  }
}

globalThis.Get = function Get(selector = "*", visitor, options = {}) {
  __assertSelector(selector);
  const cloneCache = new Map();
  if (visitor !== undefined) {
    if (typeof visitor !== "function") throw new TypeError("Get visitor must be a function.");
    const limit = options.limit === undefined ? Infinity : Number(options.limit);
    if (!(limit === Infinity || (Number.isInteger(limit) && limit >= 1))) {
      throw new RangeError("Get visitor limit must be a positive integer when supplied.");
    }
    let count = 0;
    for (const entry of __walkEntries()) {
      if (!__matches(entry, selector)) continue;
      if (count >= limit) break;
      visitor(__context(entry, cloneCache));
      count += 1;
    }
    return count;
  }
  const limit = options.limit === undefined ? 1000 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("Get limit must be an integer from 1 through 1000.");
  }
  const contexts = [];
  for (const entry of __walkEntries()) {
    if (!__matches(entry, selector)) continue;
    if (contexts.length === limit) {
      throw new Error("Get matched more than " + limit + " nodes; use visitor form for traversal or narrow the selector.");
    }
    contexts.push(__context(entry, cloneCache));
  }
  return contexts;
};

globalThis.Insert = function Insert(parent, node, position) {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new TypeError("Insert requires one node object.");
  __assertNodeTree(node, new Set(__walk().map((entry) => entry.node.id)));
  __assertRootSizing(node, parent);
  const parentEntry = parent === null || parent === undefined ? null : __assertParent(parent);
  const children = parentEntry ? (parentEntry.node.children ||= []) : (__document.children ||= []);
  const index = position === undefined ? children.length : Number(position);
  if (!Number.isInteger(index) || index < 0 || index > children.length) throw new RangeError("Insert position is outside the parent.");
  children.splice(index, 0, __clone(node));
  __changed = true;
  __touchTree(node);
  if (parentEntry) __touched.add(parentEntry.node.id);
  return node.id;
};

globalThis.Update = function Update(target, properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new TypeError("Update requires a property object.");
  const entry = __requireOne(target);
  const node = entry.node;
  const previousProperties = Object.keys(node.properties || {});
  const previousSubtreeIds = new Set();
  const collectPreviousIds = (current) => {
    previousSubtreeIds.add(current.id);
    for (const child of current.children || []) collectPreviousIds(child);
  };
  collectPreviousIds(node);
  if (Object.hasOwn(properties, "id") && properties.id !== node.id) throw new Error("Update cannot change a node id.");
  if (Object.hasOwn(properties, "children") || Object.hasOwn(properties, "type")
    || Object.hasOwn(properties, "width") || Object.hasOwn(properties, "height")
    || Object.hasOwn(properties, "properties")) {
    const next = __clone(node);
    for (const [key, value] of Object.entries(properties)) {
      if (key === "id") continue;
      if (value === undefined) delete next[key];
      else next[key] = __clone(value);
    }
    __assertNodeTree(
      next,
      new Set(__walk().map((candidate) => candidate.node.id).filter((id) => !previousSubtreeIds.has(id))),
    );
    __assertRootSizing(next, entry.parent);
    if (Object.hasOwn(properties, "properties")) __assertRemovedComponentPropsUnused(next, previousProperties);
  }
  for (const [key, value] of Object.entries(properties)) {
    if (key === "id") continue;
    if (value === undefined) {
      if (Object.hasOwn(node, key)) {
        delete node[key];
        __changed = true;
      }
    } else if (JSON.stringify(node[key]) !== JSON.stringify(value)) {
      node[key] = __clone(value);
      __changed = true;
    }
  }
  if (Object.hasOwn(properties, "properties")) __pruneRemovedComponentProps(node.id, previousProperties, node.properties);
  __touched.add(node.id);
  return node;
};

function __pruneRemovedComponentProps(componentId, previousProperties, nextProperties) {
  const removed = previousProperties.filter((name) => !Object.hasOwn(nextProperties || {}, name));
  if (removed.length === 0) return;
  for (const { node } of __walk()) {
    if (node.type !== "ref" || node.ref !== componentId || !node.props) continue;
    for (const name of removed) {
      if (!Object.hasOwn(node.props, name)) continue;
      delete node.props[name];
      __changed = true;
      __touched.add(node.id);
    }
    if (Object.keys(node.props).length === 0) delete node.props;
  }
}

function __assertRemovedComponentPropsUnused(source, previousProperties) {
  const removed = new Set(previousProperties.filter((name) => !Object.hasOwn(source.properties || {}, name)));
  if (removed.size === 0) return;
  const referencesRemoved = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Object.keys(value.when?.props || {}).some((name) => removed.has(name))) return true;
    if (typeof value.arg?.prop === "string" && removed.has(value.arg.prop)) return true;
    return Object.values(value).some(referencesRemoved);
  };
  const inspect = (node, isRoot = false) => {
    if (!isRoot && node.properties) return;
    for (const binding of Object.values(node.bind || {})) {
      if (typeof binding === "string" && binding.startsWith("$props.") && removed.has(binding.slice(7))) {
        throw new Error("Component " + source.id + " still binds removed property " + binding.slice(7) + ".");
      }
    }
    if (referencesRemoved(node.visible)) throw new Error("Component " + source.id + " still has a condition using a removed property.");
    for (const [key, value] of Object.entries(node)) {
      if (["children", "properties", "bind", "visible"].includes(key)) continue;
      if (referencesRemoved(value)) throw new Error("Component " + source.id + " still has a conditional value using a removed property.");
    }
    for (const child of node.children || []) inspect(child);
  };
  inspect(source, true);
}

globalThis.SetModule = function SetModule(module) {
  const allowed = new Set(["deck", "web", "mobile"]);
  if (!allowed.has(module)) throw new Error("SetModule requires deck, web, or mobile.");
  if (__document.module !== "generic") throw new Error("Only a generic Canvas document can set its module later.");
  if (__walk().some((entry) => entry.node.role !== undefined)) throw new Error("SetModule requires a document with no role-bearing frames.");
  __document.module = module;
  __changed = true;
  return module;
};

globalThis.GetVariables = function GetVariables() {
  return __readonly(__clone(__document.variables || {}));
};

globalThis.GetAxes = function GetAxes() {
  return __readonly(__clone(__document.axes || {}));
};

globalThis.GetParagraphStyles = function GetParagraphStyles() {
  return __readonly(__clone(__document.paragraphStyles || {}));
};

globalThis.SetVariable = function SetVariable(name, definition) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("SetVariable requires a non-empty name.");
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new TypeError("SetVariable requires a variable definition object.");
  }
  const next = __clone(definition);
  __document.variables ||= {};
  if (JSON.stringify(__document.variables[name]) !== JSON.stringify(next)) {
    __document.variables[name] = next;
    __changed = true;
  }
  return name;
};

globalThis.SetAxis = function SetAxis(name, definition) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("SetAxis requires a non-empty name.");
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new TypeError("SetAxis requires an axis definition object.");
  }
  const next = __clone(definition);
  __document.axes ||= {};
  if (JSON.stringify(__document.axes[name]) !== JSON.stringify(next)) {
    __document.axes[name] = next;
    __changed = true;
  }
  return name;
};

globalThis.SetParagraphStyle = function SetParagraphStyle(name, definition) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("SetParagraphStyle requires a non-empty name.");
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new TypeError("SetParagraphStyle requires a style definition object.");
  }
  const next = __clone(definition);
  __document.paragraphStyles ||= {};
  if (JSON.stringify(__document.paragraphStyles[name]) !== JSON.stringify(next)) {
    __document.paragraphStyles[name] = next;
    __changed = true;
  }
  return name;
};

globalThis.Replace = function Replace(target, replacement) {
  const entry = __requireOne(target);
  const previousProperties = Object.keys(entry.node.properties || {});
  if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) throw new TypeError("Replace requires one node object.");
  const next = __clone(replacement);
  next.id ??= entry.node.id;
  const replacedIds = new Set();
  const collectReplacedIds = (node) => {
    replacedIds.add(node.id);
    for (const child of node.children || []) collectReplacedIds(child);
  };
  collectReplacedIds(entry.node);
  __assertNodeTree(
    next,
    new Set(__walk().map((candidate) => candidate.node.id).filter((id) => !replacedIds.has(id))),
  );
  __assertRootSizing(next, entry.parent);
  if (next.id === entry.node.id) __assertRemovedComponentPropsUnused(next, previousProperties);
  const siblings = entry.parent ? entry.parent.children : __document.children;
  if (JSON.stringify(entry.node) !== JSON.stringify(next)) {
    siblings.splice(entry.index, 1, next);
    __changed = true;
  }
  if (next.id === entry.node.id) __pruneRemovedComponentProps(next.id, previousProperties, next.properties);
  __touchTree(next);
  if (entry.parent) __touched.add(entry.parent.id);
  return next.id;
};

globalThis.Delete = function Delete(target) {
  const entry = __requireOne(target);
  const siblings = entry.parent ? entry.parent.children : __document.children;
  siblings.splice(entry.index, 1);
  __changed = true;
  __touched.add(entry.node.id);
  if (entry.parent) __touched.add(entry.parent.id);
  return entry.node.id;
};

globalThis.Move = function Move(target, parent, position) {
  const entry = __requireOne(target);
  __assertRootSizing(entry.node, parent);
  const parentEntry = parent === null || parent === undefined ? null : __assertParent(parent);
  const source = entry.parent ? entry.parent.children : __document.children;
  source.splice(entry.index, 1);
  const destination = parentEntry ? (parentEntry.node.children ||= []) : __document.children;
  const index = position === undefined ? destination.length : Number(position);
  if (!Number.isInteger(index) || index < 0 || index > destination.length) throw new RangeError("Move position is outside the parent.");
  destination.splice(index, 0, entry.node);
  __changed = true;
  __touched.add(entry.node.id);
  if (entry.parent) __touched.add(entry.parent.id);
  if (parentEntry) __touched.add(parentEntry.node.id);
  return entry.node.id;
};

function __renewIds(node, usedIds) {
  const base = node.id || "node";
  do node.id = base + "-copy-" + (++__copyCounter);
  while (usedIds.has(node.id));
  usedIds.add(node.id);
  for (const child of node.children || []) __renewIds(child, usedIds);
}

globalThis.Copy = function Copy(target, parent, position, properties = {}) {
  const copy = __clone(__requireOne(target).node);
  if (Object.hasOwn(properties, "id") || Object.hasOwn(properties, "children")) {
    throw new Error("Copy overrides cannot replace id or children.");
  }
  __renewIds(copy, new Set(__walk().map((entry) => entry.node.id)));
  Object.assign(copy, __clone(properties));
  Insert(parent, copy, position);
  return copy.id;
};

globalThis.Print = function Print(...values) {
  if (__prints.length >= 1000) throw new Error("Print is limited to 1,000 entries; return a narrower result.");
  __prints.push(values.length === 1 ? values[0] : values);
};

globalThis.TakeScreenshot = function TakeScreenshot(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TypeError("TakeScreenshot requires a non-empty array of exact node targets.");
  }
  const nodeIds = targets.map((target) => __requireOne(target).node.id);
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new Error("TakeScreenshot targets must be unique.");
  }
  if (__screenshots.length > 0) {
    throw new Error("TakeScreenshot may be called once per execution; pass every node to one array.");
  }
  __screenshots.push({ nodeIds });
  return nodeIds;
};

globalThis.G = function G(target, source, prompt) {
  const entry = __requireOne(target);
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("G source must be an image URL, absolute file path, or 'ai'.");
  }
  let url = source;
  if (source === "ai") {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new TypeError("G " + source + " generation requires a non-empty prompt.");
    }
    if (__generations.length >= 20) throw new Error("G is limited to 20 generated images per execution.");
    url = "penkra-generation://" + __generations.length;
    __generations.push({ nodeId: entry.node.id, kind: source, prompt: prompt.trim(), url });
  } else if (prompt !== undefined) {
    throw new TypeError("G accepts a prompt only for the 'ai' source.");
  }
  entry.node.fill = { type: "image", url, mode: "fill" };
  __changed = true;
  __touched.add(entry.node.id);
  return entry.node.id;
};

globalThis.ConvertSvgToVectors = function ConvertSvgToVectors(target, options = {}) {
  const entry = __requireOne(target);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("ConvertSvgToVectors options must be an object.");
  }
  const mode = options.mode === undefined ? "copy" : options.mode;
  if (mode !== "copy" && mode !== "replace") {
    throw new Error("ConvertSvgToVectors mode must be copy or replace.");
  }
  const fills = (Array.isArray(entry.node.fill) ? entry.node.fill : [entry.node.fill]).filter(Boolean);
  if (fills.length !== 1 || fills[0]?.type !== "image" || typeof fills[0].url !== "string") {
    throw new Error("ConvertSvgToVectors requires a node with exactly one image fill.");
  }
  const usedIds = new Set(__walk().map((candidate) => candidate.node.id));
  let createdId = entry.node.id;
  if (mode === "copy") {
    const base = entry.node.id + "-editable";
    createdId = base;
    let suffix = 1;
    while (usedIds.has(createdId)) createdId = base + "-" + (++suffix);
  }
  __svgConversions.push({
    sourceNodeId: entry.node.id,
    createdId,
    mode,
    offset: mode === "copy" ? Number(options.offset ?? 24) : 0,
  });
  __changed = true;
  __touched.add(entry.node.id);
  __touched.add(createdId);
  return createdId;
};

const __result = (0, eval)("(function () {\n" + __canvasCode + "\n})()");
for (const entry of __unknownComponentProps()) {
  if (__initialUnknownComponentProps.has(entry)) continue;
  const [instanceId, name] = entry.split("\u0000");
  throw new Error("Instance " + instanceId + " supplies undeclared component property " + name + ".");
}
JSON.stringify({ document: __document, changed: __changed, prints: __prints, result: __result === undefined ? null : __result, touchedNodeIds: [...__touched], generations: __generations, svgConversions: __svgConversions, screenshots: __screenshots });
`;
