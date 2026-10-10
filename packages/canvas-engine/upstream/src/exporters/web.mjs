export function exportWeb(ir, options = {}) {
  const filenames = ir.outputs.map((output) => `${safeSlug(output.name)}.html`);
  if (new Set(filenames).size !== filenames.length) {
    const error = new Error("Route names collide in the generated HTML bundle.");
    error.code = "CANVAS_EXPORT_NAME_COLLISION";
    throw error;
  }
  const files = new Map();
  files.set("styles.css", baseCss(ir));
  for (const output of ir.outputs) {
    const filename = `${safeSlug(output.name)}.html`;
    files.set(filename, `<!doctype html>\n<html lang="${escape(ir.lang ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="styles.css"></head><body>${nodeTree(output, options)}</body></html>\n`);
  }
  return files;
}
function nodeTree(output, options) {
  const children = groupChildren(output.nodes);
  const root = output.root ?? { id: output.id, type: "frame", geometry: { x: 0, y: 0, w: output.width, h: output.height }, paint: {}, semantics: {}, layout: {}, variants: {} };
  const classes = ["canvas-output", root.layout.layout === "grid" ? "canvas-grid" : ["horizontal", "vertical"].includes(root.layout.layout) ? "canvas-flex" : ""].filter(Boolean).join(" ");
  const landmark = { nav: "nav", main: "main", header: "header", footer: "footer", aside: "aside", region: "section" }[root.semantics.landmark] ?? "main";
  return `<${landmark} id="${escape(output.id)}" class="${classes}" style="${nodeStyle(root, null)}"${root.semantics.description ? ` aria-label="${escape(root.semantics.description)}"` : ""}>${orderedChildren(root, children).map((node) => htmlNode(node, children, root, options)).join("")}</${landmark}>`;
}
function htmlNode(node, children, parent, options) {
  if (node.capability.verdict === "ignore") return "";
  if (node.capability.verdict === "raster") {
    const src = options.rasterHref?.(node.id);
    if (!src) throw new Error(`Web rasterizer is required for ${node.id}.`);
    return `<img id="${escape(node.id)}" class="node raster" src="${escape(src)}" alt="${escape(node.semantics.description ?? "")}" style="${nodeStyle(node, parent)}">`;
  }
  if (node.vector) {
    const fill = solid(node.paint.fill) ?? "none";
    const stroke = solid(node.paint.stroke?.fill ?? node.paint.stroke?.color) ?? "none";
    const strokeWidth = Number(node.paint.stroke?.width ?? node.paint.stroke?.thickness ?? 1);
    return `<svg id="${escape(node.id)}" class="node ${node.type}" viewBox="${node.vector.viewBox.join(" ")}" preserveAspectRatio="none" style="${nodeStyle(node, parent)}"${node.semantics.description ? ` aria-label="${escape(node.semantics.description)}" role="img"` : node.semantics.decorative ? ` aria-hidden="true"` : ""}><path d="${escape(node.vector.d)}" fill="${escape(fill)}" fill-rule="${node.vector.fillRule}" stroke="${escape(stroke)}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"/></svg>`;
  }
  const heading = node.type === "text" && node.semantics.paragraphs.find((p) => p.headingLevel)?.headingLevel;
  const tag = heading ? `h${heading}` : node.type === "text" ? "p" : "div";
  const content = node.type === "text"
    ? node.semantics.runs.map((run) => runHtml(run, node.semantics.content.slice(run.from, run.to))).join("")
    : orderedChildren(node, children).map((child) => htmlNode(child, children, node, options)).join("");
  const classes = ["node", node.type, node.layout.layout === "grid" ? "canvas-grid" : ["horizontal", "vertical"].includes(node.layout.layout) ? "canvas-flex" : ""].filter(Boolean).join(" ");
  return `<${tag} id="${escape(node.id)}" class="${classes}" style="${nodeStyle(node, parent)}"${node.semantics.description ? ` aria-label="${escape(node.semantics.description)}"` : node.semantics.decorative ? ` aria-hidden="true"` : ""}>${content}</${tag}>`;
}
function baseCss(ir) {
  const modeRules = Object.entries(ir.axes ?? {}).flatMap(([axis, definition]) =>
    (definition.modes ?? []).flatMap((mode) => {
      const declarations = variantRules(ir, axis, mode.name, mode.selector);
      if (!declarations) return [];
      const media = mode.media ?? (mode.minWidth !== undefined ? `(min-width: ${mode.minWidth}px)` : null);
      if (media) return [`@media ${normalizeMedia(media)}{${declarations}}`];
      if (mode.selector) return [declarations];
      return [];
    })).join("\n");
  return `*{box-sizing:border-box}body{margin:0}.canvas-output{position:relative;overflow:hidden}.node{min-width:0;margin:0}.canvas-grid{display:grid}.canvas-flex{display:flex}\n${modeRules}\n`;
}
function variantRules(ir, axis, mode, selector = "") {
  return ir.outputs.flatMap((output) => [output.root, ...output.nodes].filter(Boolean).flatMap((node) => Object.entries(node.variants ?? {}).flatMap(([property, cascade]) => {
    const entry = cascade.findLast((candidate) => candidate.when?.[axis] === mode);
    const css = entry ? cssProperty(property, entry.value) : null;
    return css ? [`#${cssEscape(node.id)}${selector ?? ""}{${css}}`] : [];
  }))).join("");
}
function normalizeMedia(value) { const text = String(value).trim(); return text.startsWith("(") ? text : `(${text})`; }
function nodeStyle(node, parent) {
  const parentFlows = parent && ["grid", "horizontal", "vertical"].includes(parent.layout.layout);
  const style = [];
  if (!parentFlows) style.push("position:absolute", `left:${node.geometry.localX ?? node.geometry.x}px`, `top:${node.geometry.localY ?? node.geometry.y}px`);
  style.push(`width:${node.geometry.w}px`, `height:${node.geometry.h}px`);
  const fill = solid(node.paint.fill);
  if (fill && !node.vector) style.push(`background:${fill}`);
  if (node.paint.stroke && !node.vector) style.push(`border:${Number(node.paint.stroke.width ?? node.paint.stroke.thickness ?? 1)}px solid ${solid(node.paint.stroke.fill ?? node.paint.stroke.color) ?? "#000"}`);
  if (node.type === "ellipse") style.push("border-radius:50%");
  else if (node.paint.cornerRadius != null) style.push(`border-radius:${Number(node.paint.cornerRadius)}px`);
  if (node.paint.opacity != null) style.push(`opacity:${node.paint.opacity}`);
  if (node.clip) style.push("overflow:hidden");
  if (node.layout.layout === "horizontal" || node.layout.layout === "vertical") style.push(`flex-direction:${node.layout.layout === "horizontal" ? "row" : "column"}`);
  if (node.layout.wrap) style.push("flex-wrap:wrap");
  if (node.layout.gap !== undefined) style.push(`gap:${node.layout.gap}px`);
  if (node.layout.rowGap !== undefined) style.push(`row-gap:${node.layout.rowGap}px`);
  if (node.layout.columnGap !== undefined) style.push(`column-gap:${node.layout.columnGap}px`);
  if (node.layout.gridTemplateColumns) style.push(`grid-template-columns:${tracks(node.layout.gridTemplateColumns)}`);
  if (node.layout.gridTemplateRows) style.push(`grid-template-rows:${tracks(node.layout.gridTemplateRows)}`);
  if (node.layout.gridColumn) style.push(`grid-column:${node.layout.gridColumn}`);
  if (node.layout.gridRow) style.push(`grid-row:${node.layout.gridRow}`);
  if (node.geometry.rotation) style.push(`transform:rotate(${node.geometry.rotation}deg)`);
  return style.join(";");
}
function solid(fill) { return typeof fill === "string" ? fill : fill?.color ?? null; }
function tracks(value) { return (Array.isArray(value) ? value : [value]).map((track) => typeof track === "number" ? `${track}px` : track).join(" "); }
function cssProperty(property, value) {
  const names = { fill: "background", gap: "gap", rowGap: "row-gap", columnGap: "column-gap", width: "width", height: "height", opacity: "opacity" };
  const name = names[property];
  if (!name) return null;
  return `${name}:${typeof value === "number" && ["gap", "rowGap", "columnGap", "width", "height"].includes(property) ? `${value}px` : value}!important`;
}
function runHtml(run, text) {
  const tag = run.link ? "a" : "span";
  const language = run.language ? ` lang="${escape(run.language)}"` : "";
  const href = run.link ? ` href="${escape(run.link)}"` : "";
  return `<${tag}${href}${language} style="${runStyle(run)}">${escape(text)}</${tag}>`;
}
function runStyle(run) {
  const decoration = [run.underline ? "underline" : null, run.strikethrough ? "line-through" : null].filter(Boolean).join(" ");
  return [
    `font-family:${run.fontFamily ?? "inherit"}`, `font-size:${run.fontSize ?? 16}px`,
    Number(run.weight ?? run.fontWeight) >= 600 ? "font-weight:700" : "",
    run.italic || run.fontStyle === "italic" ? "font-style:italic" : "",
    decoration ? `text-decoration:${decoration}` : "", run.fill ? `color:${run.fill}` : "",
    run.letterSpacing != null ? `letter-spacing:${Number(run.letterSpacing)}px` : "",
    run.wordSpacing != null ? `word-spacing:${Number(run.wordSpacing)}px` : "",
  ].filter(Boolean).join(";");
}
function groupChildren(nodes) { const map = new Map(); for (const node of nodes) { const list = map.get(node.parent) ?? []; list.push(node); map.set(node.parent, list); } return map; }
function orderedChildren(node, children) {
  return children.get(node.id) ?? [];
}
function safeSlug(value) { const slug = String(value).normalize("NFC").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""); if (!slug) throw new Error(`Frame name ${value} cannot produce a filename.`); return slug; }
function escape(value) { return String(value).replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function cssEscape(value) { return String(value).replace(/[^A-Za-z0-9_-]/gu, (char) => `\\${char.codePointAt(0).toString(16)} `); }
