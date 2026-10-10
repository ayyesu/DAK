import fontkit from "@pdf-lib/fontkit";
import { createHash } from "node:crypto";
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFOperator, PDFString, appendBezierCurve, beginText, endText, closePath, lineTo, moveTo, popGraphicsState, pushGraphicsState, rgb, scale, setFillingColor, setFontAndSize, setTextMatrix, showText, setGraphicsState, setLineWidth, setStrokingColor, translate } from "pdf-lib";
import { scaledVectorCommands } from "../vector-path.mjs";
import { parseCssColor } from "../canvas-theme.mjs";
const fontPrograms = new WeakMap();

export async function exportPdf(ir, options = {}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(options.title ?? "Canvas export");
  if (options.profile === "PDF/A-3") addPdfa3Metadata(pdf, options.title ?? "Canvas export");
  if (options.profile === "PDF/UA-1") addPdfuaMetadata(pdf, options.title ?? "Canvas export", ir.lang ?? "en");
  if (options.profile === "PDF/X-4") {
    const error = new Error(`${options.profile} export is blocked until the Canvas standards-based preflight covers and verifies its emitted structure.`);
    error.code = "CANVAS_PDF_PROFILE_UNVERIFIED";
    throw error;
  }
  if (options.outputIntent) addSrgbOutputIntent(pdf, options.outputIntent, options.profile);
  const fonts = await embedFonts(pdf, options.fonts ?? {});
  const tagging = options.profile === "PDF/UA-1" ? createTagging(pdf) : null;
  for (const output of ir.outputs) {
    const physical = output.physical;
    const trimWidth = physical ? toPoints(physical.w, physical.unit) : output.width;
    const trimHeight = physical ? toPoints(physical.h, physical.unit) : output.height;
    if (![trimWidth, trimHeight].every((value) => Number.isFinite(value) && value > 0)) throw profileError(`PDF page ${output.id} must have finite positive dimensions.`);
    const bleed = Number(output.bleed ?? 0);
    if (!Number.isFinite(bleed) || bleed < 0) throw profileError(`PDF page ${output.id} has invalid point bleed.`);
    const mediaWidth = trimWidth + bleed * 2;
    const mediaHeight = trimHeight + bleed * 2;
    const page = pdf.addPage([mediaWidth, mediaHeight]);
    page.node.set(PDFName.of("CropBox"), pdf.context.obj([0, 0, mediaWidth, mediaHeight]));
    page.node.set(PDFName.of("BleedBox"), pdf.context.obj([0, 0, mediaWidth, mediaHeight]));
    page.node.set(PDFName.of("TrimBox"), pdf.context.obj([bleed, bleed, bleed + trimWidth, bleed + trimHeight]));
    if (output.root?.paint && (color(output.root.paint.fill) || output.root.paint.stroke)) {
      // Page background/outline is paint, not another accessibility element.
      const background = { ...output.root, semantics: { ...output.root.semantics, decorative: true } };
      const tag = tagging?.begin(page, background);
      await drawNode(pdf, page, background, output, fonts, options, { bleed, trimWidth, trimHeight });
      tagging?.end(page, tag);
    }
    for (const node of output.nodes) {
      if (node.capability.verdict === "ignore") continue;
      if (node.capability.verdict === "native" && node.type !== "text" && !color(node.paint.fill) && !color(node.paint.stroke?.fill ?? node.paint.stroke?.color) && !imageFill(node.paint.fill)) continue;
      const tag = tagging?.begin(page, node);
      await drawNode(pdf, page, node, output, fonts, options, { bleed, trimWidth, trimHeight });
      tagging?.end(page, tag);
    }
  }
  tagging?.finish();
  await pdf.flush();
  // Shaping can use ligatures/contextual glyphs that have no direct cmap entry.
  // Full embedded programs retain their glyph IDs; declare their actual widths.
  for (const font of fonts.values()) {
    const program = fontPrograms.get(font);
    if (!program.used.size) continue;
    const descendant = pdf.context.lookup(font.ref).lookup(PDFName.of("DescendantFonts")).lookup(0);
    const widths = descendant.lookup(PDFName.of("W"));
    for (const id of program.used) {
      if (program.mapped.has(id)) continue;
      widths.push(PDFNumber.of(id));
      widths.push(pdf.context.obj([program.font.getGlyph(id).advanceWidth * 1000 / program.font.unitsPerEm]));
    }
  }
  return new Uint8Array(await pdf.save());
}

async function drawNode(pdf, page, node, output, fonts, options, pageGeometry) {
  if (node.capability.verdict === "ignore") return;
  const sx = pageGeometry.trimWidth / output.width;
  const sy = pageGeometry.trimHeight / output.height;
  const x = pageGeometry.bleed + node.geometry.x * sx;
  const y = pageGeometry.bleed + pageGeometry.trimHeight - (node.geometry.y + node.geometry.h) * sy;
  const width = node.geometry.w * sx;
  const height = node.geometry.h * sy;
  if (node.capability.verdict === "raster" || imageFill(node.paint.fill)) {
    if (!options.rasterizeNode) throw new Error(`PDF rasterizer is required for ${node.id}.`);
    const rendered = await options.rasterizeNode(node.id, 300);
    const image = await pdf.embedPng(rendered.bytes ?? rendered);
    page.drawImage(image, { x, y, width, height });
    return;
  }
  if (node.type === "text") {
    if (node.textLayout) drawShapedText(pdf, page, node, { x, y, width, height, sx, sy }, fonts);
    else drawText(page, node, { x, y, width, height, textScale: sy }, fonts);
    return;
  }
  const fill = color(node.paint.fill);
  const stroke = color(node.paint.stroke?.fill ?? node.paint.stroke?.color);
  const opacity = Number(node.paint.opacity ?? 1);
  if (!fill && !stroke) return;
  const fillOpacity = opacity * colorAlpha(fill);
  const borderOpacity = opacity * colorAlpha(stroke);
  const borderWidth = Number(node.paint.stroke?.width ?? node.paint.stroke?.thickness ?? 1) * sx;
  const common = { x, y, width, height, opacity: fillOpacity, borderOpacity, ...(fill ? { color: pdfColor(fill) } : {}), ...(stroke ? { borderColor: pdfColor(stroke), borderWidth } : {}) };
  if (node.vector) drawVector(pdf, page, node, { x, y, width, height, fill, stroke, borderWidth, fillOpacity, borderOpacity });
  else if (node.type === "ellipse") page.drawEllipse({ x: x + width / 2, y: y + height / 2, xScale: width / 2, yScale: height / 2, opacity: fillOpacity, borderOpacity, ...(fill ? { color: pdfColor(fill) } : {}), ...(stroke ? { borderColor: pdfColor(stroke), borderWidth } : {}) });
  else if (node.type === "line") { if (stroke) page.drawLine({ start: { x, y: y + height }, end: { x: x + width, y }, color: pdfColor(stroke), opacity: borderOpacity, thickness: borderWidth }); }
  else page.drawRectangle(common);
}

function drawVector(pdf, page, node, box) {
  const commands = scaledVectorCommands(node.vector, box.width, box.height);
  const operators = [pushGraphicsState(), translate(box.x, box.y + box.height), scale(1, -1)];
  const graphicsState = page.node.newExtGState("GS", pdf.context.obj({ Type: "ExtGState", ca: box.fillOpacity, CA: box.borderOpacity }));
  operators.push(setGraphicsState(graphicsState));
  if (box.fill) operators.push(setFillingColor(pdfColor(box.fill)));
  if (box.stroke) operators.push(setStrokingColor(pdfColor(box.stroke)), setLineWidth(box.borderWidth));
  for (const command of commands) {
    if (command.type === "move") operators.push(moveTo(command.x, command.y));
    else if (command.type === "line") operators.push(lineTo(command.x, command.y));
    else if (command.type === "cubic") operators.push(appendBezierCurve(command.c1x, command.c1y, command.c2x, command.c2y, command.x, command.y));
    else operators.push(closePath());
  }
  operators.push(PDFOperator.of(box.fill && box.stroke ? (node.vector.fillRule === "evenodd" ? "B*" : "B") : box.fill ? (node.vector.fillRule === "evenodd" ? "f*" : "f") : box.stroke ? "S" : "n"), popGraphicsState());
  page.pushOperators(...operators);
}

function drawShapedText(pdf, page, node, box, fonts) {
  const byteToCharacter = new Map();
  let byteOffset = 0, characterOffset = 0;
  for (const character of node.semantics.content) {
    byteToCharacter.set(byteOffset, characterOffset);
    byteOffset += new TextEncoder().encode(character).length;
    characterOffset += character.length;
  }
  const operators = [pushGraphicsState(), PDFOperator.of("BDC", [PDFName.of("Span"), pdf.context.obj({ ActualText: PDFHexString.fromText(node.semantics.content) })])];
  const keys = new Map();
  const alphaStates = new Map();
  for (const line of node.textLayout.lines) for (const shaped of line.runs) {
    if (shaped.fakeBold || shaped.fakeItalic) throw profileError(`PDF text ${node.id} requires a real font face, not synthetic styling.`);
    for (let index = 0; index < shaped.glyphs.length; index++) {
      const offset = byteToCharacter.get(shaped.offsets[index]);
      const run = node.semantics.runs.find((candidate) => offset >= candidate.from && offset < candidate.to);
      if (!run) throw profileError(`PDF text ${node.id} has an unmapped shaped character.`);
      const font = fonts.get(`${run.fontFamily ?? "Inter"}:${Number(run.weight ?? run.fontWeight ?? 400)}`);
      if (!font) throw profileError(`PDF text ${node.id} has no exact embeddable font face.`);
      const program = fontPrograms.get(font);
      const weight = Number(run.weight ?? run.fontWeight ?? 400);
      const style = { 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold" }[weight];
      if (node.textLayout.fontHashes[`${run.fontFamily ?? "Inter"}|${style}`] !== program.hash) {
        const error = profileError(`PDF text ${node.id} was shaped with different font bytes from its embedded face.`);
        error.code = "CANVAS_PDF_FONT_MISMATCH";
        throw error;
      }
      const glyph = shaped.glyphs[index];
      if (!glyph || glyph >= program.font.numGlyphs || !program.font.hasGlyphForCodePoint(node.semantics.content.codePointAt(offset))) {
        const error = profileError(`PDF text ${node.id} requires a missing or fallback glyph.`);
        error.code = "CANVAS_PDF_GLYPH_MISSING";
        throw error;
      }
      program.used.add(glyph);
      if (!keys.has(font)) keys.set(font, page.node.newFontDictionary(font.name, font.ref));
      const fill = color(run.fill) ?? "#000000";
      const alpha = Number(node.paint.opacity ?? 1) * colorAlpha(fill);
      if (!alphaStates.has(alpha)) alphaStates.set(alpha, page.node.newExtGState("GS", pdf.context.obj({ ca: alpha })));
      const gs = alphaStates.get(alpha);
      operators.push(setGraphicsState(gs), setFillingColor(pdfColor(fill)), beginText(), setFontAndSize(keys.get(font), shaped.size),
        setTextMatrix(box.sx, 0, 0, box.sy, box.x + shaped.positions[index * 2] * box.sx,
          box.y + box.height - (shaped.positions[index * 2 + 1] + node.textLayout.offsetY) * box.sy),
        showText(PDFHexString.of(glyph.toString(16).padStart(4, "0"))), endText());
    }
  }
  operators.push(PDFOperator.of("EMC"), popGraphicsState());
  page.pushOperators(...operators);
}

function drawText(page, node, box, fonts) {
  let cursorX = box.x;
  let baseline = box.y + box.height;
  for (const run of node.semantics.runs) {
    const text = node.semantics.content.slice(run.from, run.to);
    const font = selectFont(fonts, run);
    if (!font) throw new Error(`No embeddable PDF font is available for ${run.fontFamily ?? "the text run"}.`);
    const size = Number(run.fontSize ?? 16) * box.textScale;
    const pieces = text.split("\n");
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece) {
        const encoded = font.encodeText(piece).asBytes();
        for (let index = 0; index < encoded.length; index += 2) if (encoded[index] === 0 && encoded[index + 1] === 0) {
          const error = profileError(`PDF font has no glyph for part of text node ${node.id}.`);
          error.code = "CANVAS_PDF_GLYPH_MISSING";
          throw error;
        }
        const fill = color(run.fill) ?? "#000000";
        page.drawText(piece, { x: cursorX, y: baseline - size, size, font, color: pdfColor(fill), opacity: Number(node.paint.opacity ?? 1) * colorAlpha(fill) });
        cursorX += font.widthOfTextAtSize(piece, size);
      }
      if (index < pieces.length - 1) { cursorX = box.x; baseline -= Number(run.lineHeight ?? run.fontSize ?? 16) * box.textScale; }
    }
  }
}

async function embedFonts(pdf, sources) {
  const result = new Map();
  // pdf-lib/fontkit's subset output preserves extraction but has rendered with
  // missing glyphs in Poppler for the shipped Inter fixtures. A full embed is
  // deterministic across the conformance and raster QA runners.
  for (const [key, bytes] of Object.entries(sources)) {
    const embedded = await pdf.embedFont(bytes, { subset: false });
    const font = fontkit.create(bytes);
    fontPrograms.set(embedded, { font, hash: createHash("sha256").update(bytes).digest("hex"), used: new Set(), mapped: new Set(font.characterSet.map((point) => font.glyphForCodePoint(point).id)) });
    result.set(key, embedded);
  }
  return result;
}
function selectFont(fonts, run) {
  const family = run.fontFamily ?? "Inter";
  const weight = Number(run.weight ?? run.fontWeight ?? 400);
  return fonts.get(`${family}:${weight >= 700 ? 700 : weight >= 600 ? 600 : weight >= 500 ? 500 : 400}`) ?? fonts.get(`${family}:400`);
}
function imageFill(fill) { return (Array.isArray(fill) ? fill : [fill]).some((item) => item?.type === "image" || typeof item?.url === "string"); }
function color(value) { return typeof value === "string" ? value : value?.color; }
function colorChannels(value) {
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(value);
  if (match) {
    const hex = match[1].length <= 4 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
    return { r: parseInt(hex.slice(0, 2), 16) / 255, g: parseInt(hex.slice(2, 4), 16) / 255, b: parseInt(hex.slice(4, 6), 16) / 255, a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1 };
  }
  const css = parseCssColor(value);
  if (css && Object.values(css).every((channel) => channel >= 0 && channel <= 1)) return css;
  throw profileError("PDF solid colour cannot be resolved without changing its appearance.");
}
function pdfColor(value) { const { r, g, b } = colorChannels(value); return rgb(r, g, b); }
function colorAlpha(value) { return value ? colorChannels(value).a : 1; }
function toPoints(value, unit) { if (unit === "in") return value * 72; if (unit === "mm") return value / 25.4 * 72; return value * 0.75; }

function addSrgbOutputIntent(pdf, profileBytes, profile) {
  const stream = pdf.context.flateStream(profileBytes, { N: PDFNumber.of(3), Alternate: PDFName.of("DeviceRGB") });
  const streamRef = pdf.context.register(stream);
  const intent = pdf.context.obj({ Type: "OutputIntent", S: profile === "PDF/X-4" ? "GTS_PDFX" : "GTS_PDFA1", OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"), RegistryName: PDFString.of("https://www.color.org"), Info: PDFString.of("ICC sRGB2014"), DestOutputProfile: streamRef });
  pdf.catalog.set(PDFName.of("OutputIntents"), pdf.context.obj([intent]));
}

function addPdfa3Metadata(pdf, title) {
  const now = new Date().toISOString();
  const id = PDFHexString.fromText(`canvas:${title}:${now}`);
  pdf.context.trailerInfo.ID = pdf.context.obj([id, id]);
  const xml = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" pdfaid:part="3" pdfaid:conformance="B" xmp:CreateDate="${now}" xmp:ModifyDate="${now}"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(title)}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
  const stream = pdf.context.stream(new TextEncoder().encode(xml), { Type: PDFName.of("Metadata"), Subtype: PDFName.of("XML") });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(stream));
}
function addPdfuaMetadata(pdf, title, language) {
  const now = new Date().toISOString();
  const id = PDFHexString.fromText(`canvas:${title}:${now}`);
  pdf.context.trailerInfo.ID = pdf.context.obj([id, id]);
  pdf.catalog.set(PDFName.of("Lang"), PDFString.of(language));
  pdf.catalog.set(PDFName.of("MarkInfo"), pdf.context.obj({ Marked: true }));
  pdf.catalog.set(PDFName.of("ViewerPreferences"), pdf.context.obj({ DisplayDocTitle: true }));
  const xml = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" pdfuaid:part="1" xmp:CreateDate="${now}" xmp:ModifyDate="${now}"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(title)}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
  const stream = pdf.context.stream(new TextEncoder().encode(xml), { Type: PDFName.of("Metadata"), Subtype: PDFName.of("XML") });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(stream));
}

function createTagging(pdf) {
  const root = pdf.context.obj({ Type: "StructTreeRoot", K: [] });
  const rootRef = pdf.context.register(root);
  const children = [];
  const parentTree = [];
  pdf.catalog.set(PDFName.of("StructTreeRoot"), rootRef);
  return {
    begin(page, node) {
      if (node.semantics.decorative) { page.pushOperators(PDFOperator.of("BMC", [PDFName.of("Artifact")])); return { artifact: true }; }
      if (node.type !== "text" && !node.semantics.description) throw profileError(`PDF/UA-1 node ${node.id} requires description or decorative: true.`);
      let pageEntry = parentTree.find((entry) => entry.page === page);
      if (!pageEntry) {
        pageEntry = { page, index: parentTree.length, refs: [] };
        parentTree.push(pageEntry);
        page.node.set(PDFName.of("StructParents"), PDFNumber.of(pageEntry.index));
      }
      const mcid = pageEntry.refs.length;
      const heading = node.semantics.paragraphs?.find((paragraph) => paragraph.headingLevel)?.headingLevel;
      const type = node.type === "text" ? (heading ? `H${heading}` : "P") : "Figure";
      const element = pdf.context.obj({ Type: "StructElem", S: type, P: rootRef, Pg: page.ref, K: mcid, ...(node.semantics.description ? { Alt: PDFString.of(node.semantics.description) } : {}), ...(node.semantics.language ? { Lang: PDFString.of(node.semantics.language) } : {}) });
      const reference = pdf.context.register(element);
      pageEntry.refs.push(reference); children.push(reference);
      page.pushOperators(PDFOperator.of("BDC", [PDFName.of(type), pdf.context.obj({ MCID: mcid })]));
      return { artifact: false };
    },
    end(page, tag) { if (tag) page.pushOperators(PDFOperator.of("EMC")); },
    finish() {
      const nums = [];
      for (const entry of parentTree) nums.push(entry.index, pdf.context.obj(entry.refs));
      const parentTreeRef = pdf.context.register(pdf.context.obj({ Nums: nums }));
      root.set(PDFName.of("K"), pdf.context.obj(children));
      root.set(PDFName.of("ParentTree"), parentTreeRef);
      root.set(PDFName.of("ParentTreeNextKey"), PDFNumber.of(parentTree.length));
    },
  };
}

function profileError(message) { const error = new Error(message); error.code = "CANVAS_PDF_PROFILE_INVALID"; return error; }
function xmlEscape(value) { return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]); }
