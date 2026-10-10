import * as Y from "yjs";

const RESERVED_NODE_PROPERTIES = new Set(["id", "type", "children"]);

export function createModel(penDocument, options = {}) {
  const doc = options.doc ?? new Y.Doc(options.docOptions);
  const metadata = doc.getMap("metadata");
  const documentFields = doc.getMap("documentFields");
  const nodes = doc.getMap("nodes");
  assertJsonValue(penDocument, "$document");
  validateNodeTree(penDocument.children, new Set(nodes.keys()));

  doc.transact(() => {
    for (const [key, value] of Object.entries(penDocument)) {
      if (key !== "children") documentFields.set(key, cloneJson(value));
    }
    importChildren(nodes, penDocument.children, null);
  }, options.origin);

  return { doc, metadata, documentFields, nodes };
}

export function openModel(doc) {
  return {
    doc,
    metadata: doc.getMap("metadata"),
    documentFields: doc.getMap("documentFields"),
    nodes: doc.getMap("nodes"),
  };
}

export function setNodeProperty(model, nodeId, property, value, origin) {
  assertEditableModel(model);
  assertJsonValue(value, `$node[${JSON.stringify(nodeId)}].${property}`);
  if (RESERVED_NODE_PROPERTIES.has(property)) {
    throw new Error(
      `${property} is structural and cannot be set as a node property.`,
    );
  }
  transact(model, origin, () => {
    const properties = getNode(model, nodeId).get("properties");
    if (property === "content" && typeof value === "string") {
      const current = properties.get("content");
      if (current instanceof Y.Text) {
        current.delete(0, current.length);
        current.insert(0, value);
      } else {
        properties.set("content", createYText(value));
      }
      return;
    }
    if (property === "marks" && Array.isArray(value)) {
      setRichTextMarks(properties, value);
      return;
    }
    properties.set(property, toYValue(value));
  });
}

export function editText(model, nodeId, index, deleteCount, insert, origin) {
  assertEditableModel(model);
  if (![index, deleteCount].every(Number.isInteger) || index < 0 || deleteCount < 0)
    throw new Error("Text edit offsets must be non-negative integers.");
  if (typeof insert !== "string") throw new Error("Inserted text must be a string.");
  transact(model, origin, () => {
    const properties = getNode(model, nodeId).get("properties");
    const text = properties.get("content");
    if (!(text instanceof Y.Text)) throw new Error(`Node ${nodeId} has no collaborative text content.`);
    if (index + deleteCount > text.length) throw new Error("Text edit range exceeds content length.");
    const insertionAttributes = attributesForInsertion(text, index);
    if (deleteCount) text.delete(index, deleteCount);
    if (insert) text.insert(index, insert, insertionAttributes);
  });
}

export function setNodePropertyPath(
  model,
  nodeId,
  property,
  path,
  value,
  origin,
) {
  assertEditableModel(model);
  assertJsonValue(value, `$node[${JSON.stringify(nodeId)}].${property}`);
  if (RESERVED_NODE_PROPERTIES.has(property)) {
    throw new Error(
      `${property} is structural and cannot be set as a node property.`,
    );
  }
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    path.some((key) => typeof key !== "string" || !key)
  ) {
    throw new Error(
      "A nested property path must contain non-empty string keys.",
    );
  }
  transact(model, origin, () => {
    const properties = getNode(model, nodeId).get("properties");
    let current = properties.get(property);
    if (current === undefined) {
      current = new Y.Map();
      properties.set(property, current);
    }
    for (const key of path.slice(0, -1)) {
      if (current instanceof Y.Map && current.get(key) === undefined) {
        current.set(key, new Y.Map());
      }
      if (!(current instanceof Y.Map)) {
        throw new Error(
          `${property}.${path.join(".")} is not an editable object path.`,
        );
      }
      current = current.get(key);
    }
    if (!(current instanceof Y.Map)) {
      throw new Error(
        `${property}.${path.join(".")} is not an editable object path.`,
      );
    }
    current.set(path.at(-1), toYValue(value));
  });
}

export function insertNode(model, node, parentId, position, origin) {
  assertEditableModel(model);
  assertPosition(position);
  if (parentId !== null) getLiveNode(model, parentId);
  assertJsonValue(node, "$insertedNode");
  validateNodeTree([node], new Set(model.nodes.keys()));
  transact(model, origin, () => {
    model.nodes.set(node.id, createYNode(node, parentId, position));
    initializeNodeMarks(model.nodes.get(node.id), node);
    importChildren(model.nodes, node.children, node.id);
  });
}

export function moveNode(model, nodeId, parentId, position, origin) {
  assertEditableModel(model);
  assertPosition(position);
  const node = getLiveNode(model, nodeId);
  transact(model, origin, () => {
    if (parentId === nodeId) throw new Error("A node cannot parent itself.");
    if (parentId !== null) {
      getLiveNode(model, parentId);
      assertNoLocalParentCycle(model, nodeId, parentId);
    }
    node.set("parentId", parentId);
    node.set("position", position);
  });
}

export function deleteNode(model, nodeId, origin) {
  assertEditableModel(model);
  transact(model, origin, () => getNode(model, nodeId).set("deleted", true));
}

export function restoreNode(model, nodeId, origin) {
  assertEditableModel(model);
  transact(model, origin, () => getNode(model, nodeId).set("deleted", false));
}

export function replaceModelContent(model, penDocument, origin) {
  assertEditableModel(model);
  assertJsonValue(penDocument);
  validateNodeTree(penDocument.children, new Set());
  const desired = new Map();
  const collect = (nodes = [], parentId = null) => {
    nodes.forEach((node, position) => {
      desired.set(node.id, { node, parentId, position });
      collect(node.children, node.id);
    });
  };
  collect(penDocument.children);

  transact(model, origin, () => {
    for (const key of [...model.documentFields.keys()]) {
      if (key !== "children" && !Object.hasOwn(penDocument, key))
        model.documentFields.delete(key);
    }
    for (const [key, value] of Object.entries(penDocument)) {
      if (
        key !== "children" &&
        !jsonValuesEqual(model.documentFields.get(key), value)
      ) {
        model.documentFields.set(key, cloneJson(value));
      }
    }
    for (const [id, current] of model.nodes.entries()) {
      if (!desired.has(id) && current.get("deleted") !== true)
        current.set("deleted", true);
    }
    for (const [id, { node, parentId, position }] of desired) {
      let current = model.nodes.get(id);
      if (!(current instanceof Y.Map)) {
        model.nodes.set(id, createYNode(node, parentId, position));
        initializeNodeMarks(model.nodes.get(id), node);
        continue;
      }
      setYValueIfChanged(current, "type", node.type);
      setYValueIfChanged(current, "parentId", parentId);
      setYValueIfChanged(current, "position", position);
      setYValueIfChanged(current, "deleted", false);
      setYValueIfChanged(current, "hadChildren", Array.isArray(node.children));
      const properties = current.get("properties");
      if (!(properties instanceof Y.Map))
        throw new Error(`Node ${id} has invalid properties.`);
      const nextProperties = Object.fromEntries(
        Object.entries(node).filter(
          ([key]) => !RESERVED_NODE_PROPERTIES.has(key),
        ),
      );
      for (const key of [...properties.keys()]) {
        if (!Object.hasOwn(nextProperties, key) && !(key === "content" && node.type === "text"))
          properties.delete(key);
      }
      for (const [key, value] of Object.entries(nextProperties)) {
        if (node.type === "text" && key === "content" && typeof value === "string") {
          const currentText = properties.get(key);
          if (!(currentText instanceof Y.Text)) properties.set(key, createYText(value));
          else if (currentText.toString() !== value) {
            currentText.delete(0, currentText.length);
            currentText.insert(0, value);
          }
          continue;
        }
        if (node.type === "text" && key === "marks") continue;
        const currentValue = properties.get(key);
        if (
          currentValue === undefined ||
          !jsonValuesEqual(fromYValue(currentValue), value)
        ) {
          properties.set(key, toYValue(value));
        }
      }
      if (node.type === "text" && Array.isArray(node.marks)) setRichTextMarks(properties, node.marks);
    }
  });
}

function setYValueIfChanged(map, key, value) {
  if (!Object.is(map.get(key), value)) map.set(key, value);
}

function jsonValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]),
    )
  );
}

export function materializePen(model) {
  const result = Object.fromEntries(
    [...model.documentFields.entries()].map(([key, value]) => [
      key,
      cloneJson(value),
    ]),
  );
  const live = new Map(
    [...model.nodes.entries()].filter(
      ([id, node]) =>
        node.get("deleted") !== true && !hasDeletedAncestor(model.nodes, id),
    ),
  );
  const parentById = new Map(
    [...live].map(([id, node]) => {
      const parentId = node.get("parentId");
      return [id, parentId === null || live.has(parentId) ? parentId : null];
    }),
  );
  breakParentCycles(parentById);
  const childrenByParent = new Map();

  for (const [id, node] of live) {
    const effectiveParent = parentById.get(id);
    const children = childrenByParent.get(effectiveParent) ?? [];
    children.push({ id, node });
    childrenByParent.set(effectiveParent, children);
  }

  for (const children of childrenByParent.values()) {
    children.sort((left, right) => {
      const delta =
        Number(left.node.get("position")) - Number(right.node.get("position"));
      return delta || left.id.localeCompare(right.id);
    });
  }

  const visiting = new Set();
  const build = ({ id, node }) => {
    if (visiting.has(id)) return null;
    visiting.add(id);
    const properties = node.get("properties");
    const entries = [...properties.entries()];
    const value = {
      type: node.get("type"),
      id,
      ...Object.fromEntries(
        entries.map(([key, property]) => [
          key,
          fromYValue(property),
        ]),
      ),
    };
    const richText = properties.get("content");
    if (richText instanceof Y.Text) {
      const marks = marksFromYText(richText);
      if (marks.length > 0) value.marks = marks;
    }
    const children = (childrenByParent.get(id) ?? [])
      .map(build)
      .filter(Boolean);
    if (children.length > 0 || node.get("hadChildren") === true)
      value.children = children;
    visiting.delete(id);
    return value;
  };

  result.children = (childrenByParent.get(null) ?? [])
    .map(build)
    .filter(Boolean);
  return result;
}

export function syncModels(left, right) {
  const leftUpdate = Y.encodeStateAsUpdate(
    left.doc,
    Y.encodeStateVector(right.doc),
  );
  const rightUpdate = Y.encodeStateAsUpdate(
    right.doc,
    Y.encodeStateVector(left.doc),
  );
  Y.applyUpdate(left.doc, rightUpdate);
  Y.applyUpdate(right.doc, leftUpdate);
}

export function cloneModel(model, docOptions) {
  const doc = new Y.Doc(docOptions);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(model.doc));
  return openModel(doc);
}

function importChildren(nodes, children = [], parentId) {
  children.forEach((node, index) => {
    if (nodes.has(node.id)) throw new Error(`Duplicate node ID ${node.id}.`);
    nodes.set(node.id, createYNode(node, parentId, index));
    initializeNodeMarks(nodes.get(node.id), node);
    importChildren(nodes, node.children, node.id);
  });
}

function createYNode(node, parentId, position) {
  if (
    !node ||
    typeof node !== "object" ||
    typeof node.id !== "string" ||
    !node.id
  ) {
    throw new Error("Every normalized node must have a non-empty string ID.");
  }
  const value = new Y.Map();
  const properties = new Y.Map();
  value.set("type", node.type);
  value.set("parentId", parentId);
  value.set("position", position);
  value.set("deleted", false);
  value.set("hadChildren", Array.isArray(node.children));
  for (const [key, property] of Object.entries(node)) {
    if (key !== "id" && key !== "type" && key !== "children") {
      if (node.type === "text" && key === "content" && typeof property === "string") {
        properties.set(key, createYText(property));
      }
      else if (!(node.type === "text" && key === "marks"))
        properties.set(key, toYValue(property));
    }
  }
  value.set("properties", properties);
  return value;
}

function initializeNodeMarks(value, node) {
  if (node.type !== "text" || !Array.isArray(node.marks)) return;
  const properties = value?.get("properties");
  if (properties instanceof Y.Map) setRichTextMarks(properties, node.marks);
}

function getNode(model, nodeId) {
  const node = model.nodes.get(nodeId);
  if (!(node instanceof Y.Map))
    throw new Error(`Node ${nodeId} was not found.`);
  return node;
}

function getLiveNode(model, nodeId) {
  const node = getNode(model, nodeId);
  if (node.get("deleted") === true)
    throw new Error(`Node ${nodeId} is deleted.`);
  return node;
}

function transact(model, origin, action) {
  model.doc.transact(action, origin);
}

function assertEditableModel(model) {
  if (!model?.doc || !model?.nodes || !model?.documentFields) {
    throw new Error("Canvas model is not editable.");
  }
}

function assertPosition(position) {
  if (typeof position !== "number" || !Number.isFinite(position)) {
    throw new Error("Node position must be a finite number.");
  }
}

function validateNodeTree(children, occupiedIds) {
  if (!Array.isArray(children))
    throw new Error("Node children must be an array.");
  for (const node of children) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new Error("Every normalized node must be an object.");
    }
    if (typeof node.id !== "string" || !node.id) {
      throw new Error("Every normalized node must have a non-empty string ID.");
    }
    if (typeof node.type !== "string" || !node.type) {
      throw new Error(`Node ${node.id} must have a non-empty string type.`);
    }
    if (occupiedIds.has(node.id))
      throw new Error(`Duplicate node ID ${node.id}.`);
    occupiedIds.add(node.id);
    if (node.children !== undefined)
      validateNodeTree(node.children, occupiedIds);
  }
}

function assertNoLocalParentCycle(model, nodeId, parentId) {
  const visited = new Set();
  let currentId = parentId;
  while (currentId !== null && model.nodes.has(currentId)) {
    if (currentId === nodeId)
      throw new Error("A node cannot move beneath its own descendant.");
    if (visited.has(currentId)) return;
    visited.add(currentId);
    currentId = model.nodes.get(currentId).get("parentId");
  }
}

function cloneJson(value) {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value));
}

function toYValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return cloneJson(value);
  const map = new Y.Map();
  for (const [key, nested] of Object.entries(value))
    map.set(key, toYValue(nested));
  return map;
}

function fromYValue(value) {
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, nested]) => [key, fromYValue(nested)]),
    );
  }
  return cloneJson(value);
}

function createYText(content) {
  const text = new Y.Text();
  if (content) text.insert(0, content);
  return text;
}

function setRichTextMarks(properties, marks) {
  const text = properties.get("content");
  if (!(text instanceof Y.Text)) throw new Error("Rich-text marks require collaborative text content.");
  applyMarksToText(text, marks);
}

function applyMarksToText(text, marks) {
  if (text.length) {
    for (const key of richTextAttributeKeys(text)) text.format(0, text.length, { [key]: null });
  }
  for (const mark of marks) {
    const key = `canvas:${mark.type}`;
    text.format(mark.from, mark.to - mark.from, { [key]: cloneJson(mark.value) });
  }
}

function richTextAttributeKeys(text) {
  const keys = new Set();
  for (const delta of text.toDelta())
    for (const key of Object.keys(delta.attributes ?? {}))
      if (key.startsWith("canvas:")) keys.add(key);
  return keys;
}

function marksFromYText(text) {
  const open = new Map();
  const marks = [];
  let offset = 0;
  for (const delta of text.toDelta()) {
    const attributes = new Map(Object.entries(delta.attributes ?? {}).filter(([key]) => key.startsWith("canvas:")));
    for (const [key, current] of open) {
      if (!attributes.has(key) || !jsonValuesEqual(attributes.get(key), current.value)) {
        marks.push({ type: key.slice(7), from: current.from, to: offset, value: current.value });
        open.delete(key);
      }
    }
    for (const [key, value] of attributes) {
      if (!open.has(key)) open.set(key, { from: offset, value: cloneJson(value) });
    }
    offset += delta.insert.length;
  }
  for (const [key, current] of open)
    marks.push({ type: key.slice(7), from: current.from, to: offset, value: current.value });
  return marks.sort((a, b) => a.from - b.from || a.to - b.to || a.type.localeCompare(b.type));
}

function attributesForInsertion(text, index) {
  const attributes = {};
  for (const mark of marksFromYText(text)) {
    const atInterior = mark.from < index && index < mark.to;
    const atEnd = mark.to === index;
    const atStart = mark.from === index;
    const inclusive = mark.type !== "link" && mark.type !== "lang";
    if (atInterior || (inclusive && (atEnd || atStart)))
      attributes[`canvas:${mark.type}`] = cloneJson(mark.value);
  }
  return attributes;
}

function breakParentCycles(parentById) {
  for (const startId of [...parentById.keys()].sort()) {
    const path = [];
    const indexById = new Map();
    let currentId = startId;
    while (currentId !== null && parentById.has(currentId)) {
      const cycleIndex = indexById.get(currentId);
      if (cycleIndex !== undefined) {
        const cycle = path.slice(cycleIndex).sort();
        parentById.set(cycle[0], null);
        break;
      }
      indexById.set(currentId, path.length);
      path.push(currentId);
      currentId = parentById.get(currentId) ?? null;
    }
  }
}

function hasDeletedAncestor(nodes, nodeId) {
  const visited = new Set([nodeId]);
  let parentId = nodes.get(nodeId)?.get("parentId");
  while (parentId !== null && nodes.has(parentId)) {
    if (visited.has(parentId)) return false;
    visited.add(parentId);
    const parent = nodes.get(parentId);
    if (parent.get("deleted") === true) return true;
    parentId = parent.get("parentId");
  }
  return false;
}

function assertJsonValue(value, path = "$", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${path} must contain only finite JSON numbers.`);
    return;
  }
  if (typeof value !== "object") {
    throw new Error(
      `${path} contains a value that cannot be represented in JSON.`,
    );
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a JSON cycle.`);
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    const constructor = Object.getOwnPropertyDescriptor(
      prototype,
      "constructor",
    )?.value;
    const received =
      typeof constructor === "function" && constructor.name
        ? constructor.name
        : "an object with a custom prototype";
    throw new Error(
      `${path} received ${received}; JSON values allow only plain objects, arrays, strings, finite numbers, booleans, and null. Convert this property to plain JSON data and retry.`,
    );
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new Error(`${path} contains a non-string JSON object key.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
        throw new Error(`${path} contains a non-JSON array property.`);
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index))
        throw new Error(`${path} contains a sparse JSON array.`);
      assertJsonValue(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`${path}.${key} is not a plain JSON data property.`);
      }
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

export { Y };
