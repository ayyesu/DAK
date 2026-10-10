import pptxgen from "pptxgenjs";
import { embedPresentationFonts, readOoxmlPackage, readXmlPart, writeOoxmlPackage, writeXmlPart } from "../ooxml-package.mjs";
import { drawingMlCommands, scaledVectorCommands } from "../vector-path.mjs";

export async function exportPptx(ir, options = {}) {
  const first = ir.outputs[0];
  if (!first) throw new Error("Deck export needs at least one output.");
  const physical = first.physical;
  if (!physical) throw new Error("PPTX slide physical size must be declared in the exporter IR.");
  const widthIn = physical.unit === "in" ? physical.w : physical.w / 25.4;
  const heightIn = physical.unit === "in" ? physical.h : physical.h / 25.4;
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "CANVAS", width: widthIn, height: heightIn });
  pptx.layout = "CANVAS";
  for (const output of ir.outputs) {
    if (output.width !== first.width || output.height !== first.height) throw new Error("PPTX requires uniform slide dimensions.");
    const slide = pptx.addSlide();
    const background = solidFill(output.root?.paint?.fill);
    if (background.transparency !== 100) slide.background = { color: background.color };
    for (const node of output.nodes) {
      await addNode(slide, node, output, widthIn, heightIn, options);
    }
    const notes = ir.notes?.filter((note) => note.notesFor === output.id).map((note) => note.content).join("\n");
    if (notes) slide.addNotes(notes);
  }
  const generated = new Uint8Array(await pptx.write({ outputType: "arraybuffer" }));
  return embedPresentationFonts(await injectNativeDrawingMl(generated, ir), options.fonts);
}

async function addNode(slide, node, output, widthIn, heightIn, options) {
  const x = node.geometry.x / output.width * widthIn;
  const y = node.geometry.y / output.height * heightIn;
  const w = node.geometry.w / output.width * widthIn;
  const h = node.geometry.h / output.height * heightIn;
  const common = { x, y, w, h, rotate: node.geometry.rotation, objectName: node.id, altText: node.semantics.description ?? undefined, shadow: shadowOptions(node.paint.effect) };
  if (node.capability.verdict === "ignore") return;
  if (node.capability.verdict === "raster") {
    if (!options.rasterize) throw new Error(`Rasterizer is required for ${node.id}.`);
    const image = await options.rasterize(node.id);
    slide.addImage({ ...common, data: image.data ?? image });
    return;
  }
  if (node.type === "text") {
    assertPptxFonts(node, options.fonts);
    if (node.semantics.paragraphs.some((paragraph) => paragraph.list)) {
      addParagraphText(slide, node, common);
      return;
    }
    const runs = pptxRuns(node);
    const firstParagraph = node.semantics.paragraphs[0];
    slide.addText(runs, { ...common, margin: 0, breakLine: false, valign: "top", paraSpaceAfterPt: 0, fit: "shrink", ...(firstParagraph?.list ? { bullet: bulletOptions(firstParagraph.list) } : {}) });
    return;
  }
  const fill = solidFill(node.paint.fill);
  const line = strokeOptions(node.paint.stroke);
  if (node.vector) {
    slide.addShape("rect", { ...common, fill, line, transparency: Math.round((1 - node.paint.opacity) * 100) });
    return;
  }
  const shape = node.type === "ellipse" ? "ellipse" : node.type === "line" ? "line" : Number(node.paint.cornerRadius ?? 0) > 0 ? "roundRect" : "rect";
  slide.addShape(shape, { ...common, fill, line, transparency: Math.round((1 - node.paint.opacity) * 100) });
}

function assertPptxFonts(node, fonts = []) {
  const available = new Set(fonts.map((font) => String(font.typeface).toLowerCase()));
  const missing = [...new Set(node.semantics.runs.map((run) => run.fontFamily ?? "Inter"))].filter((family) => !available.has(String(family).toLowerCase()));
  if (missing.length) {
    const error = new Error(`PPTX font bytes are unavailable for ${missing.join(", ")}; Canvas will not silently substitute a face.`);
    error.code = "CANVAS_EXPORT_FONT_BYTES_MISSING";
    throw error;
  }
}

function addParagraphText(slide, node, common) {
  const paragraphs = node.semantics.paragraphs;
  const heights = paragraphs.map((paragraph) => {
    const run = node.semantics.runs.find((item) => item.from <= paragraph.from && item.to >= Math.min(paragraph.to, paragraph.from + 1)) ?? {};
    const lines = Math.max(1, node.semantics.content.slice(paragraph.from, paragraph.to).split(/\r?\n/u).filter((line, index, all) => line || index < all.length - 1).length);
    return lines * Number(run.lineHeight ?? run.fontSize ?? 16) * 1.2;
  });
  const total = heights.reduce((sum, value) => sum + value, 0) || 1;
  let y = common.y;
  paragraphs.forEach((paragraph, index) => {
    const h = index === paragraphs.length - 1 ? common.y + common.h - y : common.h * heights[index] / total;
    const runs = node.semantics.runs.flatMap((run) => {
      const from = Math.max(run.from, paragraph.from); const to = Math.min(run.to, paragraph.to);
      if (to <= from) return [];
      return [{ text: node.semantics.content.slice(from, to).replace(/\r?\n$/u, ""), options: textRunOptions(run) }];
    });
    const options = { ...common, y, h, margin: 0, valign: "top", paraSpaceAfterPt: 0, fit: "shrink", ...(paragraph.align ? { align: paragraph.align === "start" ? "left" : paragraph.align === "end" ? "right" : paragraph.align } : {}), ...(paragraph.list ? { bullet: bulletOptions(paragraph.list) } : {}) };
    if (runs.length === 1) slide.addText(runs[0].text, { ...options, ...runs[0].options });
    else slide.addText(runs, options);
    y += h;
  });
}

function pptxRuns(node) {
  const boundaries = new Set([0, node.semantics.content.length]);
  for (const item of [...node.semantics.runs, ...node.semantics.paragraphs]) { boundaries.add(item.from); boundaries.add(item.to); }
  const points = [...boundaries].sort((a, b) => a - b);
  return points.slice(0, -1).flatMap((from, index) => {
    const to = points[index + 1]; if (to <= from) return [];
    const run = node.semantics.runs.find((item) => item.from <= from && item.to >= to) ?? {};
    const paragraph = node.semantics.paragraphs.find((item) => item.from <= from && item.to >= to) ?? {};
    const first = from === paragraph.from; const last = to === paragraph.to && to < node.semantics.content.length;
    const text = node.semantics.content.slice(from, to).replace(last ? /\r?\n$/u : /$^/u, "");
    return [{ text, options: { ...textRunOptions(run), ...(paragraph.align ? { align: paragraph.align === "start" ? "left" : paragraph.align === "end" ? "right" : paragraph.align } : {}), ...(first && paragraph.from > 0 && paragraph.list ? { bullet: bulletOptions(paragraph.list) } : {}), ...(last ? { breakLine: true } : {}) } }];
  });
}
function bulletOptions(list) {
  const indent = 18 + Number(list.level ?? 0) * 18;
  if (list.kind === "number") return { type: "number", numberType: list.numberType ?? "arabicPeriod", indent };
  return { characterCode: (list.character ?? "•").codePointAt(0).toString(16).toUpperCase(), indent };
}

function textRunOptions(run) {
  return { fontFace: run.fontFamily, fontSize: run.fontSize ? run.fontSize * 0.75 : undefined, bold: Number(run.weight ?? run.fontWeight) >= 600, italic: run.italic ?? run.fontStyle === "italic", underline: run.underline ? { style: "sng" } : undefined, strike: Boolean(run.strikethrough), color: colorHex(run.fill), charSpacing: run.letterSpacing ? run.letterSpacing * 0.75 : undefined, hyperlink: run.link ? { url: run.link } : undefined, lang: run.language };
}
function solidFill(fill) { const value = typeof fill === "string" ? fill : fill?.color; return value ? { color: colorHex(value) } : { color: "FFFFFF", transparency: 100 }; }
function strokeOptions(stroke) { if (!stroke) return { color: "FFFFFF", transparency: 100 }; return { color: colorHex(stroke.fill ?? stroke.color ?? "#000000"), width: Number(stroke.thickness ?? stroke.width ?? 1) * 0.75, dash: stroke.dashPattern ? "dash" : undefined, beginArrowType: stroke.cap === "arrow" ? "triangle" : undefined }; }
function shadowOptions(effects) {
  const effect = (Array.isArray(effects) ? effects : [effects]).find((item) => item?.type === "shadow");
  if (!effect) return undefined;
  const x = Number(effect.offset?.x ?? 0); const y = Number(effect.offset?.y ?? 0);
  const alpha = /^#[0-9a-f]{8}$/iu.test(effect.color ?? "") ? parseInt(effect.color.slice(7, 9), 16) / 255 : 1;
  return { type: effect.shadowType === "inner" ? "inner" : "outer", color: colorHex(effect.color ?? "#000000"), opacity: alpha, blur: Number(effect.blur ?? 0) * 0.75, angle: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360, offset: Math.hypot(x, y) * 0.75, rotateWithShape: false };
}
function colorHex(value) { return typeof value === "string" ? value.replace(/^#/u, "").slice(0, 6).toUpperCase() : undefined; }
async function injectNativeDrawingMl(bytes, ir) {
  const parts = readOoxmlPackage(bytes);
  for (const [index, output] of ir.outputs.entries()) {
    const path = `ppt/slides/slide${index + 1}.xml`;
    let xml = readXmlPart(parts, path);
    for (const node of output.nodes) {
      if (node.semantics.description) {
        const name = regexEscape(node.id);
        const nonVisual = new RegExp(`(<p:cNvPr\\b(?=[^>]*\\bname="${name}")(?:(?!\\bdescr=)[^>])*)(/?>)`, "u");
        xml = xml.replace(nonVisual, `$1 descr="${xmlAttribute(node.semantics.description)}"$2`);
      }
      const name = regexEscape(node.id);
      const pattern = new RegExp(`(<p:sp>(?:(?!<\\/p:sp>).)*?<p:cNvPr\\b[^>]*name="${name}"[^>]*>(?:(?!<\\/p:sp>).)*?<p:spPr>)([\\s\\S]*?)(<\\/p:spPr>[\\s\\S]*?<\\/p:sp>)`, "u");
      if (node.vector && node.capability.verdict === "native") {
        const geometry = await customGeometryXml(node.vector);
        xml = xml.replace(pattern, (whole, before, properties, after) => `${before}${properties.replace(/<a:prstGeom\b[\s\S]*?<\/a:prstGeom>/u, geometry)}${after}`);
      }
      const fill = (Array.isArray(node.paint.fill) ? node.paint.fill : [node.paint.fill]).find((item) => item?.type === "gradient" && ["linear", "radial"].includes(item.gradientType ?? "linear"));
      if (fill && node.capability.verdict === "native") xml = xml.replace(pattern, (whole, before, properties, after) => `${before}${properties.replace(/<a:(?:solidFill|gradFill)\b[\s\S]*?<\/a:(?:solidFill|gradFill)>|<a:noFill\/>/u, gradientXml(fill))}${after}`);
    }
    writeXmlPart(parts, path, xml);
  }
  return writeOoxmlPackage(parts);
}
async function customGeometryXml(vector) {
  const encode = (commands) => commands.map((command) => {
    if (command.type === "move") return `<a:moveTo><a:pt x="${coord(command.x)}" y="${coord(command.y)}"/></a:moveTo>`;
    if (command.type === "line") return `<a:lnTo><a:pt x="${coord(command.x)}" y="${coord(command.y)}"/></a:lnTo>`;
    if (command.type === "cubic") return `<a:cubicBezTo><a:pt x="${coord(command.c1x)}" y="${coord(command.c1y)}"/><a:pt x="${coord(command.c2x)}" y="${coord(command.c2y)}"/><a:pt x="${coord(command.x)}" y="${coord(command.y)}"/></a:cubicBezTo>`;
    return "<a:close/>";
  }).join("");
  const body = encode(await drawingMlCommands(vector));
  // Fill topology may change during either fill-rule lowering; stroke authored
  // contours separately so intersections and open ends retain their appearance.
  const paths = `<a:path w="100000" h="100000" stroke="0">${body}</a:path><a:path w="100000" h="100000" fill="none">${encode(scaledVectorCommands(vector, 100000, 100000))}</a:path>`;
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst>${paths}</a:pathLst></a:custGeom>`;
}
function coord(value) { return Math.round(Math.max(-2147483648, Math.min(2147483647, value))); }
function gradientXml(fill) {
  const stops = (fill.colors ?? []).map((stop) => `<a:gs pos="${Math.round(Number(stop.position) * 100000)}">${drawingColor(stop.color)}</a:gs>`).join("");
  const geometry = (fill.gradientType ?? "linear") === "radial" ? `<a:path path="circle"><a:fillToRect l="0" t="0" r="0" b="0"/></a:path>` : `<a:lin ang="${Math.round(((Number(fill.rotation ?? 0) % 360 + 360) % 360) * 60000)}" scaled="1"/>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${geometry}</a:gradFill>`;
}
function drawingColor(value) { const raw = String(value ?? "#000000").replace(/^#/u, ""); const rgb = raw.slice(0, 6).padEnd(6, "0"); const alpha = raw.length >= 8 ? `<a:alpha val="${Math.round(parseInt(raw.slice(6, 8), 16) / 255 * 100000)}"/>` : ""; return `<a:srgbClr val="${rgb.toUpperCase()}">${alpha}</a:srgbClr>`; }
function xmlAttribute(value) { return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]); }
function regexEscape(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
