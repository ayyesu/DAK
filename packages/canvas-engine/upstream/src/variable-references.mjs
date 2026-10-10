// Canvas interpolation syntax is distinct from DTCG's {path} aliases.
// Dots separate path segments; hyphens remain valid within a segment.
const referenceSource = String.raw`\$\{([A-Za-z][\w-]*(?:\.[\w-]+)*)\}`;
const legacyReference = /^\$([A-Za-z][\w-]*(?:\.[\w-]+)*)$/u;

export function variableReferences(content) {
  return [...content.matchAll(new RegExp(referenceSource, "gu"))];
}

export function resolveVariableReferences(value, lookup, knownLegacyName = () => false) {
  if (typeof value === "string") {
    const references = variableReferences(value);
    if (references.length === 1 && references[0][0] === value) {
      return structuredClone(lookup(references[0][1]));
    }
    const legacy = legacyReference.exec(value);
    if (legacy && knownLegacyName(legacy[1])) return structuredClone(lookup(legacy[1]));
    return value.replace(new RegExp(referenceSource, "gu"), (_, name) => String(lookup(name)));
  }
  if (Array.isArray(value)) return value.map((item) => resolveVariableReferences(item, lookup, knownLegacyName));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveVariableReferences(nested, lookup, knownLegacyName)]));
  }
  return value;
}
