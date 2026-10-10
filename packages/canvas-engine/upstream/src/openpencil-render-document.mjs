import { pencilIconDefinition } from "./pencil-icon-provider.mjs";
import { pencilResourceAsset, resolvePencilResourcePath } from "./pencil-resources.mjs";
import { executePencilScript } from "./pencil-script-runtime.mjs";
import {
  parsePencilShader,
  resolvePencilShaderUniforms,
  transpilePencilShaderWebGL1,
} from "./pencil-shader-runtime.mjs";
import { normalizePencilMeshGradient } from "./pencil-mesh-gradient.mjs";
import { normalizeStrokeDash } from "./stroke-dash.mjs";
import { variantMemberProperties, variantSelection } from "./component-variants.mjs";

const NUMERIC_PROPERTIES = new Set([
  "x",
  "y",
  "width",
  "height",
  "gap",
  "opacity",
  "rotation",
  "strokeWidth",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "thickness",
  "weight",
  "radius",
  "spread",
  "blur",
  "startAngle",
  "sweepAngle",
  "innerRadius",
  "polygonCount",
  "position",
  "top",
  "right",
  "bottom",
  "left",
]);

const BOOLEAN_PROPERTIES = new Set([
  "enabled",
  "clip",
  "flipX",
  "flipY",
  "underline",
  "strikethrough",
]);
const STRING_PROPERTIES = new Set([
  "fontFamily",
  "fontStyle",
  "content",
  "model",
  "library",
  "icon",
  "color",
]);
const NUMBER_OR_STRING_PROPERTIES = new Set(["fontWeight"]);
const NUMERIC_ARRAY_PROPERTIES = new Set(["cornerRadius", "padding"]);
const VARIABLE_PROPERTIES = new Set([
  ...NUMERIC_PROPERTIES,
  ...BOOLEAN_PROPERTIES,
  ...STRING_PROPERTIES,
  ...NUMBER_OR_STRING_PROPERTIES,
  ...NUMERIC_ARRAY_PROPERTIES,
  "fill",
  "stroke",
  "colors",
]);

export function prepareOpenPencilRenderDocument(source, options = {}) {
  const document = lowerCanvasModelForOpenPencil(source);
  const variables = document?.variables && typeof document.variables === "object"
    ? document.variables
    : {};
  const defaultTheme = Object.fromEntries(
    Object.entries(document?.themes ?? {})
      .filter(([, values]) => Array.isArray(values) && typeof values[0] === "string")
      .map(([axis, values]) => [axis, values[0]]),
  );
  const issues = [];
  const iconRequests = options.iconRequests;
  const assets = options.assets instanceof Map ? options.assets : new Map();
  const containerPath = typeof options.containerPath === "string" ? options.containerPath : "";

  const resolveReference = (reference, theme, trail = []) => {
    const name = reference.slice(1);
    if (trail.includes(name)) {
      return { ok: false, reason: `Variable cycle: ${[...trail, name].join(" → ")}` };
    }
    const definition = variables[name];
    if (!definition || typeof definition !== "object" || !("value" in definition)) {
      return { ok: false, reason: `Variable ${reference} was not found.` };
    }
    const selected = selectVariableValue(definition.value, theme);
    if (!selected.ok) return selected;
    if (isKnownVariableReference(selected.value, variables)) {
      return resolveReference(selected.value, theme, [...trail, name]);
    }
    return { ok: true, value: structuredClone(selected.value) };
  };

  const resolveValue = (value, property, theme, nodeId) => {
    if (isInterpolatedVariableReference(value, property)) {
      const references = [...value.matchAll(VARIABLE_INTERPOLATION_PATTERN)];
      const isWholeReference = references.length === 1 && references[0][0] === value;
      if (isWholeReference) {
        const reference = `$${references[0][1]}`;
        const resolved = resolveReference(reference, theme);
        if (!resolved.ok) {
          issues.push(variableIssue(nodeId, value, resolved.reason));
          return safeFallback(property, value);
        }
        if (!validPropertyValue(property, resolved.value)) {
          issues.push(variableIssue(
            nodeId,
            value,
            `Variable ${value} resolved to an invalid ${property} value.`,
          ));
          return safeFallback(property, value);
        }
        return resolved.value;
      }
      if (!STRING_PROPERTIES.has(property) && !NUMBER_OR_STRING_PROPERTIES.has(property)) return value;
      let failed = false;
      const interpolated = value.replace(VARIABLE_INTERPOLATION_PATTERN, (token, name) => {
        const resolved = resolveReference(`$${name}`, theme);
        if (!resolved.ok) {
          issues.push(variableIssue(nodeId, token, resolved.reason));
          failed = true;
          return "";
        }
        if (!["string", "number", "boolean"].includes(typeof resolved.value)) {
          issues.push(variableIssue(
            nodeId,
            token,
            `Variable ${token} cannot be interpolated as text.`,
          ));
          failed = true;
          return "";
        }
        return String(resolved.value);
      });
      return failed && !validPropertyValue(property, interpolated)
        ? safeFallback(property, value)
        : interpolated;
    }
    // Legacy whole-value references remain readable in unmigrated documents.
    if (isLegacyVariableReference(value, property)) {
      const resolved = resolveReference(value, theme);
      if (!resolved.ok) {
        issues.push(variableIssue(nodeId, value, resolved.reason));
        return safeFallback(property, value);
      }
      if (!validPropertyValue(property, resolved.value)) {
        issues.push(variableIssue(
          nodeId,
          value,
          `Variable ${value} resolved to an invalid ${property} value.`,
        ));
        return safeFallback(property, value);
      }
      return resolved.value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => resolveValue(item, property, theme, nodeId));
    }
    if (value && typeof value === "object") {
      return resolveObject(value, theme, nodeId);
    }
    return value;
  };

  const resolveObject = (object, inheritedTheme, inheritedNodeId = null) => {
    const theme = isRecord(object.theme)
      ? { ...inheritedTheme, ...object.theme }
      : inheritedTheme;
    const nodeId = typeof object.id === "string" ? object.id : inheritedNodeId;
    for (const [property, value] of Object.entries(object)) {
      if (property === "theme") continue;
      if (object.type === "script" && property === "inputs" && isRecord(value)) {
        object[property] = Object.fromEntries(Object.entries(value).map(([name, inputValue]) => {
          if (!isKnownVariableReference(inputValue, variables)) return [name, inputValue];
          const resolved = resolveReference(inputValue, theme);
          if (!resolved.ok) {
            issues.push(variableIssue(nodeId, inputValue, resolved.reason));
            return [name, inputValue];
          }
          return [name, resolved.value];
        }));
        continue;
      }
      if (object.type === "shader" && property === "uniforms" && isRecord(value)) {
        object[property] = Object.fromEntries(Object.entries(value).map(([name, uniformValue]) => {
          if (!isKnownVariableReference(uniformValue, variables)) return [name, uniformValue];
          const resolved = resolveReference(uniformValue, theme);
          if (!resolved.ok) {
            issues.push(variableIssue(nodeId, uniformValue, resolved.reason));
            return [name, uniformValue];
          }
          return [name, resolved.value];
        }));
        continue;
      }
      object[property] = resolveValue(value, property, theme, nodeId);
    }
    if (object.type === "text") {
      const styleNames = new Set([object.style, ...(object.paragraphs ?? []).map((paragraph) => paragraph.style)].filter(Boolean));
      if (styleNames.size) {
        object.__canvasResolvedParagraphStyles = Object.fromEntries([...styleNames].filter((name) => document.paragraphStyles?.[name]).map((name) => [name, resolveObject(structuredClone(document.paragraphStyles[name]), theme, nodeId)]));
        const wholeStyle = object.style && object.__canvasResolvedParagraphStyles[object.style];
        if (wholeStyle) {
          for (const property of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "fill", "underline", "strikethrough"]) {
            if (wholeStyle[property] !== undefined) object[property] = wholeStyle[property];
          }
        }
      }
    }
    if (object.type === "icon") compileIcon(object, issues, nodeId, iconRequests);
    normalizePencilNode(object, issues, nodeId);
    canonicalizeResourceReference(object, containerPath);
    if (object.type === "shader") compileShader(object, assets, issues, nodeId);
    if (object.type === "mesh_gradient") compileMeshGradient(object, issues, nodeId);
    if (object.type === "script") compileScript(object, assets, issues, nodeId, (child) => {
      resolveObject(child, theme, nodeId);
    });
    if (["note", "context", "prompt"].includes(object.type)) compileStickyNode(object, (child) => {
      resolveObject(child, theme, nodeId);
    });
    return object;
  };

  for (const node of document.children ?? []) resolveObject(node, defaultTheme);
  compileDescendantIcons(document.children, issues, iconRequests);
  return { document, issues };
}

export function collectPencilRenderIconRequests(source) {
  const iconRequests = [];
  prepareOpenPencilRenderDocument(source, { iconRequests });
  return iconRequests;
}

export function lowerCanvasModelForOpenPencil(source) {
  const document = structuredClone(source);
  const memberProperties = variantMemberProperties(document);
  walkCanvasNodes(document.children, (node) => {
    if (memberProperties.has(node.id) && !node.properties) node.properties = structuredClone(memberProperties.get(node.id));
  });
  compileCanvasConditionsForRendering(document);
  if (isRecord(document.axes)) {
    document.themes = Object.fromEntries(Object.entries(document.axes).map(([axis, definition]) => [
      axis,
      (definition?.modes ?? []).map((mode) => mode.name),
    ]));
  }
  document.variables = Object.fromEntries(Object.entries(document.variables ?? {}).map(([name, definition]) => [
    name,
    definition && Array.isArray(definition.cascade)
      ? {
          type: definition.tokenType,
          value: definition.cascade.map((entry) => ({
            value: structuredClone(entry.value),
            ...(entry.when ? { theme: structuredClone(entry.when) } : {}),
          })),
        }
      : structuredClone(definition),
  ]));
  const nodes = new Map();
  walkCanvasNodes(document.children, (node) => {
    if (typeof node?.id === "string") nodes.set(node.id, node);
    if (isRecord(node?.modes)) {
      node.theme = structuredClone(node.modes);
      delete node.modes;
    }
  });
  walkCanvasNodes(document.children, (instance) => {
    delete instance.__canvasOriginalRef;
    if (instance?.type !== "ref" || typeof instance.ref !== "string" || instance.ref.includes(":")) return;
    const target = nodes.get(instance.ref);
    if (!target) return;
    const supplied = instance.props ?? {};
    const props = {};
    for (const [name, declaration] of Object.entries(target.properties ?? {})) {
      props[name] = Object.hasOwn(supplied, name)
        ? structuredClone(supplied[name])
        : structuredClone(Object.hasOwn(declaration, "default") ? declaration.default : null);
    }
    const descendants = { ...(instance.descendants ?? {}) };
    const visit = (node, path = []) => {
      for (const [property, binding] of Object.entries(node.bind ?? {})) {
        if (typeof binding !== "string" || !binding.startsWith("$props.")) continue;
        const name = binding.slice(7);
        if (!Object.hasOwn(props, name) || path.length === 0) continue;
        const key = path.join("/");
        descendants[key] = { ...(descendants[key] ?? {}), [property]: structuredClone(props[name]) };
      }
      for (const child of node.children ?? []) visit(child, [...path, child.id]);
    };
    visit(target);
    if (Object.keys(descendants).length > 0) instance.descendants = descendants;
  });
  return document;
}

function compileCanvasConditionsForRendering(document) {
  const components = new Map();
  const compiledInstanceCache = new Map();
  walkCanvasNodes(document.children, (node) => {
    if (typeof node?.id === "string") components.set(node.id, node);
  });
  const rootModes = Object.fromEntries(Object.entries(document.axes ?? {}).map(([name, axis]) => [
    name,
    axis?.modes?.[0]?.name,
  ]));

  const modesFor = (node, inherited) => ({ ...inherited, ...(isRecord(node?.modes) ? node.modes : {}) });
  const defaultsFor = (declarations) => Object.fromEntries(Object.entries(declarations ?? {}).map(([name, declaration]) => [
    name,
    Object.hasOwn(declaration ?? {}, "default") ? structuredClone(declaration.default) : null,
  ]));
  const propsFor = (instance, target, outerProps, modes) => {
    const supplied = { ...(isRecord(instance.props) ? instance.props : {}) };
    for (const [name, binding] of Object.entries(instance.bind ?? {})) {
      if (!Object.hasOwn(target.properties ?? {}, name)) continue;
      supplied[name] = canvasBindingValue(binding, outerProps);
    }
    return Object.fromEntries(Object.entries(target.properties ?? {}).map(([name, declaration]) => [
      name,
      Object.hasOwn(supplied, name)
        ? resolveCanvasConditionalValue(supplied[name], { modes, props: outerProps })
        : Object.hasOwn(declaration ?? {}, "default") ? structuredClone(declaration.default) : null,
    ]));
  };
  const originalRef = (instance) => instance.__canvasOriginalRef ?? instance.ref;
  const targetFor = (instance, props) => {
    const leader = components.get(originalRef(instance));
    if (!leader) return null;
    const selected = variantSelection(leader, props);
    return selected ? components.get(selected.sourceId) : leader;
  };
  const assignOverride = (rootOverrides, descendants, path, property, value) => {
    if (path.length === 0) {
      rootOverrides[property] = structuredClone(value);
      return;
    }
    const key = path.join("/");
    descendants[key] = { ...(descendants[key] ?? {}), [property]: structuredClone(value) };
  };
  const collectTargetOverrides = (rootOverrides, descendants, node, context, path, resolving) => {
    const modes = modesFor(node, context.modes);
    const localContext = { modes, props: context.props };
    for (const [property, raw] of Object.entries(node)) {
      if (["id", "type", "name", "children", "properties", "props", "bind", "descendants", "modes"].includes(property)) continue;
      if (!containsCanvasCascade(raw) && !containsCanvasVariable(raw, property)) continue;
      assignOverride(rootOverrides, descendants, path, property, resolveCanvasConditionalValue(raw, localContext));
    }
    for (const [property, binding] of Object.entries(node.bind ?? {})) {
      if (node.type === "ref" && Object.hasOwn(components.get(originalRef(node))?.properties ?? {}, property)) continue;
      assignOverride(rootOverrides, descendants, path, property, canvasBindingValue(binding, context.props));
    }
    if (node.visible?.op) {
      assignOverride(rootOverrides, descendants, path, "enabled", evaluateCanvasRenderCondition(node.visible, context.props));
    }
    if (node.type === "ref" && typeof node.ref === "string" && !node.ref.includes(":")) {
      const leader = components.get(originalRef(node));
      const nestedProps = leader ? propsFor(node, leader, context.props, modes) : {};
      const nestedTarget = targetFor(node, nestedProps);
      if (!nestedTarget || resolving.has(nestedTarget.id)) return;
      if (nestedTarget.id !== node.ref) assignOverride(rootOverrides, descendants, path, "ref", nestedTarget.id);
      collectTargetOverrides(
        rootOverrides,
        descendants,
        nestedTarget,
        { modes, props: nestedProps },
        path,
        new Set([...resolving, nestedTarget.id]),
      );
      for (const child of nestedTarget.children ?? []) {
        collectTargetOverrides(
          rootOverrides,
          descendants,
          child,
          { modes, props: nestedProps },
          [...path, child.id],
          new Set([...resolving, nestedTarget.id]),
        );
      }
      return;
    }
    for (const child of node.children ?? []) {
      collectTargetOverrides(rootOverrides, descendants, child, localContext, [...path, child.id], resolving);
    }
  };
  const compileInstance = (instance, context) => {
    if (typeof instance.ref !== "string" || instance.ref.includes(":")) return;
    const leader = components.get(originalRef(instance));
    if (!leader) return;
    const props = propsFor(instance, leader, context.props, context.modes);
    const target = targetFor(instance, props);
    if (!target) throw new Error(`Component ${leader.id} has an invalid variant target.`);
    if (target.id !== instance.ref) {
      instance.__canvasOriginalRef = originalRef(instance);
      instance.ref = target.id;
    }
    const cacheKey = JSON.stringify([target.id, context.modes, props]);
    let compiled = compiledInstanceCache.get(cacheKey);
    if (!compiled) {
      const rootOverrides = {};
      const descendants = {};
      collectTargetOverrides(rootOverrides, descendants, target, { modes: context.modes, props }, [], new Set([target.id]));
      compiled = { rootOverrides, descendants };
      compiledInstanceCache.set(cacheKey, compiled);
    }
    for (const [property, value] of Object.entries(compiled.rootOverrides)) {
      if (!Object.hasOwn(instance, property)) instance[property] = structuredClone(value);
    }
    const authored = isRecord(instance.descendants) ? instance.descendants : {};
    const descendants = structuredClone(compiled.descendants);
    for (const [path, override] of Object.entries(authored)) {
      const resolved = resolveCanvasConditionalValue(override, { modes: context.modes, props });
      descendants[path] = { ...(descendants[path] ?? {}), ...resolved };
    }
    if (Object.keys(descendants).length > 0) instance.descendants = descendants;
  };
  const compileNodeInstances = (node, context) => {
    const modes = modesFor(node, context.modes);
    const props = isRecord(node.properties)
      ? defaultsFor(node.properties)
      : context.props;
    const localContext = { modes, props };
    if (node.type === "ref") compileInstance(node, localContext);
    for (const child of node.children ?? []) compileNodeInstances(child, localContext);
  };
  const resolveNode = (node, context) => {
    const modes = modesFor(node, context.modes);
    const props = isRecord(node.properties)
      ? defaultsFor(node.properties)
      : context.props;
    const localContext = { modes, props };
    for (const [property, raw] of Object.entries(node)) {
      if (["children", "properties", "props", "bind", "descendants", "modes"].includes(property)) continue;
      if (containsCanvasCascade(raw)) node[property] = resolveCanvasConditionalValue(raw, localContext);
    }
    for (const [property, binding] of Object.entries(node.bind ?? {})) {
      if (node.type === "ref" && Object.hasOwn(components.get(originalRef(node))?.properties ?? {}, property)) continue;
      node[property] = canvasBindingValue(binding, props);
    }
    if (node.visible?.op) node.enabled = evaluateCanvasRenderCondition(node.visible, props);
    for (const child of node.children ?? []) resolveNode(child, localContext);
  };
  for (const node of document.children ?? []) compileNodeInstances(node, { modes: rootModes, props: {} });
  for (const node of document.children ?? []) resolveNode(node, { modes: rootModes, props: {} });
}

function containsCanvasCascade(value) {
  if (isCanvasCascade(value)) return true;
  if (Array.isArray(value)) return value.some(containsCanvasCascade);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => key !== "when" && containsCanvasCascade(child));
}

function containsCanvasVariable(value, property) {
  if (typeof value === "string") {
    return Boolean(isInterpolatedVariableReference(value, property) || isLegacyVariableReference(value, property));
  }
  if (Array.isArray(value)) return value.some((item) => containsCanvasVariable(item, property));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => containsCanvasVariable(child, key));
}

function resolveCanvasConditionalValue(value, context) {
  if (isCanvasCascade(value)) {
    let selected = value[0]?.value;
    for (const entry of value) if (matchesCanvasWhen(entry.when, context)) selected = entry.value;
    return resolveCanvasConditionalValue(selected, context);
  }
  if (Array.isArray(value)) return value.map((item) => resolveCanvasConditionalValue(item, context));
  if (!isRecord(value)) return structuredClone(value);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === "when" ? structuredClone(child) : resolveCanvasConditionalValue(child, context),
  ]));
}

function isCanvasCascade(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => (
    isRecord(entry)
    && Object.hasOwn(entry, "value")
    && Object.keys(entry).every((key) => key === "value" || key === "when")
  ));
}

function matchesCanvasWhen(when, context) {
  if (!when) return true;
  for (const [axis, expected] of Object.entries(when)) {
    if (axis === "props") {
      for (const [name, value] of Object.entries(expected ?? {})) {
        if (!Object.is(context.props?.[name], value)) return false;
      }
    } else if (context.modes?.[axis] !== expected) return false;
  }
  return true;
}

function canvasBindingValue(binding, props) {
  if (typeof binding !== "string" || !binding.startsWith("$props.")) {
    throw new Error(`Invalid component binding ${binding}.`);
  }
  const name = binding.slice(7);
  if (!Object.hasOwn(props ?? {}, name)) throw new Error(`Component binding ${binding} is unavailable.`);
  return structuredClone(props[name]);
}

function evaluateCanvasRenderCondition(condition, props) {
  const value = () => props?.[condition.arg?.prop];
  switch (condition.op) {
    case "eq": return Object.is(value(), condition.value);
    case "neq": return !Object.is(value(), condition.value);
    case "notNull": return value() !== null && value() !== undefined;
    case "isNull": return value() === null || value() === undefined;
    case "in": return Array.isArray(condition.value) && condition.value.some((item) => Object.is(item, value()));
    case "gt": return value() > condition.value;
    case "lt": return value() < condition.value;
    case "and": return condition.args.every((item) => evaluateCanvasRenderCondition(item, props));
    case "or": return condition.args.some((item) => evaluateCanvasRenderCondition(item, props));
    case "not": return !evaluateCanvasRenderCondition(condition.arg, props);
    default: throw new Error(`Unknown condition operator ${condition.op}.`);
  }
}

function walkCanvasNodes(children, visit) {
  for (const node of children ?? []) {
    visit(node);
    walkCanvasNodes(node?.children, visit);
  }
}

function compileDescendantIcons(nodes, issues, iconRequests) {
  const byId = new Map();
  const visit = (node) => {
    if (typeof node?.id === "string") byId.set(node.id, node);
    for (const child of node?.children ?? []) visit(child);
  };
  for (const node of nodes ?? []) visit(node);

  const apply = (node) => {
    if (node?.type === "ref" && isRecord(node.descendants)) {
      for (const [path, override] of Object.entries(node.descendants)) {
        if (!isRecord(override)) continue;
        const source = byId.get(path.split("/").at(-1));
        if (source?.type !== "icon") continue;
        const effective = {
          type: "icon",
          library: override.library ?? source.library,
          icon: override.icon ?? source.icon,
          weight: override.weight ?? source.weight,
        };
        if (iconRequests) {
          iconRequests.push(effective);
          continue;
        }
        const definition = pencilIconDefinition(effective.library, effective.icon, effective.weight);
        if (definition) {
          override.__canvasIcon = definition;
          override.__canvasIconFill = structuredClone(override.fill ?? source.fill ?? "#000000");
        }
        else issues.push(iconIssue(
          node.id,
          `${effective.library ?? "Unknown"} icon ${effective.icon ?? "(unnamed)"} is not supported.`,
        ));
      }
    }
    for (const child of node?.children ?? []) apply(child);
  };
  for (const node of nodes ?? []) apply(node);
}

function compileStickyNode(node, prepareChild) {
  const style = {
    note: { title: "Note", header: "#FFF1D6", background: "#FFF7E5", outline: "#8B6311", text: "#664500" },
    context: { title: "Context", header: "#FFFFFF", background: "#F0F0F0", outline: "#767676", text: "#2C2C2C" },
    prompt: { title: "Prompt", header: "#C3E8FF", background: "#E8F6FF", outline: "#009DFF", text: "#006CAF" },
  }[node.type];
  const id = node.id;
  const generated = (suffix, value) => ({ id: `${id}::sticky::${suffix}`, __canvasGenerated: true, ...value });
  const text = (suffix, content, options = {}) => generated(suffix, {
    type: "text",
    content,
    fill: options.fill ?? style.text,
    fontFamily: "JetBrains Mono",
    fontSize: options.fontSize ?? 14,
    fontWeight: options.fontWeight ?? 400,
    lineHeight: options.lineHeight ?? 21,
    textGrowth: options.textGrowth ?? "fixed-width-height",
    width: options.width,
    height: options.height,
  });
  const title = generated("title-row", {
    type: "frame",
    layout: "horizontal",
    alignItems: "center",
    gap: 2,
    width: "hug_content",
    height: 21,
    children: [
      text("title", style.title, { fontWeight: 500, width: "hug_content", height: 21 }),
      generated("chevron", {
        type: "path",
        width: 16,
        height: 16,
        geometry: "M4 7L8 11L12 7",
        viewBox: [0, 0, 16, 16],
        stroke: style.text,
        strokeWidth: 1,
      }),
    ],
  });
  const header = generated("header", {
    type: "frame",
    layout: "horizontal",
    alignItems: "center",
    padding: 12,
    width: "fill_container",
    height: 45,
    fill: style.header,
    children: [title],
  });
  const divider = generated("divider", {
    type: "path",
    width: "fill_container",
    height: 0,
    geometry: `M0 0H${Math.max(250, Number(node.width) || 250)}`,
    stroke: style.outline,
    strokeWidth: 1,
    strokeDashPattern: [4, 4],
  });
  const content = text("content", typeof node.content === "string" ? node.content : "", {
    width: "fill_container",
    height: node.type === "prompt" ? 116 : 150,
  });
  const bodyChildren = [content];
  if (node.type === "prompt") {
    bodyChildren.push(generated("footer", {
      type: "frame",
      layout: "horizontal",
      alignItems: "center",
      justifyContent: "end",
      padding: [8, 0, 0, 0],
      width: "fill_container",
      height: 34,
      children: [generated("copy", {
        type: "frame",
        layout: "horizontal",
        alignItems: "center",
        justifyContent: "center",
        padding: [4, 12, 4, 12],
        cornerRadius: 6,
        width: "hug_content",
        height: 26,
        fill: style.text,
        children: [text("copy-label", "Copy", { fill: "#FFFFFF", fontSize: 12, fontWeight: 500, lineHeight: 18, width: "hug_content", height: 18 })],
      })],
    }));
  }
  const body = generated("body", {
    type: "frame",
    layout: "vertical",
    padding: 12,
    width: "fill_container",
    height: 174,
    fill: style.background,
    children: bodyChildren,
  });
  node.__canvasSticky = true;
  node.width = Math.max(250, Number(node.width) || 250);
  node.height = 219;
  node.layout = "vertical";
  node.gap = 0;
  node.clip = true;
  node.cornerRadius = 8;
  node.fill = style.background;
  node.stroke = {
    fills: [style.outline],
    thickness: 1,
    align: "inside",
  };
  node.children = [header, divider, body];
  for (const child of node.children) prepareChild(child);
}

function compileMeshGradient(fill, issues, nodeId) {
  try {
    fill.__canvasMesh = normalizePencilMeshGradient(fill);
  } catch (error) {
    issues.push(meshIssue(nodeId, error?.message ?? String(error)));
  }
}

function compileShader(fill, assets, issues, nodeId) {
  if (typeof fill.url !== "string" || fill.url.length === 0) {
    issues.push(shaderIssue(nodeId, "No Pencil shader file is selected."));
    return;
  }
  const asset = pencilResourceAsset(assets, fill.url);
  if (!asset) {
    issues.push(shaderIssue(nodeId, `Pencil shader resource ${fill.url} is unavailable.`));
    return;
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(asset.bytes);
    const definition = parsePencilShader(source);
    const values = resolvePencilShaderUniforms(definition, fill.uniforms);
    const textures = [];
    for (const uniform of definition.uniforms.filter(({ type, automatic }) => type === "sampler2D" && !automatic)) {
      const url = resolvePencilResourcePath(fill.url, values[uniform.name]);
      const texture = pencilResourceAsset(assets, url);
      if (!texture) throw new Error(`Pencil shader texture ${url} is unavailable.`);
      values[uniform.name] = url;
      textures.push({ name: uniform.name, url, sha256: texture.sha256 });
    }
    fill.__canvasShader = {
      source,
      webglSource: transpilePencilShaderWebGL1(definition),
      uniforms: definition.uniforms,
      values,
      textures,
    };
  } catch (error) {
    issues.push(shaderIssue(nodeId, error?.message ?? String(error)));
  }
}

function canonicalizeResourceReference(object, containerPath) {
  if ((object.type === "image" || object.type === "shader") && typeof object.url === "string") {
    object.url = resolvePencilResourcePath(containerPath, object.url);
  }
  if (object.type === "script" && typeof object.scriptUri === "string") {
    object.scriptUri = resolvePencilResourcePath(containerPath, object.scriptUri);
  }
}

function compileScript(node, assets, issues, nodeId, prepareChild) {
  if (typeof node.scriptUri !== "string" || node.scriptUri.length === 0) {
    issues.push(scriptIssue(nodeId, "No Pencil script file is selected."));
    return;
  }
  const asset = pencilResourceAsset(assets, node.scriptUri);
  if (!asset) {
    issues.push(scriptIssue(nodeId, `Pencil script resource ${node.scriptUri} is unavailable.`));
    return;
  }
  try {
    const code = new TextDecoder("utf-8", { fatal: true }).decode(asset.bytes);
    const result = executePencilScript(code, {
      width: node.width,
      height: node.height,
      inputs: node.inputs,
    });
    node.children = namespaceScriptOutput(result.nodes, node.id);
    node.__canvasScript = true;
    for (const child of node.children) prepareChild(child);
  } catch (error) {
    issues.push(scriptIssue(nodeId, error?.message ?? String(error)));
  }
}

function namespaceScriptOutput(nodes, scriptId) {
  const ids = new Map();
  const output = structuredClone(nodes);
  const assign = (node, path) => {
    const originalId = typeof node.id === "string" && node.id.length > 0 ? node.id : null;
    if (originalId && ids.has(originalId)) throw new Error(`Pencil script output repeats node id ${originalId}.`);
    const generatedId = `${scriptId}::script::${path.join(".")}`;
    if (originalId) ids.set(originalId, generatedId);
    node.id = generatedId;
    node.__canvasGenerated = true;
    for (let index = 0; index < (node.children ?? []).length; index += 1) {
      assign(node.children[index], [...path, index]);
    }
  };
  for (let index = 0; index < output.length; index += 1) assign(output[index], [index]);
  const rewrite = (node) => {
    if (typeof node.ref === "string" && ids.has(node.ref)) node.ref = ids.get(node.ref);
    if (isRecord(node.descendants)) {
      node.descendants = Object.fromEntries(Object.entries(node.descendants).map(([path, value]) => [
        path.split("/").map((part) => ids.get(part) ?? part).join("/"),
        value,
      ]));
    }
    for (const child of node.children ?? []) rewrite(child);
  };
  for (const node of output) rewrite(node);
  return output;
}

function normalizePencilNode(node, issues, nodeId) {
  if (!node || typeof node !== "object" || !node.type) return;
  node.width = normalizePencilSize(node.width);
  node.height = normalizePencilSize(node.height);

  if (node.type === "frame") {
    node.layout ??= "horizontal";
    node.width ??= "hug_content";
    node.height ??= "hug_content";
  }
  if (node.justifyContent === "space_between") node.justifyContent = "space-between";
  if (node.textAlign === "justify") node.textAlign = "justified";
  if (node.textAlignVertical === "middle") node.textAlignVertical = "center";

  if (isRecord(node.stroke) && (Object.hasOwn(node.stroke, "fill") || Object.hasOwn(node.stroke, "fills"))) {
    // Lower Canvas stroke fields at the owned renderer boundary, without
    // interpreting a stroke descriptor as if it were itself a fill paint.
    node.stroke.thickness = node.stroke.width ?? node.stroke.thickness ?? 1;
    if (node.stroke.dash !== undefined || node.stroke.dashPattern !== undefined) node.stroke.dashPattern = normalizeStrokeDash(node.stroke.dash ?? node.stroke.dashPattern);
  }
  if (node.stroke !== undefined && !isOpenPencilStroke(node.stroke)) {
    const fills = Array.isArray(node.stroke) ? node.stroke : [node.stroke];
    for (const fill of fills) {
      const supported = typeof fill === "string"
        || fill?.type === "color"
        || fill?.type === "solid"
        || fill?.type === "gradient";
      if (supported) continue;
      issues.push({
        nodeId,
        kind: "stroke",
        message: `${fill?.type ?? "Unknown"} stroke fill is preserved but is not represented by the current Canvas renderer.`,
      });
    }
    node.stroke = {
      fills,
      thickness: node.strokeWidth ?? 1,
      align: ({ inner: "inside", outer: "outside" })[node.strokeAlignment] ?? "center",
      join: node.strokeLinejoin,
      cap: node.strokeLinecap,
      ...(node.strokeDashPattern ? { dashPattern: node.strokeDashPattern } : {}),
    };
  }
}

function normalizePencilSize(value) {
  if (typeof value !== "string") return value;
  return /^fit_content(?:\([^)]*\))?$/.test(value) ? "hug_content" : value;
}

function isOpenPencilStroke(value) {
  return isRecord(value)
    && (Object.hasOwn(value, "fill") || Object.hasOwn(value, "fills"))
    && Object.hasOwn(value, "thickness");
}

function compileIcon(node, issues, nodeId, iconRequests) {
  if (iconRequests) {
    iconRequests.push({ library: node.library, icon: node.icon, weight: node.weight });
    return;
  }
  const definition = pencilIconDefinition(node.library, node.icon, node.weight);
  if (!definition) {
    issues.push(iconIssue(
      nodeId,
      `${node.library ?? "Unknown"} icon ${node.icon ?? "(unnamed)"} is not supported.`,
    ));
    return;
  }
  node.__canvasIcon = definition;
}

function selectVariableValue(value, theme) {
  if (!Array.isArray(value)) return { ok: true, value };
  let selected;
  let found = false;
  let fallback;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || !("value" in entry)) continue;
    fallback ??= entry.value;
    const conditions = isRecord(entry.theme) ? Object.entries(entry.theme) : [];
    if (!conditions.every(([axis, mode]) => theme[axis] === mode)) continue;
    // Pencil 2.17 defines variable arrays as ordered cascades: the last value
    // whose complete theme condition matches wins.
    selected = entry.value;
    found = true;
  }
  if (found) return { ok: true, value: selected };
  if (fallback !== undefined) return { ok: true, value: fallback };
  return { ok: false, reason: "Variable has no values." };
}

const VARIABLE_INTERPOLATION_PATTERN = /\$\{([A-Za-z][\w-]*)\}/g;

function isInterpolatedVariableReference(value, property) {
  return typeof value === "string"
    && VARIABLE_PROPERTIES.has(property)
    && value.match(VARIABLE_INTERPOLATION_PATTERN);
}

function isLegacyVariableReference(value, property) {
  return typeof value === "string"
    && /^\$[A-Za-z][\w-]*$/.test(value)
    && VARIABLE_PROPERTIES.has(property);
}

function isKnownVariableReference(value, variables) {
  return typeof value === "string" && value.startsWith("$") && Object.hasOwn(variables, value.slice(1));
}

function validPropertyValue(property, value) {
  if (NUMERIC_PROPERTIES.has(property)) {
    if (["width", "height"].includes(property) && typeof value === "string") return true;
    return typeof value === "number" && Number.isFinite(value);
  }
  if (BOOLEAN_PROPERTIES.has(property)) return typeof value === "boolean";
  if (NUMBER_OR_STRING_PROPERTIES.has(property)) return typeof value === "string" || typeof value === "number" && Number.isFinite(value);
  if (STRING_PROPERTIES.has(property)) return typeof value === "string";
  if (NUMERIC_ARRAY_PROPERTIES.has(property)) {
    return typeof value === "number" && Number.isFinite(value)
      || Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
  }
  return true;
}

function safeFallback(property, original) {
  if (NUMERIC_PROPERTIES.has(property)) {
    if (property === "opacity") return 1;
    if (property === "weight") return 400;
    return 0;
  }
  if (BOOLEAN_PROPERTIES.has(property)) return property === "enabled";
  if (NUMBER_OR_STRING_PROPERTIES.has(property)) return 400;
  if (STRING_PROPERTIES.has(property)) return property === "color" ? "#00000000" : "";
  if (NUMERIC_ARRAY_PROPERTIES.has(property)) return 0;
  if (property === "fill" || property === "stroke") return null;
  return original;
}

function variableIssue(nodeId, reference, message) {
  return {
    nodeId,
    kind: "variable",
    message: `${message} The original ${reference} reference is preserved in the Canvas document.`,
  };
}

function iconIssue(nodeId, message) {
  return {
    nodeId,
    kind: "icon",
    message: `${message} The original icon is preserved in the Canvas document.`,
  };
}

function scriptIssue(nodeId, message) {
  return {
    nodeId,
    kind: "script",
    message: `${message} The original script node is preserved in the Canvas document.`,
  };
}

function shaderIssue(nodeId, message) {
  return {
    nodeId,
    kind: "shader",
    message: `${message} The original shader fill is preserved in the Canvas document.`,
  };
}

function meshIssue(nodeId, message) {
  return {
    nodeId,
    kind: "mesh-gradient",
    message: `${message} The original mesh gradient fill is preserved in the Canvas document.`,
  };
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
