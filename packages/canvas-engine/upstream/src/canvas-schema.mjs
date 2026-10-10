import { validateRichText } from "./rich-text.mjs";
import { validateVariantSets, variantMemberProperties, variantSelection } from "./component-variants.mjs";

export const CANVAS_MODULES = Object.freeze(["generic", "deck", "web", "mobile"]);
export const CANVAS_ROLES = Object.freeze({ deck: ["slide"], web: ["route"], mobile: ["ios", "android"] });
export const CANVAS_NODE_TYPES = Object.freeze(["frame", "group", "rectangle", "ellipse", "polygon", "line", "path", "text", "icon", "ref"]);

const fields = (names, overrides = {}) => Object.fromEntries(names.map((name) => [name, {
  type: "canvas-value",
  capability: true,
  ...(overrides[name] ?? {}),
}]));

export const CANVAS_SCHEMA = deepFreeze({
  definitions: {
    physical: { type: "object", required: ["w", "h", "unit"], additional: false, fields: {
      w: { type: "number" }, h: { type: "number" }, unit: { type: "enum", values: ["in", "mm"] },
    } },
    mark: { type: "object", required: ["from", "to", "type", "value"], additional: false, fields: {
      from: { type: "integer" }, to: { type: "integer" },
      type: { type: "enum", values: ["fill", "weight", "italic", "underline", "strikethrough", "fontFamily", "fontSize", "letterSpacing", "wordSpacing", "lang", "link"] },
      value: { type: "json" },
    } },
    paragraph: { type: "object", required: ["from", "to"], additional: false, fields: {
      from: { type: "integer" }, to: { type: "integer" }, style: { type: "string" },
      align: { type: "enum", values: ["start", "center", "end", "justify"] },
      headingLevel: { type: "integer" }, list: { type: "object" },
    } },
    import: { type: "object", required: ["documentId"], additional: false, fields: {
      documentId: { type: "string" }, pin: { type: "enum", values: ["exact", "live"] }, version: { type: "integer" },
    } },
    flow: { type: "object", required: ["id", "from", "to", "trigger"], additional: false, fields: {
      id: { type: "string" }, from: { type: "string" }, to: { type: "string" }, trigger: { type: "object" },
    } },
    axis: { type: "object", required: ["modes"], fields: { modes: { type: "array", items: { type: "object" }, minItems: 1 } } },
    variable: { type: "object", required: ["tokenType", "cascade"], fields: {
      tokenType: { type: "enum", values: ["color", "dimension", "number", "string", "fontFamily", "duration"] },
      cascade: { type: "array", items: { type: "object" }, minItems: 1 },
    } },
    property: { type: "object", required: ["type"], fields: {
      type: { type: "enum", values: ["string", "number", "boolean", "color", "enum", "icon", "node"] },
      optional: { type: "boolean" }, default: { type: "json" }, values: { type: "array", items: { type: "json" } },
      min: { type: "number" }, max: { type: "number" },
    } },
  },
  root: {
    type: "object",
    required: ["module", "axes", "variables", "paragraphStyles", "imports", "flows", "children"],
    fields: fields(
      ["module", "lang", "axes", "variables", "paragraphStyles", "imports", "flows", "children"],
      {
        module: { type: "enum", values: CANVAS_MODULES },
        lang: { type: "string" },
        axes: { type: "record", values: { ref: "axis" } },
        variables: { type: "record", values: { ref: "variable" } },
        paragraphStyles: { type: "record" },
        imports: { type: "record", values: { ref: "import" } },
        flows: { type: "array", items: { ref: "flow" } },
        children: { type: "array", items: { ref: "node" } },
      },
    ),
  },
  node: {
    required: ["id", "type"],
    groups: {
      common: fields(["id", "type", "name", "x", "y", "width", "height", "rotation", "flipX", "flipY", "opacity", "enabled", "export", "description", "decorative", "role", "size", "physical", "bleed", "safeMargin", "folds", "properties", "variantSet", "bind", "visible", "varies", "modes", "notesFor"], {
        id: { type: "string" }, type: { type: "enum", values: CANVAS_NODE_TYPES },
        name: { type: "string" }, x: { type: "number" }, y: { type: "number" },
        width: { type: "dimension" }, height: { type: "dimension" }, rotation: { type: "number" },
        flipX: { type: "boolean" }, flipY: { type: "boolean" }, opacity: { type: "number" }, enabled: { type: "boolean" },
        export: { type: "enum", values: ["default", "image"] }, description: { type: "string", capability: false }, decorative: { type: "boolean" },
        role: { type: "enum", values: Object.values(CANVAS_ROLES).flat() }, size: { type: "string" }, physical: { ref: "physical" },
        bleed: { type: "number" }, safeMargin: { type: "number" }, folds: { type: "array", items: { type: "number" } },
        properties: { type: "record", values: { ref: "property" } }, bind: { type: "record", values: { type: "string" } },
        variantSet: { type: "object", capability: false },
        visible: { type: "object" }, varies: { type: "array", items: { type: "string" } }, modes: { type: "record", values: { type: "string" } }, notesFor: { type: "string" },
      }),
      layout: fields(["layout", "gap", "rowGap", "columnGap", "padding", "justifyContent", "alignItems", "wrap", "minWidth", "maxWidth", "minHeight", "maxHeight", "gridTemplateColumns", "gridTemplateRows", "gridColumn", "gridRow", "layoutPosition", "clip"], {
        layout: { type: "enum", values: ["none", "horizontal", "vertical", "grid"] }, gap: { type: "canvas-value" }, rowGap: { type: "canvas-value" }, columnGap: { type: "canvas-value" },
        wrap: { type: "boolean" }, minWidth: { type: "dimension" }, maxWidth: { type: "dimension" }, minHeight: { type: "dimension" }, maxHeight: { type: "dimension" },
        gridTemplateColumns: { type: "array", items: { type: "dimension" } }, gridTemplateRows: { type: "array", items: { type: "dimension" } },
        gridColumn: { type: "integer" }, gridRow: { type: "integer" }, layoutPosition: { type: "enum", values: ["absolute", "relative"] }, clip: { type: "boolean" },
      }),
      paint: fields(["fill", "stroke", "effect", "blendMode", "cornerRadius"], {
        blendMode: { type: "string" },
      }),
      text: fields(["content", "style", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "textAlign", "textAlignVertical", "textGrowth", "underline", "strikethrough", "lang", "headingLevel", "landmark", "linkName", "paragraphs", "marks"], {
        content: { type: "string" }, style: { type: "string" }, fontFamily: { type: "string" }, fontSize: { type: "number" },
        fontWeight: { type: "number-or-string" }, fontStyle: { type: "string" }, lineHeight: { type: "number" }, letterSpacing: { type: "number" }, wordSpacing: { type: "number" },
        textAlign: { type: "enum", values: ["start", "center", "end", "justify"] }, textAlignVertical: { type: "enum", values: ["top", "center", "bottom"] },
        textGrowth: { type: "enum", values: ["auto", "fixed-width", "fixed-width-height"] }, underline: { type: "boolean" }, strikethrough: { type: "boolean" },
        lang: { type: "string" }, headingLevel: { type: "integer" }, landmark: { type: "string", capability: false }, linkName: { type: "string", capability: false },
        paragraphs: { type: "array", items: { ref: "paragraph" } }, marks: { type: "array", items: { ref: "mark" } },
      }),
      icon: fields(["icon", "library", "weight"], { icon: { type: "string" }, library: { type: "string" }, weight: { type: "number" } }),
      path: fields(["geometry", "viewBox", "fillRule"], { geometry: { type: "string" }, viewBox: { type: "array", items: { type: "number" } }, fillRule: { type: "enum", values: ["nonzero", "evenodd"] } }),
      ref: fields(["ref", "props"], { ref: { type: "string" }, props: { type: "record" } }),
    },
    variants: Object.fromEntries(CANVAS_NODE_TYPES.map((type) => [type, { type }])),
  },
  capability: {
    roles: Object.values(CANVAS_ROLES).flat(),
    relationships: ["ref", "import", "notesFor", "flow"],
    properties: [
      "fill.solid", "fill.image", "fill.gradient.linear", "fill.gradient.linear.transformed", "fill.gradient.radial", "fill.gradient.radial.transformed", "fill.gradient.angular", "fill.gradient.mesh", "fill.shader",
      "stroke.width", "stroke.align", "stroke.cap", "stroke.join", "stroke.dash", "stroke.fill",
      "effect.shadow", "effect.shadow.spread", "effect.blur", "effect.background_blur",
      "text.run.fill", "text.run.weight", "text.run.italic", "text.run.underline", "text.run.strikethrough", "text.run.fontFamily", "text.run.fontSize", "text.run.letterSpacing", "text.run.wordSpacing", "text.run.language", "text.run.link",
      "text.paragraph.align", "text.paragraph.style", "text.paragraph.list", "text.paragraph.headingLevel", "accessibility.description", "accessibility.landmark", "accessibility.linkName", "flow.advance", "flow.tap", "flow.hover", "flow.keypress",
    ],
  },
});

export function capabilityPathInventory() {
  const paths = new Set([
    ...capabilityFields(CANVAS_SCHEMA.root.fields).map((path) => `root.${path}`),
    ...CANVAS_SCHEMA.capability.roles.map((role) => `roles.${role}`),
    ...Object.keys(CANVAS_SCHEMA.node.variants).map((type) => `nodes.${type}`),
    ...Object.values(CANVAS_SCHEMA.node.groups).flatMap(capabilityFields).map((path) => `properties.${path}`),
    ...CANVAS_SCHEMA.capability.relationships.map((path) => `relationships.${path}`),
  ]);
  for (const path of CANVAS_SCHEMA.capability.properties) paths.add(`properties.${path}`);
  return [...paths].sort();
}

export function validateCanvasDocument(document, options = {}) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) return invalid(["Document must be an object."], options);
  validateGeneratedShape(document, CANVAS_SCHEMA.root, "root", errors);
  const nodes = new Map();
  const parents = new Map();
  walk(document.children, null, (node, parent) => {
    validateGeneratedNode(node, errors);
    if (typeof node.id !== "string" || !node.id) errors.push("Every node needs a non-empty id.");
    else if (nodes.has(node.id)) errors.push(`Duplicate node id ${node.id}.`);
    else { nodes.set(node.id, node); parents.set(node.id, parent); }
    if (node.export !== undefined && !["default", "image"].includes(node.export)) errors.push(`${node.id}.export must be default or image.`);
    if (node.decorative === true && node.description != null) errors.push(`${node.id}.description and decorative are mutually exclusive.`);
    if (node.role !== undefined && node.type !== "frame") errors.push(`${node.id}.role may only appear on a frame.`);
    else if (node.role !== undefined && !CANVAS_ROLES[document.module]?.includes(node.role)) errors.push(`${node.id}.role ${node.role} is invalid for ${document.module}.`);
    validateFrameGeometry(node, errors);
    if (node.type === "text") errors.push(...validateRichText(node));
    if (["path", "polygon"].includes(node.type)) {
      if (typeof node.geometry !== "string" || !node.geometry.trim()) errors.push(`${node.id}.geometry must be a non-empty SVG path string.`);
      if (!Array.isArray(node.viewBox) || node.viewBox.length !== 4 || node.viewBox.some((value) => !Number.isFinite(value)) || node.viewBox[2] <= 0 || node.viewBox[3] <= 0) errors.push(`${node.id}.viewBox must contain x, y, positive width and positive height.`);
    }
    if (node.type === "ref" && typeof node.ref !== "string") errors.push(`${node.id}.ref must be a string.`);
    validateProperties(node, errors);
  });
  if (document.lang !== undefined && !validLanguage(document.lang)) errors.push("lang must be a valid BCP-47 language tag.");
  validateAxes(document.axes ?? {}, errors);
  validateVariables(document.variables ?? {}, errors);
  validateImports(document.imports ?? {}, errors);
  validateRoleNesting(nodes, parents, errors);
  validateLayoutSizing(nodes, parents, errors);
  validateNotes(nodes, parents, errors);
  validateAccessibility(document, nodes, errors);
  validateRefs(nodes, parents, errors);
  errors.push(...validateVariantSets(document));
  validateComponentSemantics(document, nodes, errors);
  validateFlows(document.flows ?? [], nodes, parents, errors);
  return invalid(errors, options);
}

function validateLayoutSizing(nodes, parents, errors) {
  for (const [id, node] of nodes) {
    if (parents.get(id) !== null) continue;
    if (node.width === "fill_container" || node.height === "fill_container") {
      errors.push(`${id} cannot use fill_container without a parent layout container.`);
    }
  }
}

function validateFrameGeometry(node, errors) {
  if (node.physical && [node.physical.w, node.physical.h].some((value) => !Number.isFinite(value) || value <= 0)) errors.push(`${node.id}.physical dimensions must be finite positive numbers.`);
  const hasPrintGeometry = node.bleed !== undefined || node.safeMargin !== undefined || node.folds !== undefined;
  if (!hasPrintGeometry) return;
  if (node.type !== "frame") errors.push(`${node.id}.bleed, safeMargin and folds may only appear on a frame.`);
  if (node.bleed !== undefined && (!Number.isFinite(node.bleed) || node.bleed < 0)) errors.push(`${node.id}.bleed must be a non-negative number of points.`);
  if (node.safeMargin !== undefined && (!Number.isFinite(node.safeMargin) || node.safeMargin < 0)) errors.push(`${node.id}.safeMargin must be a non-negative number of points.`);
  if (node.folds !== undefined) {
    if (!Array.isArray(node.folds) || node.folds.some((fold) => !Number.isFinite(fold) || fold <= 0 || (typeof node.width === "number" && fold >= node.width))) {
      errors.push(`${node.id}.folds must contain positions strictly inside the frame width.`);
    } else if (new Set(node.folds).size !== node.folds.length || node.folds.some((fold, index) => index > 0 && fold <= node.folds[index - 1])) {
      errors.push(`${node.id}.folds must be unique and strictly increasing.`);
    }
  }
}

export function assertCapabilityTotality(table, inventory = capabilityPathInventory()) {
  const missing = inventory.filter((path) => !Object.hasOwn(table.properties ?? {}, path));
  const extra = Object.keys(table.properties ?? {}).filter((path) => !inventory.includes(path));
  const invalidVerdicts = Object.entries(table.properties ?? {}).filter(([, entry]) =>
    entry.verdict !== null && !["native", "raster", "ignore"].includes(entry.verdict));
  const unverified = Object.entries(table.properties ?? {}).filter(([, entry]) => entry.status === "unverified");
  if (missing.length || extra.length || invalidVerdicts.length || unverified.length) {
    const error = new Error(`Capability table is not buildable: missing=${missing.join(",")} extra=${extra.join(",")} invalid=${invalidVerdicts.map(([p]) => p).join(",")} unverified=${unverified.map(([p]) => p).join(",")}`);
    error.code = "CANVAS_CAPABILITY_INCOMPLETE";
    throw error;
  }
  return true;
}

function validateProperties(node, errors) {
  if (node.properties === undefined) return;
  if (!plainObject(node.properties)) { errors.push(`${node.id}.properties must be an object.`); return; }
  for (const [name, property] of Object.entries(node.properties)) {
    if (!plainObject(property) || !["string", "number", "boolean", "color", "enum", "icon", "node"].includes(property.type)) errors.push(`${node.id}.properties.${name} has an invalid type.`);
    if (property?.optional === true && Object.hasOwn(property, "default")) errors.push(`${node.id}.properties.${name} cannot be optional and have a default.`);
    if (property?.type === "enum" && (!Array.isArray(property.values) || property.values.length === 0)) errors.push(`${node.id}.properties.${name} enum needs values.`);
    if (property?.type === "number" && property.min !== undefined && property.max !== undefined && property.min > property.max) errors.push(`${node.id}.properties.${name} min exceeds max.`);
    if (Object.hasOwn(property ?? {}, "default") && !propertyValueCompatible(property.default, property)) errors.push(`${node.id}.properties.${name} default does not satisfy ${property.type}.`);
  }
}

function validateAxes(axes, errors) {
  for (const [name, axis] of Object.entries(axes)) {
    if (!["appearance", "viewport"].includes(name)) errors.push(`Axis ${name} is not supported; use appearance or viewport.`);
    if (!plainObject(axis) || !Array.isArray(axis.modes) || axis.modes.length === 0) { errors.push(`Axis ${name} needs a non-empty modes array.`); continue; }
    const names = axis.modes.map((mode) => mode?.name);
    if (names.some((mode) => typeof mode !== "string" || !mode)) errors.push(`Axis ${name} modes need non-empty names.`);
    if (new Set(names).size !== names.length) errors.push(`Axis ${name} mode names must be unique.`);
  }
}

function validateVariables(variables, errors) {
  const tokenTypes = new Set(["color", "dimension", "number", "string", "fontFamily", "duration"]);
  for (const [name, variable] of Object.entries(variables)) {
    if (!plainObject(variable) || typeof variable.tokenType !== "string" || !variable.tokenType
      || !Array.isArray(variable.cascade) || variable.cascade.length === 0)
      errors.push(`Variable ${name} must declare tokenType and a non-empty cascade.`);
    else if (!tokenTypes.has(variable.tokenType)) errors.push(`Variable ${name} has unsupported tokenType ${variable.tokenType}.`);
  }
}

function validateImports(imports, errors) {
  for (const [alias, record] of Object.entries(imports)) {
    if (!/^[A-Za-z][\w-]*$/u.test(alias)) errors.push(`Import alias ${alias} is invalid.`);
    if (!plainObject(record) || typeof record.documentId !== "string" || !record.documentId || (record.pin !== undefined && !["exact", "live"].includes(record.pin)) || (record.pin === "exact" && !Number.isInteger(record.version)))
      errors.push(`Import ${alias} must declare documentId and a valid live or exact pin.`);
  }
}

function validateRoleNesting(nodes, parents, errors) {
  for (const node of nodes.values()) if (node.role) {
    let ancestor = parents.get(node.id);
    while (ancestor) {
      if (nodes.get(ancestor)?.role) { errors.push(`${node.id} role-bearing frame is nested inside ${ancestor}.`); break; }
      ancestor = parents.get(ancestor);
    }
  }
}

function validateNotes(nodes, parents, errors) {
  const claimed = new Set();
  for (const node of nodes.values()) if (node.notesFor !== undefined) {
    const target = nodes.get(node.notesFor);
    if (node.type !== "text" || target?.type !== "frame" || target?.role !== "slide") errors.push(`${node.id}.notesFor must name a slide frame and may only appear on text.`);
    let ancestor = parents.get(node.id); let inside = false;
    while (ancestor) { if (ancestor === node.notesFor) inside = true; ancestor = parents.get(ancestor); }
    if (inside) errors.push(`${node.id} speaker notes must live outside ${node.notesFor}.`);
    if (claimed.has(node.notesFor)) errors.push(`More than one notes node claims ${node.notesFor}.`);
    claimed.add(node.notesFor);
  }
}

function validateAccessibility(document, nodes, errors) {
  for (const node of nodes.values()) {
    if (node.type === "text" && node.style !== undefined && !Object.hasOwn(document.paragraphStyles ?? {}, node.style)) errors.push(`${node.id}.style references missing paragraph style ${node.style}.`);
    if (node.lang !== undefined && !validLanguage(node.lang)) errors.push(`${node.id}.lang must be a valid BCP-47 language tag.`);
    for (const [index, mark] of (node.marks ?? []).entries()) if (mark.type === "lang" && !validLanguage(mark.value)) errors.push(`${node.id}.marks[${index}] lang must be a valid BCP-47 tag.`);
    for (const [index, paragraph] of (node.paragraphs ?? []).entries()) {
      if (paragraph.headingLevel !== undefined && (!Number.isInteger(paragraph.headingLevel) || paragraph.headingLevel < 1 || paragraph.headingLevel > 6)) errors.push(`${node.id}.paragraphs[${index}].headingLevel must be 1–6.`);
      if (paragraph.style !== undefined && !Object.hasOwn(document.paragraphStyles ?? {}, paragraph.style)) errors.push(`${node.id}.paragraphs[${index}] references missing paragraph style ${paragraph.style}.`);
    }
    if (node.modes !== undefined) {
      if (!plainObject(node.modes)) errors.push(`${node.id}.modes must be an object.`);
      else for (const [axis, mode] of Object.entries(node.modes)) {
        const names = document.axes?.[axis]?.modes?.map((entry) => entry.name) ?? [];
        if (!names.includes(mode)) errors.push(`${node.id}.modes.${axis} references unknown axis mode ${mode}.`);
      }
    }
  }
}

function validateRefs(nodes, parents, errors) {
  const localRefs = new Map();
  for (const node of nodes.values()) if (node.type === "ref" && !node.ref.includes(":")) {
    localRefs.set(node.id, node.ref);
    if (!nodes.has(node.ref)) errors.push(`${node.id} references missing node ${node.ref}.`);
    let ancestor = parents.get(node.ref);
    while (ancestor) {
      if (nodes.get(ancestor)?.role) { errors.push(`${node.id} targets ${node.ref} inside role-bearing frame ${ancestor}.`); break; }
      ancestor = parents.get(ancestor);
    }
  }
  for (const start of localRefs.keys()) {
    const path = []; const seen = new Set(); let current = start;
    while (localRefs.has(current)) {
      if (seen.has(current)) { errors.push(`Ref cycle: ${[...path, current].join(" -> ")}.`); break; }
      seen.add(current); path.push(current); current = localRefs.get(current);
    }
  }
  const componentIds = new Set([...localRefs.values()].filter((id) => nodes.has(id)));
  const dependencies = new Map([...componentIds].map((id) => [id, new Set()]));
  const collectDependencies = (componentId, candidate) => {
    for (const child of candidate.children ?? []) {
      if (child.type === "ref" && !child.ref.includes(":") && componentIds.has(child.ref)) dependencies.get(componentId).add(child.ref);
      collectDependencies(componentId, child);
    }
  };
  for (const componentId of componentIds) collectDependencies(componentId, nodes.get(componentId));
  const visiting = new Set(); const visited = new Set();
  const visit = (componentId, path = []) => {
    if (visiting.has(componentId)) { errors.push(`Component ref cycle: ${[...path, componentId].join(" -> ")}.`); return; }
    if (visited.has(componentId)) return;
    visiting.add(componentId);
    for (const dependency of dependencies.get(componentId) ?? []) visit(dependency, [...path, componentId]);
    visiting.delete(componentId); visited.add(componentId);
  };
  for (const componentId of componentIds) visit(componentId);
}

function validateComponentSemantics(document, nodes, errors) {
  const memberProperties = variantMemberProperties(document);
  const visit = (node, inheritedDeclarations = {}) => {
    const declarations = node.properties ?? memberProperties.get(node.id) ?? inheritedDeclarations;
    for (const [property, binding] of Object.entries(node.bind ?? {})) {
      if (typeof binding !== "string" || !binding.startsWith("$props.")) {
        errors.push(`${node.id}.bind.${property} must be a $props name.`);
        continue;
      }
      const name = binding.slice(7);
      const declaration = declarations[name];
      if (!declaration) errors.push(`${node.id}.bind.${property} references undeclared property ${name}.`);
      else if (!bindingDestinationAccepts(property, declaration.type)) {
        errors.push(`${node.id}.bind.${property} cannot accept ${declaration.type} property ${name}.`);
      }
    }
    if (node.visible !== undefined) validateConditionAst(node.visible, declarations, `${node.id}.visible`, errors);
    if (node.varies !== undefined) {
      if (!Array.isArray(node.varies)) errors.push(`${node.id}.varies must be an array of axis names.`);
      else for (const axis of node.varies) if (!Object.hasOwn(document.axes ?? {}, axis)) errors.push(`${node.id}.varies references unknown axis ${axis}.`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (isCascadeValue(value)) validateCascadeValue(value, document.axes ?? {}, declarations, `${node.id}.${key}`, errors);
    }
    if (node.type === "ref" && typeof node.ref === "string" && !node.ref.includes(":")) {
      const target = nodes.get(node.ref);
      if (target) {
        validateSuppliedProps(node, target.properties ?? {}, errors);
        if (target.variantSet && !target.variantSet.properties.some((name) => Object.hasOwn(node.bind ?? {}, name))) {
          try { variantSelection(target, node.props ?? {}); }
          catch (error) { errors.push(`${node.id}: ${error.message}`); }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, declarations);
  };
  for (const node of document.children ?? []) visit(node);
  for (const [name, variable] of Object.entries(document.variables ?? {})) {
    if (Array.isArray(variable?.cascade)) validateCascadeValue(variable.cascade, document.axes ?? {}, {}, `variables.${name}.cascade`, errors);
  }
}

function validateSuppliedProps(instance, declarations, errors) {
  if (!plainObject(instance.props ?? {})) {
    errors.push(`${instance.id}.props must be an object.`);
    return;
  }
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!Object.hasOwn(instance.props ?? {}, name)) {
      if (!Object.hasOwn(declaration, "default") && declaration.optional !== true) errors.push(`${instance.id}.props is missing required property ${name}.`);
      continue;
    }
    const value = instance.props[name];
    if (isCascadeValue(value)) errors.push(`${instance.id}.props.${name} may not be a cascade.`);
    else if (!propertyValueCompatible(value, declaration)) errors.push(`${instance.id}.props.${name} does not satisfy ${declaration.type}.`);
  }
  for (const name of Object.keys(instance.props ?? {})) if (!Object.hasOwn(declarations, name)) errors.push(`${instance.id}.props supplies undeclared property ${name}.`);
}

function validateConditionAst(condition, declarations, path, errors) {
  if (!plainObject(condition) || !["eq", "neq", "notNull", "isNull", "in", "gt", "lt", "and", "or", "not"].includes(condition.op)) {
    errors.push(`${path} has an invalid condition operator.`);
    return;
  }
  if (["and", "or"].includes(condition.op)) {
    if (!Array.isArray(condition.args) || condition.args.length === 0) errors.push(`${path}.${condition.op} needs non-empty args.`);
    else condition.args.forEach((entry, index) => validateConditionAst(entry, declarations, `${path}.args[${index}]`, errors));
    return;
  }
  if (condition.op === "not") {
    validateConditionAst(condition.arg, declarations, `${path}.arg`, errors);
    return;
  }
  const prop = condition.arg?.prop;
  const declaration = declarations[prop];
  if (typeof prop !== "string" || !declaration) {
    errors.push(`${path} references undeclared property ${String(prop)}.`);
    return;
  }
  if (["gt", "lt"].includes(condition.op) && declaration.type !== "number") errors.push(`${path}.${condition.op} requires a number property.`);
  if (condition.op === "in" && !Array.isArray(condition.value)) errors.push(`${path}.in requires an array value.`);
  if (["eq", "neq", "gt", "lt"].includes(condition.op) && !propertyValueCompatible(condition.value, declaration)) errors.push(`${path}.value does not satisfy ${declaration.type}.`);
  if (condition.op === "in" && Array.isArray(condition.value) && condition.value.some((value) => !propertyValueCompatible(value, declaration))) errors.push(`${path}.value contains an item that does not satisfy ${declaration.type}.`);
}

function validateCascadeValue(cascade, axes, declarations, path, errors) {
  for (const [index, entry] of cascade.entries()) {
    if (!plainObject(entry) || !Object.hasOwn(entry, "value") || Object.keys(entry).some((key) => !["value", "when"].includes(key))) {
      errors.push(`${path}[${index}] is not a cascade entry.`);
      continue;
    }
    for (const [axis, mode] of Object.entries(entry.when ?? {})) {
      if (axis === "props") {
        if (!plainObject(mode)) errors.push(`${path}[${index}].when.props must be an object.`);
        else for (const [name, value] of Object.entries(mode)) {
          if (!declarations[name]) errors.push(`${path}[${index}].when.props references undeclared property ${name}.`);
          else if (!propertyValueCompatible(value, declarations[name])) errors.push(`${path}[${index}].when.props.${name} does not satisfy ${declarations[name].type}.`);
        }
      } else {
        const names = axes[axis]?.modes?.map((item) => item.name) ?? [];
        if (!names.includes(mode)) errors.push(`${path}[${index}].when references unknown mode ${axis}:${mode}.`);
      }
    }
  }
}

function isCascadeValue(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => plainObject(entry) && Object.hasOwn(entry, "value"));
}

function propertyValueCompatible(value, declaration) {
  if (value === null) return declaration.optional === true;
  if (declaration.type === "number") return typeof value === "number" && Number.isFinite(value) && (declaration.min === undefined || value >= declaration.min) && (declaration.max === undefined || value <= declaration.max);
  if (declaration.type === "boolean") return typeof value === "boolean";
  if (["string", "color", "icon"].includes(declaration.type)) return typeof value === "string";
  if (declaration.type === "enum") return declaration.values?.includes(value);
  if (declaration.type === "node") return plainObject(value) && typeof value.type === "string";
  return false;
}

function bindingDestinationAccepts(property, type) {
  if (["content", "name", "fontFamily", "fontStyle", "lang", "linkName", "library"].includes(property)) return type === "string";
  if (property === "icon") return type === "icon" || type === "string";
  if (["enabled", "clip", "flipX", "flipY", "underline", "strikethrough"].includes(property)) return type === "boolean";
  if (["x", "y", "width", "height", "gap", "rowGap", "columnGap", "opacity", "rotation", "fontSize", "lineHeight", "letterSpacing", "wordSpacing", "weight"].includes(property)) return type === "number";
  if (["fill", "stroke"].includes(property)) return type === "color";
  if (property === "children") return type === "node";
  return true;
}

function validateFlows(flows, nodes, parents, errors) {
  const signatures = new Set();
  for (const flow of flows) {
    const from = nodes.get(flow.from); const to = nodes.get(flow.to);
    if (!from?.role || !to?.role || from.role !== to.role) errors.push(`Flow ${flow.id} endpoints must be role-bearing frames with the same role.`);
    if (!flow.trigger || !["advance", "tap", "hover", "keypress"].includes(flow.trigger.kind)) errors.push(`Flow ${flow.id} has an invalid trigger.`);
    if (flow.trigger?.kind !== "advance" && !flow.trigger?.source) errors.push(`Flow ${flow.id} trigger requires source.`);
    if (flow.trigger?.source) {
      const source = flow.trigger.source;
      if (!Array.isArray(source.path) || source.path.some((id) => typeof id !== "string") || typeof source.node !== "string") errors.push(`Flow ${flow.id} source must be a typed instance path.`);
      else if (source.path.length === 0) {
        if (!nodes.has(source.node) || !isDescendant(source.node, flow.from, parents)) errors.push(`Flow ${flow.id} source ${source.node} must live inside ${flow.from}.`);
      } else validateFlowInstancePath(flow, source, nodes, parents, errors);
    }
    const signature = JSON.stringify([flow.from, flow.trigger?.source, flow.trigger]);
    if (signatures.has(signature)) errors.push(`Flow ${flow.id} duplicates an existing flow.`);
    signatures.add(signature);
  }
}

function validateFlowInstancePath(flow, source, nodes, parents, errors) {
  let container = flow.from;
  for (const [index, instanceId] of source.path.entries()) {
    const instance = nodes.get(instanceId);
    if (instance?.type !== "ref" || instance.ref.includes(":")) {
      errors.push(`Flow ${flow.id} source path ${instanceId} must name a local ref instance.`);
      return;
    }
    if (!isDescendant(instanceId, container, parents)) {
      errors.push(`Flow ${flow.id} source path ${instanceId} is outside ${container}.`);
      return;
    }
    const target = nodes.get(instance.ref);
    if (!target) {
      errors.push(`Flow ${flow.id} source path ${instanceId} targets missing ${instance.ref}.`);
      return;
    }
    container = target.id;
    if (index + 1 < source.path.length && !nodes.has(source.path[index + 1])) {
      errors.push(`Flow ${flow.id} source path contains missing ${source.path[index + 1]}.`);
      return;
    }
  }
  if (!nodes.has(source.node) || (source.node !== container && !isDescendant(source.node, container, parents)))
    errors.push(`Flow ${flow.id} source node ${source.node} is outside the final component ${container}.`);
}

function isDescendant(nodeId, ancestorId, parents) { let current = parents.get(nodeId); while (current) { if (current === ancestorId) return true; current = parents.get(current); } return false; }

function walk(children = [], parent, visit) {
  for (const node of children) { visit(node, parent); walk(node.children, node.id, visit); }
}

function plainObject(value) { return value && typeof value === "object" && !Array.isArray(value); }
function capabilityFields(definition) { return Object.entries(definition).flatMap(([name, field]) => field.capability ? [name] : []); }
function validateGeneratedNode(node, errors) {
  const schema = {
    type: "object",
    required: CANVAS_SCHEMA.node.required,
    fields: Object.assign({}, ...Object.values(CANVAS_SCHEMA.node.groups)),
  };
  validateGeneratedShape(node, schema, node?.id ?? "node", errors);
}
function validateGeneratedShape(value, schema, path, errors) {
  if (schema?.ref) {
    if (schema.ref === "node") { validateGeneratedNode(value, errors); return; }
    const resolved = CANVAS_SCHEMA.definitions[schema.ref];
    if (!resolved) { errors.push(`${path} references unknown schema ${schema.ref}.`); return; }
    validateGeneratedShape(value, resolved, path, errors);
    return;
  }
  if (schema?.type === "json" || schema?.type === "canvas-value") return;
  if (schema?.type === "string") { if (typeof value !== "string") errors.push(`${path} must be a string.`); return; }
  if (schema?.type === "number") { if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path} must be a finite number.`); return; }
  if (schema?.type === "integer") { if (!Number.isInteger(value)) errors.push(`${path} must be an integer.`); return; }
  if (schema?.type === "boolean") { if (typeof value !== "boolean") errors.push(`${path} must be a boolean.`); return; }
  if (schema?.type === "number-or-string") { if (!((typeof value === "number" && Number.isFinite(value)) || typeof value === "string")) errors.push(`${path} must be a finite number or string.`); return; }
  if (schema?.type === "dimension") { if (!((typeof value === "number" && Number.isFinite(value)) || ["fill_container", "fit_content"].includes(value))) errors.push(`${path} must be a finite number, fill_container or fit_content.`); return; }
  if (schema?.type === "enum") { if (!schema.values.includes(value)) errors.push(`${path} must be one of ${schema.values.join(", ")}.`); return; }
  if (schema?.type === "array") {
    if (!Array.isArray(value)) { errors.push(`${path} must be an array.`); return; }
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} item(s).`);
    if (schema.items) value.forEach((item, index) => validateGeneratedShape(item, schema.items, `${path}[${index}]`, errors));
    return;
  }
  if (schema?.type === "record") {
    if (!plainObject(value)) { errors.push(`${path} must be an object.`); return; }
    if (schema.values) for (const [name, item] of Object.entries(value)) validateGeneratedShape(item, schema.values, `${path}.${name}`, errors);
    return;
  }
  if (schema?.type === "object" && !plainObject(value)) { errors.push(`${path} must be an object.`); return; }
  if (!plainObject(value)) { errors.push(`${path} must be an object.`); return; }
  for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) errors.push(`${path}.${name} is required.`);
  if (schema.additional === false) for (const name of Object.keys(value)) if (!Object.hasOwn(schema.fields ?? {}, name)) errors.push(`${path}.${name} is not allowed.`);
  for (const [name, field] of Object.entries(schema.fields ?? {})) {
    if (!Object.hasOwn(value, name)) continue;
    const candidate = value[name];
    if (isCascadeValue(candidate) && !["array", "record", "object"].includes(field.type) && !field.ref) continue;
    validateGeneratedShape(candidate, field, `${path}.${name}`, errors);
    if (Object.hasOwn(field, "const") && candidate !== field.const) errors.push(`${path}.${name} must be ${field.const}.`);
  }
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function validLanguage(value) { try { return typeof value === "string" && Boolean(new Intl.Locale(value)); } catch { return false; } }
function invalid(errors, options) {
  if (errors.length && options.throw !== false) { const error = new Error(errors.join("\n")); error.code = "CANVAS_SCHEMA_INVALID"; error.errors = errors; throw error; }
  return { valid: errors.length === 0, errors };
}
