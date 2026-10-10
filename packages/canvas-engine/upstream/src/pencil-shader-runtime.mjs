const SUPPORTED_TYPES = new Set([
  "float", "int", "bool",
  "vec2", "vec3", "vec4",
  "ivec2", "ivec3", "ivec4",
  "sampler2D",
]);
const AUTO_DIRECTIVES = new Set(["resolution", "mouse", "time", "sdf", "backdrop"]);

export function parsePencilShader(source) {
  if (typeof source !== "string") throw new TypeError("Pencil shader source must be text.");
  if (/^\s*#version\s+(?!100\b)/mu.test(source)) {
    throw new Error("Pencil shaders must use WebGL 1.0 (#version 100).");
  }
  const uniforms = [];
  const declaration = /\buniform\s+(float|int|bool|vec[234]|ivec[234]|sampler2D)\s+([A-Za-z_]\w*)\s*;/gu;
  for (const match of source.matchAll(declaration)) {
    const [, type, name] = match;
    if (!SUPPORTED_TYPES.has(type)) throw new Error(`Unsupported Pencil shader uniform type ${type}.`);
    const comment = immediatelyPrecedingBlockComment(source, match.index);
    const directives = parseDirectives(comment);
    const automatic = [...AUTO_DIRECTIVES].filter((key) => directives[key] === true);
    if (automatic.length > 1) {
      throw new Error(`Shader uniform ${name} has conflicting automatic directives: ${automatic.join(", ")}.`);
    }
    validateAutomaticDirective(name, type, automatic[0]);
    uniforms.push({
      name,
      type,
      label: directives.label ?? name,
      color: directives.color === true,
      automatic: automatic[0] ?? null,
      defaultValue: parseDirectiveValue(directives.default, type, name),
      min: parseFiniteNumber(directives.min, name, "min"),
      max: parseFiniteNumber(directives.max, name, "max"),
    });
    if (directives.range) {
      const range = directives.range.split(",").map((value) => Number(value.trim()));
      if (range.length !== 2 || range.some((value) => !Number.isFinite(value))) {
        throw new Error(`Shader uniform ${name} has an invalid @range directive.`);
      }
      uniforms.at(-1).min = range[0];
      uniforms.at(-1).max = range[1];
    }
  }
  return { source, uniforms };
}

export function resolvePencilShaderUniforms(definition, overrides = {}) {
  const values = {};
  const known = new Set(definition.uniforms.map(({ name }) => name));
  for (const name of Object.keys(overrides ?? {})) {
    if (!known.has(name)) throw new Error(`Pencil shader override ${name} is not a declared uniform.`);
  }
  for (const uniform of definition.uniforms) {
    if (uniform.automatic) {
      if (Object.hasOwn(overrides ?? {}, uniform.name)) {
        throw new Error(`Automatic shader uniform ${uniform.name} cannot be overridden.`);
      }
      continue;
    }
    const raw = Object.hasOwn(overrides ?? {}, uniform.name)
      ? overrides[uniform.name]
      : uniform.defaultValue;
    if (raw === undefined) throw new Error(`Shader uniform ${uniform.name} has no value or @default.`);
    values[uniform.name] = validateUniformValue(raw, uniform);
  }
  return values;
}

export function transpilePencilShaderWebGL1(definition) {
  const samplers = new Set(definition.uniforms.filter(({ type }) => type === "sampler2D").map(({ name }) => name));
  const used = new Set();
  const source = replaceTextureSizeCalls(definition.source, samplers, used);
  if (used.size === 0) return source;
  const declarations = [...used].map((name) => `uniform vec2 __pencil_texture_size_${name};`).join("\n");
  const version = /^\s*#version\s+100\s*$/mu;
  return version.test(source)
    ? source.replace(version, (line) => `${line}\n${declarations}`)
    : `${declarations}\n${source}`;
}

function replaceTextureSizeCalls(source, samplers, used) {
  let output = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      const next = end < 0 ? source.length : end;
      output += source.slice(index, next);
      index = next;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const next = end < 0 ? source.length : end + 2;
      output += source.slice(index, next);
      index = next;
      continue;
    }
    if (!source.startsWith("textureSize", index) || /\w/u.test(source[index - 1] ?? "") || /\w/u.test(source[index + 11] ?? "")) {
      output += source[index++];
      continue;
    }
    let cursor = skipWhitespace(source, index + 11);
    if (source[cursor] !== "(") throw new Error("Pencil textureSize must be called as a function.");
    cursor = skipWhitespace(source, cursor + 1);
    const samplerMatch = /^[A-Za-z_]\w*/u.exec(source.slice(cursor));
    if (!samplerMatch || !samplers.has(samplerMatch[0])) {
      throw new Error("Pencil textureSize first argument must be a declared sampler2D uniform.");
    }
    const sampler = samplerMatch[0];
    cursor = skipWhitespace(source, cursor + sampler.length);
    if (source[cursor] !== ",") throw new Error("Pencil textureSize requires a sampler and LOD argument.");
    cursor += 1;
    let depth = 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "(") depth += 1;
      else if (source[cursor] === ")") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) throw new Error("Pencil textureSize call is missing its closing parenthesis.");
    used.add(sampler);
    output += `__pencil_texture_size_${sampler}`;
    index = cursor;
  }
  return output;
}

function skipWhitespace(source, index) {
  while (/\s/u.test(source[index] ?? "")) index += 1;
  return index;
}

function immediatelyPrecedingBlockComment(source, declarationIndex) {
  const prefix = source.slice(0, declarationIndex);
  const match = /\/\*((?:(?!\*\/)[\s\S])*)\*\/\s*$/u.exec(prefix);
  return match?.[1] ?? "";
}

function parseDirectives(comment) {
  const directives = {};
  for (const rawLine of comment.split(/\r?\n/u)) {
    const line = rawLine.replace(/^\s*\*?\s*/u, "");
    const match = /^@(color|resolution|mouse|time|sdf|backdrop)\s*$/u.exec(line);
    if (match) {
      directives[match[1]] = true;
      continue;
    }
    const valued = /^@(default|min|max|range|label)\s+(.+?)\s*$/u.exec(line);
    if (valued) directives[valued[1]] = valued[2];
  }
  return directives;
}

function validateAutomaticDirective(name, type, directive) {
  if (!directive) return;
  const required = {
    resolution: "vec2",
    mouse: "vec2",
    time: "float",
    sdf: "sampler2D",
    backdrop: "sampler2D",
  }[directive];
  if (type !== required) throw new Error(`@${directive} shader uniform ${name} must have type ${required}.`);
}

function parseFiniteNumber(raw, name, directive) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Shader uniform ${name} has an invalid @${directive} directive.`);
  return value;
}

function parseDirectiveValue(raw, type, name) {
  if (raw === undefined) return undefined;
  if (type === "bool") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  if (type === "float" || type === "int") {
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  if (/^[i]?vec[234]$/u.test(type)) {
    if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(raw)) return raw;
    const values = raw.replace(/^\[|\]$/gu, "").split(",").map((value) => Number(value.trim()));
    if (values.every(Number.isFinite)) return values;
  }
  if (type === "sampler2D") return raw.replace(/^(?:"|')|(?:"|')$/gu, "");
  throw new Error(`Shader uniform ${name} has an invalid @default value.`);
}

function validateUniformValue(raw, uniform) {
  const { type, name } = uniform;
  if (type === "float" || type === "int") {
    if (typeof raw !== "number" || !Number.isFinite(raw) || type === "int" && !Number.isInteger(raw)) {
      throw new Error(`Shader uniform ${name} requires a ${type}.`);
    }
    if (uniform.min !== undefined && raw < uniform.min || uniform.max !== undefined && raw > uniform.max) {
      throw new Error(`Shader uniform ${name} is outside its declared range.`);
    }
    return raw;
  }
  if (type === "bool") {
    if (typeof raw !== "boolean") throw new Error(`Shader uniform ${name} requires a boolean.`);
    return raw;
  }
  if (type === "sampler2D") {
    if (typeof raw !== "string" || raw.length === 0) throw new Error(`Shader uniform ${name} requires an image URL.`);
    return raw;
  }
  const length = Number(type.at(-1));
  if (typeof raw === "string" && uniform.color && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(raw)) return raw;
  if (!Array.isArray(raw) || raw.length !== length || raw.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`Shader uniform ${name} requires ${type}.`);
  }
  if (type.startsWith("ivec") && raw.some((value) => !Number.isInteger(value))) {
    throw new Error(`Shader uniform ${name} requires integer components.`);
  }
  return [...raw];
}
