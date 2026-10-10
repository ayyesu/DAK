import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

const SUPPORTED_SCHEMA_VERSIONS = new Set(["2.11", "2.17"]);
const EXECUTION_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_NODES = 1_000;

let quickJsPromise;
let quickJs;

export async function preparePencilScriptRuntime() {
  quickJsPromise ??= getQuickJS().then((runtime) => {
    quickJs = runtime;
    return runtime;
  });
  return quickJsPromise;
}

export function parsePencilScriptHeader(code) {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new Error("The Pencil script file is empty.");
  }
  const header = code.match(/^\s*\/\*\*([\s\S]*?)\*\//u)?.[1];
  if (header === undefined) throw new Error("Pencil scripts require a leading /** ... */ header.");
  const schema = header.match(/(?:^|\n)\s*\*?\s*@schema\s+(\S+)\s*(?:\n|$)/u)?.[1];
  if (!SUPPORTED_SCHEMA_VERSIONS.has(schema)) {
    throw new Error(`Pencil script schema ${schema ?? "(missing)"} is not supported (expected 2.11 or 2.17).`);
  }
  const inputs = [];
  for (const line of header.split(/\r?\n/u)) {
    const declaration = line.replace(/^\s*\*?\s*/u, "").trim();
    if (!declaration.startsWith("@input")) continue;
    inputs.push(parseInputDeclaration(declaration));
  }
  return { schema, inputs };
}

export function executePencilScript(code, options) {
  if (!quickJs) throw new Error("The Pencil script runtime has not been prepared.");
  const header = parsePencilScriptHeader(code);
  const width = finiteDimension(options?.width, "width");
  const height = finiteDimension(options?.height, "height");
  const input = resolveInputs(header.inputs, options?.inputs ?? {});
  const pencilJson = JSON.stringify({ width, height, input });
  const source = `
"use strict";
const pencil = Object.freeze(JSON.parse(${JSON.stringify(pencilJson)}));
Object.freeze(pencil.input);
let __pencilRandomState = 0x6d2b79f5;
Math.random = function () {
  __pencilRandomState = (__pencilRandomState + 0x6d2b79f5) | 0;
  let value = __pencilRandomState;
  value = Math.imul(value ^ value >>> 15, value | 1);
  value ^= value + Math.imul(value ^ value >>> 7, value | 61);
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
};
const __pencilResult = (function (pencil) {
${code}
})(pencil);
JSON.stringify(__pencilResult);
`;
  let serialized;
  try {
    serialized = quickJs.evalCode(source, {
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + EXECUTION_TIMEOUT_MS),
      memoryLimitBytes: 64 * 1024 * 1024,
      maxStackSizeBytes: 4 * 1024 * 1024,
    });
  } catch (error) {
    const message = typeof error?.message === "string" ? error.message : String(error);
    throw new Error(`Pencil script failed: ${message}`);
  }
  if (typeof serialized !== "string") throw new Error("Pencil script must return an array of nodes.");
  let output;
  try {
    output = JSON.parse(serialized);
  } catch {
    throw new Error("Canvas script returned a value that cannot be represented in a Canvas document.");
  }
  if (!Array.isArray(output)) throw new Error("Pencil script must return an array of nodes.");
  validateOutputNodes(output);
  return { header, input, nodes: output };
}

function parseInputDeclaration(line) {
  const match = line.match(/^@input\s+([A-Za-z_$][\w$]*):\s*(number|string|boolean|color|enum|ref)(?:\((.*)\))?(?:\s*=\s*(.+))?$/u);
  if (!match) throw new Error(`Invalid Pencil script input declaration: ${line}`);
  const [, name, type, rawArguments, rawDefault] = match;
  const definition = { name, type };
  if (type === "number") {
    for (const argument of splitArguments(rawArguments)) {
      const constraint = argument.match(/^(min|max)\s*=\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/u);
      if (!constraint) throw new Error(`Invalid number input argument ${argument} for ${name}.`);
      definition[constraint[1]] = Number(constraint[2]);
    }
  } else if (type === "enum") {
    definition.options = splitArguments(rawArguments).map((value) => parseQuoted(value, name));
    if (definition.options.length === 0) throw new Error(`Enum input ${name} requires at least one option.`);
  } else if (rawArguments?.trim()) {
    throw new Error(`${type} input ${name} does not accept arguments.`);
  }
  if (rawDefault !== undefined) definition.default = parseDefault(rawDefault.trim(), type, definition);
  return definition;
}

function resolveInputs(definitions, values) {
  const input = {};
  for (const definition of definitions) {
    const value = Object.hasOwn(values, definition.name) ? values[definition.name] : definition.default;
    input[definition.name] = validateInputValue(value, definition);
  }
  return input;
}

function validateInputValue(value, definition) {
  if (definition.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Pencil script input ${definition.name} requires a number.`);
    return Math.min(definition.max ?? Infinity, Math.max(definition.min ?? -Infinity, value));
  }
  if (definition.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Pencil script input ${definition.name} requires a boolean.`);
    return value;
  }
  if (definition.type === "color") {
    if (typeof value !== "string" || !/^#[\da-f]{6}(?:[\da-f]{2})?$/iu.test(value)) {
      throw new Error(`Pencil script input ${definition.name} requires a hex color.`);
    }
    return value;
  }
  if (definition.type === "enum") {
    if (!definition.options.includes(value)) throw new Error(`Pencil script input ${definition.name} is not a declared enum option.`);
    return value;
  }
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Pencil script input ${definition.name} requires a string${definition.type === "ref" ? " reference" : ""}.`);
  }
  return value ?? "";
}

function parseDefault(value, type, definition) {
  if (type === "number") return validateInputValue(Number(value), definition);
  if (type === "boolean") {
    if (!/^(?:true|false)$/u.test(value)) throw new Error(`Boolean input ${definition.name} has an invalid default.`);
    return value === "true";
  }
  if (type === "color" && value.startsWith("#")) return validateInputValue(value, definition);
  return validateInputValue(parseQuoted(value, definition.name), definition);
}

function parseQuoted(value, name) {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
  } catch {}
  throw new Error(`Pencil script input ${name} requires a quoted string.`);
}

function splitArguments(value = "") {
  if (!value.trim()) return [];
  const matches = value.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,])+/gu) ?? [];
  return matches.map((part) => part.trim()).filter(Boolean);
}

function finiteDimension(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Pencil script ${name} must resolve to a finite non-negative number.`);
  }
  return value;
}

function validateOutputNodes(nodes) {
  let count = 0;
  const visit = (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.type !== "string") {
      throw new Error("Pencil script output contains an invalid node.");
    }
    count += 1;
    if (count > MAX_OUTPUT_NODES) throw new Error(`Pencil script returned more than ${MAX_OUTPUT_NODES} nodes.`);
    if (node.children !== undefined && !Array.isArray(node.children)) {
      throw new Error("Pencil script node children must be an array.");
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
}
