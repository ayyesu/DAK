import { interpolateRichText } from "./rich-text.mjs";
import { resolveVariableReferences } from "./variable-references.mjs";
import { variantMemberProperties, variantSelection } from "./component-variants.mjs";

export function resolveCanvasDocument(document, options = {}) {
  const modes = selectModes(document.axes ?? {}, options.modes ?? {});
  const variableValues = resolveVariables(document.variables ?? {}, modes, options.bindings ?? {});
  const rootContext = { modes, props: {} };
  const paragraphStyles = Object.fromEntries(Object.entries(document.paragraphStyles ?? {}).map(([name, style]) => [name, resolveValue(resolveCascade(style, rootContext), variableValues, rootContext)]));
  const localNodes = indexNodes(document.children);
  const imports = options.imports ?? {};
  const consequences = [];
  const lowered = [];
  const resolving = [];
  const styleRegistry = { styles: paragraphStyles, nextId: 0 };
  const baseContext = { owner: document, rootOwner: document, styleRegistry, props: {}, modes, variableValues, localNodes, memberProperties: variantMemberProperties(document), imports, consequences, lowered, resolving };
  const children = document.children.map((node) => resolveNode(node, baseContext)).filter(Boolean);
  const flows = (document.flows ?? []).map(remapResolvedFlowSource);
  return { document: { ...document, paragraphStyles, children, flows }, modes, consequences, lowered };
}

export function evaluateCondition(condition, context) {
  if (!condition) return true;
  const arg = () => context.props?.[condition.arg?.prop];
  switch (condition.op) {
    case "eq": return Object.is(arg(), condition.value);
    case "neq": return !Object.is(arg(), condition.value);
    case "notNull": return arg() !== null && arg() !== undefined;
    case "isNull": return arg() === null || arg() === undefined;
    case "in": return Array.isArray(condition.value) && condition.value.some((value) => Object.is(value, arg()));
    case "gt": return arg() > condition.value;
    case "lt": return arg() < condition.value;
    case "and": return condition.args.every((item) => evaluateCondition(item, context));
    case "or": return condition.args.some((item) => evaluateCondition(item, context));
    case "not": return !evaluateCondition(condition.arg, context);
    default: throw new Error(`Unknown condition operator ${condition.op}.`);
  }
}

export function resolveCascade(value, context) {
  if (!isCascade(value)) return value;
  let resolved = value[0]?.value;
  for (const entry of value) if (matchesWhen(entry.when, context)) resolved = entry.value;
  return resolved;
}

function resolveNode(source, context) {
  if (source.type === "ref") return resolveRef(source, context);
  if (source.modes) {
    const axes = context.owner.axes ?? {};
    const inherited = Object.fromEntries(Object.entries(context.modes).filter(([name]) => Object.hasOwn(axes, name)));
    const modes = { ...context.modes, ...selectModes(axes, { ...inherited, ...source.modes }) };
    const bindings = Object.fromEntries(Object.entries(context.variableValues).filter(([name]) => !Object.hasOwn(context.owner.variables ?? {}, name)));
    context = { ...context, modes, scopedModes: true, variableValues: resolveVariables(context.owner.variables ?? {}, modes, bindings) };
  }
  const declarations = source.properties ?? context.memberProperties?.get(source.id);
  if (declarations) {
    context = context.componentRoot
      ? { ...context, componentRoot: false }
      : { ...context, props: resolveProps(declarations, {}), componentRoot: false };
  } else if (context.componentRoot) context = { ...context, componentRoot: false };
  const output = {};
  for (const [key, raw] of Object.entries(source)) {
    if (["children", "properties", "variantSet", "bind", "varies"].includes(key)) continue;
    const value = resolveCascade(raw, context);
    output[key] = source.type === "text" && key === "content" ? value : resolveValue(value, context.variableValues, context);
  }
  for (const [key, binding] of Object.entries(source.bind ?? {}))
    output[key] = resolveValue(resolveBinding(binding, context.props), context.variableValues, context);
  if (source.visible && typeof source.visible === "object" && source.visible.op) {
    output.enabled = evaluateCondition(source.visible, context);
    // The export projection is fully resolved. Keeping the condition would
    // make the renderer evaluate it again after component properties have been
    // removed, incorrectly hiding text whose condition was true here.
    delete output.visible;
  }
  if (output.type === "text") {
    const textSource = { ...output, content: String(output.content ?? ""), marks: source.marks ?? [], paragraphs: source.paragraphs ?? [] };
    const resolvedText = interpolateRichText(textSource, context.variableValues);
    output.content = resolvedText.content; output.marks = resolvedText.marks; output.paragraphs = resolvedText.paragraphs;
    if (source.bind?.content && output.content.length > 0) {
      output.marks = [];
      output.paragraphs = [{ from: 0, to: output.content.length, ...(source.style ? { style: source.style } : {}) }];
    }
    // A library style keeps its definition identity. Consumer mode selection
    // still flows into its cascade; an unrelated same-named style cannot replace it.
    if (context.owner !== context.rootOwner || context.scopedModes) {
      const names = new Map();
      const register = (name) => {
        if (names.has(name)) return names.get(name);
        if (!Object.hasOwn(context.owner.paragraphStyles ?? {}, name)) throw new Error(`Paragraph style ${name} was not found in its owning document.`);
        const registry = context.styleRegistry;
        let key;
        do { key = `@canvas-resolved-style/${registry.nextId++}`; } while (Object.hasOwn(registry.styles, key));
        registry.styles[key] = resolveValue(resolveCascade(context.owner.paragraphStyles[name], context), context.variableValues, context);
        names.set(name, key);
        return key;
      };
      if (output.style) output.style = register(output.style);
      output.paragraphs = output.paragraphs.map((paragraph) => paragraph.style ? { ...paragraph, style: register(paragraph.style) } : paragraph);
    }
  }
  if (context.assetPrefix) {
    for (const key of ["fill", "stroke", "effect"]) {
      if (output[key] !== undefined) output[key] = namespaceAssetReferences(output[key], context.assetPrefix);
    }
  }
  output.children = (source.children ?? []).map((child) => resolveNode(child, context)).filter(Boolean);
  if (source.children === undefined) delete output.children;
  return output;
}

function namespaceAssetReferences(value, prefix) {
  if (Array.isArray(value)) return value.map((item) => namespaceAssetReferences(item, prefix));
  if (!value || typeof value !== "object") return value;
  const output = Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    namespaceAssetReferences(nested, prefix),
  ]));
  if (output.type === "image" && typeof output.url === "string" && !/^(?:data:|https?:|file:|\/)/u.test(output.url)) {
    output.url = `${prefix}/${output.url}`;
  }
  return output;
}

function resolveRef(instance, context) {
  if (instance.modes) {
    const axes = context.owner.axes ?? {};
    const inherited = Object.fromEntries(Object.entries(context.modes).filter(([name]) => Object.hasOwn(axes, name)));
    const modes = { ...context.modes, ...selectModes(axes, { ...inherited, ...instance.modes }) };
    const bindings = Object.fromEntries(Object.entries(context.variableValues).filter(([name]) => !Object.hasOwn(context.owner.variables ?? {}, name)));
    context = { ...context, modes, scopedModes: true, variableValues: resolveVariables(context.owner.variables ?? {}, modes, bindings) };
  }
  const instanceContext = context;
  const qualified = instance.ref.split(":");
  let owner = context.owner; let target; let localNodes = context.localNodes; let variableValues = context.variableValues;
  if (qualified.length > 1) {
    const alias = qualified.shift(); const imported = context.imports[alias];
    if (!imported) throw new Error(`Import ${alias} is missing or unreadable.`);
    owner = imported.document ?? imported;
    localNodes = indexNodes(owner.children);
    target = localNodes.get(qualified.join(":"));
    const modes = { ...context.modes };
    for (const [name, axis] of Object.entries(owner.axes ?? {})) {
      if (!axis.modes.some((mode) => mode.name === modes[name])) modes[name] = axis.modes[0]?.name;
    }
    variableValues = resolveVariables(owner.variables ?? {}, modes, {});
    context = {
      ...context,
      modes,
      imports: imported.imports ?? {},
      memberProperties: variantMemberProperties(owner),
      assetPrefix: [context.assetPrefix, "imports", alias].filter(Boolean).join("/"),
    };
  } else target = localNodes.get(instance.ref);
  if (!target) throw new Error(`Ref ${instance.id} target ${instance.ref} was not found.`);
  const props = resolveProps(target.properties ?? {}, instance.props ?? {}, context.consequences, instance.id);
  const selection = variantSelection(target, props);
  if (selection) {
    target = localNodes.get(selection.sourceId);
    if (!target) throw new Error(`Component ${instance.ref} variant target ${selection.sourceId} was not found.`);
  }
  const cycleKey = `${owner === context.owner ? "local" : instance.ref}:${target.id}`;
  if (context.resolving.includes(cycleKey)) throw new Error(`Ref cycle: ${[...context.resolving, cycleKey].join(" -> ")}.`);
  const resolved = resolveNode(target, { ...context, owner, localNodes, variableValues, props, componentRoot: true, resolving: [...context.resolving, cycleKey] });
  context.lowered.push({ node: instance.id, from: instance.ref, why: "Reference expanded into target-native nodes." });
  const output = prefixResolvedNode(resolved, instance.id, target.id, props);
  // A component definition's canvas position is not the instance position.
  // Keep instance geometry/compositing and the author's one-way export override
  // when replacing the reference with its resolved visual subtree.
  output.x = resolveValue(resolveCascade(instance.x ?? 0, instanceContext), instanceContext.variableValues, instanceContext);
  output.y = resolveValue(resolveCascade(instance.y ?? 0, instanceContext), instanceContext.variableValues, instanceContext);
  for (const key of ["name", "width", "height", "rotation", "flipX", "flipY", "opacity", "enabled", "export", "description", "decorative", "layoutPosition", "gridColumn", "gridRow"]) {
    if (Object.hasOwn(instance, key)) output[key] = resolveValue(resolveCascade(instance[key], instanceContext), instanceContext.variableValues, instanceContext);
  }
  return output;
}

function resolveProps(declarations, supplied, consequences, instanceId) {
  const result = {};
  for (const [name, declaration] of Object.entries(declarations)) {
    const has = Object.hasOwn(supplied, name);
    if (!has && !Object.hasOwn(declaration, "default") && declaration.optional !== true) throw new Error(`Required component property ${name} is missing.`);
    const value = has ? supplied[name] : Object.hasOwn(declaration, "default") ? declaration.default : null;
    if (!compatible(value, declaration)) throw new Error(`Component property ${name} does not satisfy ${declaration.type}.`);
    result[name] = value;
  }
  for (const name of Object.keys(supplied)) {
    if (Object.hasOwn(declarations, name)) continue;
    consequences?.push({
      node: instanceId,
      kind: "ignore",
      why: `Instance property ${name} is not declared by its component and was ignored.`,
    });
  }
  return result;
}

function prefixResolvedNode(node, instanceId, sourceId, props) {
  const idMap = new Map();
  const collect = (candidate, prefix) => {
    idMap.set(candidate.id, prefix);
    for (const child of candidate.children ?? []) collect(child, `${prefix}/${child.id}`);
  };
  collect(node, instanceId);
  const clone = (candidate) => {
    const result = { ...candidate, id: idMap.get(candidate.id), provenance: { from: candidate.id === node.id ? sourceId : candidate.id, props, lowered: true } };
    if (typeof candidate.notesFor === "string") result.notesFor = idMap.get(candidate.notesFor) ?? candidate.notesFor;
    if (candidate.children) result.children = candidate.children.map(clone);
    return result;
  };
  return clone(node);
}

function remapResolvedFlowSource(flow) {
  const source = flow.trigger?.source;
  if (!source || !Array.isArray(source.path) || source.path.length === 0) return flow;
  return {
    ...flow,
    trigger: {
      ...flow.trigger,
      source: { path: [], node: [...source.path, source.node].join("/") },
    },
  };
}

export function isCascade(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Object.hasOwn(entry, "value")) return false;
    return Object.keys(entry).every((key) => key === "value" || key === "when");
  });
}

function compatible(value, declaration) {
  if (value === null) return declaration.optional === true;
  if (declaration.type === "number") return typeof value === "number" && Number.isFinite(value) && (declaration.min === undefined || value >= declaration.min) && (declaration.max === undefined || value <= declaration.max);
  if (declaration.type === "boolean") return typeof value === "boolean";
  if (["string", "color", "icon"].includes(declaration.type)) return typeof value === "string";
  if (declaration.type === "enum") return declaration.values.includes(value);
  if (declaration.type === "node") return value && typeof value === "object" && typeof value.type === "string";
  return false;
}

function resolveBinding(binding, props) {
  if (typeof binding !== "string" || !binding.startsWith("$props.")) throw new Error(`Invalid component binding ${binding}.`);
  const name = binding.slice(7);
  if (!Object.hasOwn(props, name)) throw new Error(`Component binding ${binding} is unavailable.`);
  return structuredClone(props[name]);
}

function resolveVariables(variables, modes, bindings) {
  const output = { ...bindings };
  const visiting = new Set();
  const resolve = (name) => {
    if (Object.hasOwn(bindings, name)) return bindings[name];
    if (Object.hasOwn(output, name)) return output[name];
    if (!Object.hasOwn(variables, name)) throw new Error(`Variable ${name} was not found.`);
    if (visiting.has(name)) throw new Error(`Variable cycle includes ${name}.`);
    visiting.add(name);
    const definition = variables[name];
    if (!definition || typeof definition !== "object" || !Array.isArray(definition.cascade)) throw new Error(`Variable ${name} must declare tokenType and cascade.`);
    const raw = resolveCascade(definition.cascade, { modes, props: {} });
    const value = resolveVariableReferences(raw, resolve, (alias) => Object.hasOwn(variables, alias));
    visiting.delete(name); output[name] = value; return value;
  };
  for (const name of Object.keys(variables)) resolve(name);
  return output;
}

function resolveValue(value, variables, context) {
  const cascaded = context ? resolveNestedCascades(value, context) : value;
  return resolveVariableReferences(cascaded, (name) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`Variable ${name} was not found.`);
    return variables[name];
  }, (name) => Object.hasOwn(variables, name));
}

function resolveNestedCascades(value, context) {
  const selected = resolveCascade(value, context);
  if (selected !== value) return resolveNestedCascades(selected, context);
  if (Array.isArray(value)) return value.map((item) => resolveNestedCascades(item, context));
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === "when" ? structuredClone(child) : resolveNestedCascades(child, context),
  ]));
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function matchesWhen(when, context) {
  if (!when) return true;
  for (const [axis, mode] of Object.entries(when)) {
    if (axis === "props") {
      for (const [name, value] of Object.entries(mode)) if (!Object.is(context.props?.[name], value)) return false;
    } else if (context.modes?.[axis] !== mode) return false;
  }
  return true;
}

function selectModes(axes, requested) {
  const selected = {};
  for (const [name, axis] of Object.entries(axes)) {
    const modes = axis.modes.map((mode) => mode.name);
    const value = requested[name] ?? modes[0];
    if (!modes.includes(value)) throw new Error(`Axis ${name} has no mode ${value}.`);
    selected[name] = value;
  }
  for (const name of Object.keys(requested)) if (!Object.hasOwn(axes, name)) throw new Error(`Unknown axis ${name}.`);
  return selected;
}

function indexNodes(children, map = new Map()) { for (const node of children ?? []) { map.set(node.id, node); indexNodes(node.children, map); } return map; }
