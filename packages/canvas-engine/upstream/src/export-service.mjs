import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { buildExporterIR, buildExtractionIR } from "./exporter-ir.mjs";
import { validateOutputSegment, writeExclusiveBundle, writeAtomicFile } from "./export-bundle.mjs";
import { exportPptx } from "./exporters/pptx.mjs";
import { exportPdf } from "./exporters/pdf.mjs";
import { exportWeb } from "./exporters/web.mjs";
import { exportCompose, exportSwiftUI } from "./exporters/mobile.mjs";
import { exportSvg } from "./exporters/svg.mjs";
import { measureDocumentText, takeDocumentScreenshots } from "./document-screenshot.mjs";
import { resolveCanvasDocument } from "./canvas-resolver.mjs";
import { ensurePencilDocumentIconCatalogs } from "./pencil-icon-provider.mjs";

export async function exportDocument(document, request, options = {}) {
  await ensureDocumentAndImportedIcons(document, request.imports);
  const measuredDocument = resolveCanvasDocument(document, {
    modes: request.modes,
    bindings: request.bindings,
    imports: request.imports,
  }).document;
  const preparedText = await measureDocumentText(measuredDocument, request.frames, options.assets);
  const ir = buildExporterIR(document, { ...request, preparedText });
  const rasterById = new Map(ir.rasters.map((raster) => [raster.id, raster]));
  const screenshot = async (nodeId) => {
    const raster = rasterById.get(nodeId);
    const variant = raster?.variants?.at(-1);
    if (!variant) throw new Error(`Raster policy is missing for ${nodeId}.`);
    const image = (await takeDocumentScreenshots(ir.renderDocument, [{ nodeIds: [nodeId], bounds: raster.renderBounds }], options.assets, { scale: variant.scale, maxDimension: 8192, failOnDownscale: true }))[0];
    if (image.width !== variant.pixelWidth || image.height !== variant.pixelHeight) {
      const error = new Error(`Raster ${nodeId} rendered ${image.width}×${image.height}, expected ${variant.pixelWidth}×${variant.pixelHeight}.`);
      error.code = "CANVAS_RASTER_DIMENSION_MISMATCH";
      throw error;
    }
    return image;
  };
  let artifact;
  if (request.role === "slide") artifact = await exportPptx(ir, { fonts: await readBundledPptxFonts(), rasterize: async (id) => ({ data: `data:image/png;base64,${(await screenshot(id)).data}` }) });
  else if (request.role === "route") {
    const hrefs = new Map(ir.rasters.map((raster) => [raster.id, `assets/${validateOutputSegment(raster.id)}.png`]));
    artifact = exportWeb(ir, { rasterHref: (id) => hrefs.get(id) });
    for (const [id, href] of hrefs) artifact.set(href, Buffer.from((await screenshot(id)).data, "base64"));
  }
  else if (request.role === "ios" || request.role === "android") {
    const rasters = new Map();
    for (const raster of ir.rasters) rasters.set(raster.id, (await screenshot(raster.id)).data);
    const fonts = { ...await readBundledPdfFonts(), "Inter:800": await readBundledFontResource("Inter-ExtraBold.ttf") };
    artifact = request.role === "ios"
      ? exportSwiftUI(ir, { fonts, rasterData: (id) => rasters.get(id) })
      : exportCompose(ir, { fonts, rasterData: (id) => rasters.get(id) });
    if ([...artifact.keys()].some((path) => path.endsWith(".ttf"))) artifact.set("licenses/Inter-OFL.txt", await readBundledFontResource("Inter-OFL.txt"));
  }
  else throw new Error(`Unsupported role ${request.role}.`);
  if (artifact instanceof Map) {
    artifact.set("export-report.json", JSON.stringify(report(ir, request.destination, request.role), null, 2));
    await writeExclusiveBundle(request.destination, artifact);
  } else await writeAtomicFile(request.destination, artifact);
  return report(ir, request.destination, request.role);
}

function validateExtractionRequest(request) {
  if (!["png", "svg", "pdf"].includes(request.format)) throw new Error("Extraction format must be png, svg or pdf.");
  if (request.profile !== undefined && (request.format !== "pdf" || request.profile !== "PDF/X-4")) {
    const error = new Error("The extraction profile must be PDF/X-4 and is only valid for PDF.");
    error.code = "CANVAS_PDF_PROFILE_UNKNOWN";
    throw error;
  }
  if (request.scale !== undefined && request.format !== "png") {
    const error = new Error("Only PNG extraction accepts a raster scale.");
    error.code = "CANVAS_EXTRACT_SCALE_UNSUPPORTED";
    throw error;
  }
}

export async function extractDocumentNodes(document, request, options = {}) {
  await ensureDocumentAndImportedIcons(document, options.imports);
  if (!Array.isArray(request.node) || request.node.length === 0 || request.node.some((id) => typeof id !== "string" || !id)) throw new Error("Extraction needs a non-empty node array.");
  validateExtractionRequest(request);
  if (typeof request.destination === "string" && request.destination.endsWith("/")) {
    const names = request.node.map((id) => validateOutputSegment(`${id}.${request.format}`));
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new Error("Extraction filename collision.");
    // Render every unit before publishing anything: an invalid later node must
    // not leave a partially successful extraction at the requested destination.
    const rendered = [];
    for (const nodeId of request.node) rendered.push(await renderExtractionNode(document, { ...request, nodeId }, options));
    const destination = normalize(request.destination);
    await writeExclusiveBundle(destination, names.map((name, index) => [name, rendered[index].bytes]));
    return {
      artifacts: names.map((name) => join(destination, name)), format: request.format, units: request.node.length,
      consequences: rendered.flatMap((unit) => unit.report.consequences ?? []),
    };
  }
  if (request.node.length === 1) return extractDocumentNode(document, { ...request, nodeId: request.node[0] }, options);
  if (request.format !== "pdf") {
    const error = new Error(`${request.format} cannot hold several nodes in one file.`);
    error.code = "CANVAS_EXTRACT_FORMAT_SINGLE_UNIT";
    throw error;
  }
  const units = [];
  // The shared text measurer is temporarily installed during preparation.
  // Finish each preparation before starting the next one.
  for (const nodeId of request.node) units.push(await buildPdfExtractionIR(document, { ...request, nodeId }, options));
  const ir = {
    ...units[0],
    outputs: units.flatMap((unit) => unit.outputs).map((output, index) => ({ ...output, index })),
    consequences: units.flatMap((unit) => unit.consequences),
    rasters: units.flatMap((unit) => unit.rasters),
  };
  await writeAtomicFile(request.destination, await renderPdfExtraction(ir, request, options));
  return { artifacts: [request.destination], format: "pdf", units: request.node.length, consequences: ir.consequences };
}

async function ensureDocumentAndImportedIcons(document, imports = {}) {
  await ensurePencilDocumentIconCatalogs(document);
  for (const imported of Object.values(imports)) {
    if (imported?.document) await ensureDocumentAndImportedIcons(imported.document, imported.imports);
  }
}

export async function extractDocumentNode(document, request, options = {}) {
  await ensureDocumentAndImportedIcons(document, options.imports);
  if (typeof request.nodeId !== "string" || !request.nodeId) throw new Error("Extraction needs one nodeId.");
  validateExtractionRequest(request);
  if (typeof request.destination === "string" && request.destination.endsWith("/")) return extractDocumentNodes(document, { ...request, node: [request.nodeId] }, options);
  const { bytes, report } = await renderExtractionNode(document, request, options);
  await writeAtomicFile(request.destination, bytes);
  return { artifacts: [request.destination], ...report };
}

async function renderExtractionNode(document, request, options) {
  if (request.format === "pdf") {
    const ir = await buildPdfExtractionIR(document, request, options);
    const artifact = await renderPdfExtraction(ir, request, options);
    return { bytes: artifact, report: { format: "pdf", consequences: ir.consequences } };
  }
  if (request.format === "png") {
    // Without an explicit export mode or imported library, PNG extraction is
    // the same operation as TakeScreenshot. Rendering the authored graph also
    // avoids expanding unrelated components elsewhere in a large document.
    const renderDocument = request.modes || Object.keys(options.imports ?? {}).length
      ? resolveCanvasDocument(document, { modes: request.modes, imports: options.imports }).document
      : document;
    const [image] = await takeDocumentScreenshots(renderDocument, [{ nodeIds: [request.nodeId] }], options.assets, { scale: request.scale ?? 1, maxDimension: 8192, failOnDownscale: true });
    return { bytes: Buffer.from(image.data, "base64"), report: { width: image.width, height: image.height, format: "png" } };
  }
  if (request.format === "svg") {
    const svgIr = buildExtractionIR(document, { nodeId: request.nodeId, modes: request.modes, imports: options.imports, scale: request.scale });
    const rasterHrefs = new Map();
    for (const raster of svgIr.rasters) {
      const image = await takeDocumentScreenshots(
        svgIr.renderDocument,
        [{ nodeIds: [raster.id] }],
        options.assets,
        { scale: request.scale ?? raster.variants.at(-1).scale, maxDimension: 8192, failOnDownscale: true },
      ).then((images) => images[0]);
      rasterHrefs.set(raster.id, `data:image/png;base64,${image.data}`);
    }
    const svg = exportSvg(svgIr, svgIr.outputs[0], {
      rasterHref: (id) => rasterHrefs.get(id),
    });
    return { bytes: svg, report: { format: "svg", consequences: svgIr.consequences } };
  }
  throw new Error(`Extraction format must be png, svg or pdf.`);
}

async function buildPdfExtractionIR(document, request, options) {
  const resolved = resolveCanvasDocument(document, { modes: request.modes, imports: options.imports }).document;
  const textIds = [];
  const visit = (node, selected = false) => {
    selected ||= node.id === request.nodeId;
    if (selected && node.type === "text") textIds.push(node.id);
    for (const child of node.children ?? []) visit(child, selected);
  };
  for (const node of resolved.children ?? []) visit(node);
  const preparedText = textIds.length ? await measureDocumentText(resolved, textIds, options.assets) : undefined;
  return buildExtractionIR(document, { ...request, imports: options.imports, preparedText });
}

async function renderPdfExtraction(ir, request, options) {
  return exportPdf(ir, {
    title: options.title, profile: request.profile,
    outputIntent: await readBundledSrgbProfile(), fonts: await readBundledPdfFonts(),
    rasterizeNode: async (id) => {
      const [image] = await takeDocumentScreenshots(ir.renderDocument, [{ nodeIds: [id] }], options.assets, { scale: 1, maxDimension: 8192, failOnDownscale: true });
      return Buffer.from(image.data, "base64");
    },
  });
}
function report(ir, path, role) {
  const nativeRuns = ir.outputs.flatMap((output) => output.nodes.filter((node) => node.type === "text" && node.capability.verdict === "native").flatMap((node) => node.semantics.runs));
  const usesInter = nativeRuns.some((run) => (run.fontFamily ?? "Inter") === "Inter");
  return {
    artifacts: [path], consequences: ir.consequences, lowered: ir.lowered,
    embeddedFonts: role === "slide" && usesInter ? [{ typeface: "Inter", faces: ["regular", "bold"], source: "bundled-document-font" }] : [],
    bundledFonts: ["ios", "android"].includes(role) && usesInter ? [{ typeface: "Inter", weights: [...new Set(nativeRuns.filter((run) => (run.fontFamily ?? "Inter") === "Inter").map((run) => Number(run.weight ?? run.fontWeight ?? 400)))].sort((a, b) => a - b), source: "bundled-document-font" }] : [],
    rasterized: ir.rasters,
  };
}
async function readBundledSrgbProfile() {
  try { return await readFile(new URL("../assets/color/sRGB2014.icc", import.meta.url)); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return readFile(new URL("./assets/color/sRGB2014.icc", import.meta.url));
  }
}
async function readBundledPdfFonts() {
  const names = { 400: "Inter-Regular.ttf", 500: "Inter-Medium.ttf", 600: "Inter-SemiBold.ttf", 700: "Inter-Bold.ttf", 800: "Inter-ExtraBold.ttf" };
  return Object.fromEntries(await Promise.all(Object.entries(names).map(async ([weight, filename]) => {
    try { return [`Inter:${weight}`, await readFile(new URL(`../vendor/open-pencil/fonts/${filename}`, import.meta.url))]; }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return [`Inter:${weight}`, await readFile(new URL(`./${filename}`, import.meta.url))];
    }
  })));
}
async function readBundledPptxFonts() {
  const sources = await readBundledPdfFonts();
  return [{ typeface: "Inter", faces: { regular: sources["Inter:400"], bold: sources["Inter:700"] } }];
}

async function readBundledFontResource(filename) {
  try { return await readFile(new URL(`../vendor/open-pencil/fonts/${filename}`, import.meta.url)); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return readFile(new URL(`./${filename}`, import.meta.url));
  }
}
