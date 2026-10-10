export function exportSvg(ir, output, options = {}) {
  const children = output.nodes.map((node) => svgNode(node, options)).join("\n");
  const semantics = output.root?.semantics ?? {};
  const access = semantics.decorative ? ` aria-hidden="true"` : semantics.description ? ` aria-label="${esc(semantics.description)}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${output.width}" height="${output.height}" viewBox="0 0 ${output.width} ${output.height}" role="img" lang="${esc(ir.lang ?? "en")}"${access}>\n${children}\n</svg>\n`;
}
function svgNode(node, options) {
  const { x, y, w, h, rotation } = node.geometry;
  const transform = rotation ? ` transform="rotate(${rotation} ${x + w / 2} ${y + h / 2})"` : "";
  const access = node.semantics.decorative ? ` aria-hidden="true"` : node.semantics.description ? ` aria-label="${esc(node.semantics.description)}"` : "";
  const opacity = Number(node.paint.opacity ?? 1);
  if (node.capability.verdict === "ignore") return "";
  if (node.capability.verdict === "raster") {
    const href = options.rasterHref?.(node.id);
    if (!href) throw new Error(`SVG rasterizer is required for ${node.id}.`);
    return `<image id="${esc(node.id)}" x="${x}" y="${y}" width="${w}" height="${h}" href="${esc(href)}" opacity="${opacity}"${transform}${access}/>`;
  }
  if (node.type === "text") return `<text id="${esc(node.id)}" x="${x}" y="${y + (node.semantics.runs[0]?.fontSize ?? 16)}" opacity="${opacity}"${transform}${access}>${node.semantics.runs.map((run) => `<tspan font-family="${esc(run.fontFamily ?? "sans-serif")}" font-size="${run.fontSize ?? 16}" font-weight="${run.weight ?? run.fontWeight ?? 400}"${run.italic || run.fontStyle === "italic" ? ` font-style="italic"` : ""}${run.underline || run.strikethrough ? ` text-decoration="${[run.underline ? "underline" : null, run.strikethrough ? "line-through" : null].filter(Boolean).join(" ")}"` : ""}${run.letterSpacing != null ? ` letter-spacing="${Number(run.letterSpacing)}"` : ""}${run.wordSpacing != null ? ` word-spacing="${Number(run.wordSpacing)}"` : ""}${run.language ? ` lang="${esc(run.language)}"` : ""} fill="${esc(color(run.fill) ?? "#000")}">${esc(node.semantics.content.slice(run.from, run.to))}</tspan>`).join("")}</text>`;
  const fill = color(node.paint.fill) ?? "none"; const stroke = color(node.paint.stroke?.fill ?? node.paint.stroke?.color) ?? "none";
  const strokeWidth = Number(node.paint.stroke?.width ?? node.paint.stroke?.thickness ?? 1);
  if (node.vector) {
    const [vx, vy, vw, vh] = node.vector.viewBox;
    const vectorTransform = `translate(${x} ${y}) scale(${w / vw} ${h / vh}) translate(${-vx} ${-vy})`;
    const combined = rotation ? `rotate(${rotation} ${x + w / 2} ${y + h / 2}) ${vectorTransform}` : vectorTransform;
    return `<path id="${esc(node.id)}" d="${esc(node.vector.d)}" fill="${fill}" fill-rule="${node.vector.fillRule}" stroke="${stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke" opacity="${opacity}" transform="${combined}"${access}/>`;
  }
  if (node.type === "ellipse") return `<ellipse id="${esc(node.id)}" cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"${transform}${access}/>`;
  if (node.type === "line") return `<line id="${esc(node.id)}" x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"${transform}${access}/>`;
  const radius = Number(node.paint.cornerRadius ?? 0);
  return `<rect id="${esc(node.id)}" x="${x}" y="${y}" width="${w}" height="${h}"${radius ? ` rx="${radius}" ry="${radius}"` : ""} fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"${transform}${access}/>`;
}
function color(value) { return typeof value === "string" ? value : value?.color; }
function esc(value) { return String(value).replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
