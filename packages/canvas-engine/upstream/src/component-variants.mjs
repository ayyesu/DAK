export function indexCanvasNodes(children, output = new Map()) {
  for (const node of children ?? []) {
    if (typeof node?.id === "string") output.set(node.id, node);
    indexCanvasNodes(node?.children, output);
  }
  return output;
}

export function componentDefinitions(document) {
  const nodes = indexCanvasNodes(document?.children);
  const referenced = new Set([...nodes.values()]
    .filter((node) => node.type === "ref" && typeof node.ref === "string" && !node.ref.includes(":"))
    .map((node) => node.ref));
  return [...nodes.values()].filter((node) => node.type === "frame"
    && (referenced.has(node.id) || node.variantSet || node.reusable));
}

export function variantSelection(component, supplied = {}) {
  const set = component?.variantSet;
  if (!set) return null;
  const values = Object.fromEntries((set.properties ?? []).map((name) => [
    name,
    Object.hasOwn(supplied, name) ? supplied[name] : component.properties?.[name]?.default,
  ]));
  const match = (set.variants ?? []).find((variant) =>
    (set.properties ?? []).every((name) => Object.is(variant.when?.[name], values[name])));
  if (!match) {
    const description = (set.properties ?? []).map((name) => `${name}=${JSON.stringify(values[name])}`).join(", ");
    const error = new Error(`Component ${component.id} has no authored variant for ${description}.`);
    error.code = "CANVAS_VARIANT_COMBINATION_MISSING";
    error.componentId = component.id;
    error.values = values;
    throw error;
  }
  return { sourceId: match.ref, values };
}

export function availableVariantValues(component, supplied = {}, property) {
  const set = component?.variantSet;
  if (!set?.properties?.includes(property)) return [];
  const current = Object.fromEntries(set.properties.map((name) => [
    name,
    Object.hasOwn(supplied, name) ? supplied[name] : component.properties?.[name]?.default,
  ]));
  const compatible = (set.variants ?? []).filter((variant) => set.properties.every((name) =>
    name === property || Object.is(variant.when?.[name], current[name])));
  return [...new Set(compatible.map((variant) => variant.when[property]))];
}

export function variantMemberProperties(document) {
  const members = new Map();
  for (const node of indexCanvasNodes(document?.children).values()) {
    if (!node.variantSet) continue;
    for (const variant of node.variantSet.variants ?? []) {
      if (variant.ref !== node.id) members.set(variant.ref, node.properties ?? {});
    }
  }
  return members;
}

export function validateVariantSets(document) {
  const nodes = indexCanvasNodes(document?.children);
  const parents = new Map();
  const indexParents = (children, parentId = null) => {
    for (const node of children ?? []) {
      parents.set(node.id, parentId);
      indexParents(node.children, node.id);
    }
  };
  indexParents(document?.children);
  const errors = [];
  const ownedMembers = new Map();
  for (const component of nodes.values()) {
    const set = component.variantSet;
    if (!set) continue;
    if (component.type !== "frame") {
      errors.push(`${component.id}.variantSet requires a frame component.`);
      continue;
    }
    if (parents.get(component.id) !== null) errors.push(`${component.id}.variantSet leader must be a top-level frame.`);
    const names = set.properties;
    const variants = set.variants;
    if (!Array.isArray(names) || names.length === 0 || new Set(names).size !== names.length
      || names.some((name) => typeof name !== "string" || !name)) {
      errors.push(`${component.id}.variantSet.properties needs distinct property names.`);
      continue;
    }
    for (const name of names) {
      const declaration = component.properties?.[name];
      if (!declaration || !["enum", "boolean"].includes(declaration.type)
        || !Object.hasOwn(declaration, "default")) {
        errors.push(`${component.id}.variantSet property ${name} needs an enum or boolean declaration with a default.`);
      }
    }
    if (!Array.isArray(variants) || variants.length === 0) {
      errors.push(`${component.id}.variantSet needs at least one authored variant.`);
      continue;
    }
    const combinations = new Set();
    let hasDefault = false;
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)
        || typeof variant.ref !== "string" || !variant.ref
        || !variant.when || typeof variant.when !== "object" || Array.isArray(variant.when)
        || Object.keys(variant.when).length !== names.length
        || names.some((name) => !Object.hasOwn(variant.when, name))) {
        errors.push(`${component.id}.variantSet has an incomplete variant mapping.`);
        continue;
      }
      const combination = JSON.stringify(names.map((name) => variant.when[name]));
      if (combinations.has(combination)) errors.push(`${component.id}.variantSet repeats combination ${combination}.`);
      combinations.add(combination);
      for (const name of names) {
        const declaration = component.properties?.[name];
        const value = variant.when[name];
        if (declaration?.type === "boolean" && typeof value !== "boolean"
          || declaration?.type === "enum" && !declaration.values?.some((item) => Object.is(item, value))) {
          errors.push(`${component.id}.variantSet has invalid ${name} value ${JSON.stringify(value)}.`);
        }
      }
      const member = nodes.get(variant.ref);
      if (!member || member.type !== "frame" || member.role || parents.get(variant.ref) !== null) {
        errors.push(`${component.id}.variantSet target ${variant.ref} must be a local roleless frame.`);
      } else if (member.variantSet && member.id !== component.id) {
        errors.push(`${component.id}.variantSet target ${variant.ref} belongs to another variant set.`);
      } else if (variant.ref !== component.id && member.properties) {
        errors.push(`${component.id}.variantSet target ${variant.ref} must use the set's property interface, not declare its own.`);
      }
      const previousOwner = ownedMembers.get(variant.ref);
      if (previousOwner && previousOwner !== component.id) errors.push(`${variant.ref} belongs to variant sets ${previousOwner} and ${component.id}.`);
      ownedMembers.set(variant.ref, component.id);
      if (variant.ref === component.id && names.every((name) => Object.is(variant.when[name], component.properties?.[name]?.default))) hasDefault = true;
    }
    if (!hasDefault) errors.push(`${component.id}.variantSet must map its default combination to its own frame.`);
  }
  for (const node of nodes.values()) {
    if (node.type !== "ref") continue;
    const leader = ownedMembers.get(node.ref);
    if (leader && leader !== node.ref) errors.push(`${node.id} must reference variant-set leader ${leader}, not member ${node.ref}.`);
  }
  return errors;
}

export function assertVariantSets(document) {
  const errors = validateVariantSets(document);
  const nodes = indexCanvasNodes(document?.children);
  if (errors.length === 0) {
    for (const node of nodes.values()) {
      if (node.type !== "ref" || typeof node.ref !== "string") continue;
      const component = nodes.get(node.ref);
      if (!component?.variantSet || component.variantSet.properties.some((name) => Object.hasOwn(node.bind ?? {}, name))) continue;
      try { variantSelection(component, node.props ?? {}); }
      catch (error) { errors.push(`${node.id}: ${error.message}`); }
    }
  }
  if (errors.length) {
    const error = new Error(errors[0]);
    error.code = "CANVAS_VARIANT_SET_INVALID";
    error.errors = errors;
    throw error;
  }
}
