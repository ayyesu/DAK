import { prepareOpenPencilRenderDocument } from "./openpencil-render-document.mjs";
import { isCascade } from "./canvas-resolver.mjs";

export function reviewDocumentIssues(document) {
  return [
    ...prepareOpenPencilRenderDocument(document).issues,
    ...designValidationIssues(document),
  ];
}

export function designValidationIssues(document) {
  const issues = [];
  const definitions = new Map();
  const indexDefinitions = (nodes = []) => {
    for (const node of nodes) {
      if (!node) continue;
      if (node.id) definitions.set(node.id, node);
      indexDefinitions(node.children);
    }
  };
  indexDefinitions(document?.children);
  const visit = (nodes = [], parent = null, parentWidth = null) => {
    for (const node of nodes) {
      if (node?.type === "ref" && typeof node.ref === "string" && !node.ref.includes(":")) {
        const definition = definitions.get(node.ref);
        if (definition && node.props && typeof node.props === "object") {
          for (const name of Object.keys(node.props)) {
            if (Object.hasOwn(definition.properties ?? {}, name)) continue;
            issues.push({
              nodeId: node.id,
              kind: "component-property",
              severity: "major",
              message: `Instance supplies undeclared property ${name}; its value is ignored.`,
              suggestion: `Remove ${name} from this instance's props or restore it on component ${definition.id}.`,
            });
          }
        }
      }
      if (!node || node.enabled === false) continue;
      const availableWidth = parent?.layout === "vertical" && typeof parentWidth === "number"
        ? parentWidth - horizontalPadding(parent.padding)
        : null;
      const resolvedWidth = typeof node.width === "number" ? node.width
        : node.width === "fill_container" ? availableWidth : null;
      if (node.type === "ref" && node.width === undefined && typeof availableWidth === "number"
        && node.layoutPosition !== "absolute") {
        const definitionWidth = definitions.get(node.ref)?.width;
        if (typeof definitionWidth === "number" && definitionWidth > availableWidth + 0.5) {
          issues.push({
            nodeId: node.id,
            kind: "layout-capacity",
            message: `Component instance inherits ${definitionWidth}px width in a ${availableWidth}px vertical content area; set an explicit instance width.`,
          });
        }
      }
      if (!parent && (node.width === "fill_container" || node.height === "fill_container")) {
        issues.push({
          nodeId: node.id,
          kind: "layout-sizing",
          message: "A top-level node cannot fill a parent container; use a concrete or fit-content size.",
        });
      }
      if (node.type === "text") {
        const hasBoundContent = typeof node.bind?.content === "string" && node.bind.content.startsWith("$props.");
        if (!hasBoundContent && (typeof node.content !== "string" || node.content.length === 0)) {
          issues.push({ nodeId: node.id, kind: "text-content", message: "This text node has no visible content." });
        }
        const paragraphs = node.paragraphs?.length ? node.paragraphs : [{ style: node.style }];
        const stylesSupplyFill = paragraphs.every((paragraph) => {
          const styleName = paragraph.style ?? node.style;
          return styleName && hasVisibleFill(document.paragraphStyles?.[styleName]?.fill);
        });
        const hasBoundFill = typeof node.bind?.fill === "string" && node.bind.fill.startsWith("$props.");
        if (!hasVisibleFill(node.fill) && !stylesSupplyFill && !hasBoundFill) {
          issues.push({ nodeId: node.id, kind: "text-fill", message: "This text node has no enabled visible fill." });
        }
      }
      if (node.type === "frame" && node.layout === "horizontal" && typeof node.width === "number" && node.clip !== true) {
        const children = (node.children ?? []).filter((child) => child && child.enabled !== false && child.layoutPosition !== "absolute");
        const widths = children.map((child) => {
          const width = child.width ?? (child.type === "ref" ? definitions.get(child.ref)?.width : undefined);
          return typeof width === "number" ? width : null;
        });
        if (widths.every((width) => width !== null)) {
          const padding = horizontalPadding(node.padding);
          const required = widths.reduce((total, width) => total + width, 0)
            + Math.max(0, children.length - 1) * (node.gap ?? 0) + padding;
          if (required > node.width + 0.5) {
            issues.push({
              nodeId: node.id,
              kind: "layout-capacity",
              message: `Fixed-width children require ${required}px in a ${node.width}px horizontal frame.`,
            });
          }
        }
      }
      visit(node.children, node, resolvedWidth);
    }
  };
  visit(document?.children);
  return issues;
}

function horizontalPadding(padding) {
  if (typeof padding === "number") return padding * 2;
  if (!Array.isArray(padding)) return 0;
  if (padding.length === 2) return (padding[1] ?? 0) * 2;
  return (padding[1] ?? 0) + (padding[3] ?? 0);
}

function hasVisibleFill(fill) {
  // A conditional value list selects one paint value; it is not a list of
  // paint objects. Every authored branch must provide a visible text fill.
  if (isCascade(fill)) return fill.every((entry) => hasVisibleFill(entry.value));
  const fills = Array.isArray(fill) ? fill : [fill];
  return fills.some((candidate) => {
    if (typeof candidate === "string") return candidate.length > 0;
    return candidate && typeof candidate === "object" && candidate.enabled !== false
      && (typeof candidate.color === "string" || typeof candidate.fill === "string");
  });
}
