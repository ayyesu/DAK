import { assertCapabilityTotality, capabilityPathInventory } from "./canvas-schema.mjs";

const inventory = capabilityPathInventory();
const native = (evidence) => ({ verdict: "native", ...(evidence ? { evidence } : {}) });
const raster = (why) => ({ verdict: "raster", reason: why });
const ignore = (why) => ({ verdict: "ignore", reason: why });
const unverified = (reason) => ({ verdict: null, status: "unverified", ...(reason ? { reason } : {}) });

const EMISSION_SUPPORT = Object.freeze({
  pptx: table("select-at-export", [
    structuralRows("Schema, component, identity, geometry and selection fields are validated or lowered before DrawingML emission; the OOXML fixtures inspect their resulting slide objects."),
    layoutLoweringRows("The pinned Yoga/OpenPencil geometry fixtures measure these layout inputs before PPTX emits absolute native shapes."),
    roleRows("slide", "OOXML package fixtures emit and LibreOffice reopens the selected slide sequence."),
    { "root.lang": native("Generated DrawingML run language is inspected in the PPTX package fixture.") },
    { "relationships.import": native("Imports resolve before PPTX emission and are recorded as lowered.") },
    { "relationships.notesFor": native("Generated PPTX fixture contains a notesSlide part for notesFor.") },
    { "relationships.ref": native("Refs resolve to duplicated native shapes and are recorded as lowered.") },
    nativeRows(["root.axes", "properties.modes", "properties.varies", "nodes.frame", "nodes.group", "nodes.rectangle", "nodes.ellipse", "nodes.line", "nodes.ref", "nodes.text", "properties.accessibility.description", "properties.cornerRadius", "properties.effect", "properties.effect.shadow", "properties.fill", "properties.fill.solid", "properties.fill.gradient.linear", "properties.fill.gradient.radial", "properties.opacity", "properties.rotation", "properties.stroke", "properties.stroke.fill", "properties.stroke.width", "properties.content", "properties.fontFamily", "properties.fontSize", "properties.fontStyle", "properties.fontWeight", "properties.letterSpacing", "properties.lang", "properties.marks", "properties.paragraphs", "properties.style", "properties.strikethrough", "properties.text.paragraph.align", "properties.text.paragraph.list", "properties.text.paragraph.style", "properties.text.run.fill", "properties.text.run.fontFamily", "properties.text.run.fontSize", "properties.text.run.italic", "properties.text.run.language", "properties.text.run.letterSpacing", "properties.text.run.link", "properties.text.run.strikethrough", "properties.text.run.underline", "properties.text.run.weight", "properties.underline"], "Generated OOXML fixtures inspect native shapes, editable run/paragraph properties, gradients, shadow and alt text; LibreOffice reopens the package."),
    rasterRows(["nodes.icon", "properties.fill.image", "properties.fill.gradient.linear.transformed", "properties.fill.gradient.radial.transformed", "properties.effect.shadow.spread", "properties.effect.blur", "properties.blendMode", "properties.clip", "properties.flipX", "properties.flipY", "properties.stroke.align", "properties.stroke.cap", "properties.stroke.join", "properties.stroke.dash", "properties.lineHeight", "properties.wordSpacing", "properties.textAlign", "properties.textAlignVertical", "properties.text.run.wordSpacing"], "The current PPTX writer has no measured native emission for this construct."),
    ignoreRows(["properties.headingLevel", "properties.accessibility.landmark", "properties.accessibility.linkName", "properties.decorative", "properties.text.paragraph.headingLevel"], "PresentationML has no native heading, landmark, or link-purpose semantic for ordinary slide shapes in the supported writer."),
    { "properties.fill.gradient.angular": raster("DrawingML has no angular-gradient element.") },
    { "properties.fill.gradient.mesh": raster("DrawingML has no mesh-gradient element.") },
    { "properties.fill.shader": raster("DrawingML cannot execute shaders.") },
    { "properties.effect.background_blur": raster("DrawingML has no backdrop-filter effect.") },
    rasterRows(["properties.icon", "properties.library", "properties.weight", "properties.textGrowth"], "The current PPTX writer has no measured native emission for this construct."),
    vectorRows("PowerPoint rendered all 20 shared vector cases after fill-rule normalization. compatibility/powerpoint-render-evidence.test.mjs measures 390274 matching interior pixels in the native application screenshot and rejects the former nonzero-hole output (9156 mismatches). Both authored rules are simplified before DrawingML emission; strokes retain authored contours. See research/powerpoint-vector-matrix-fixed and src/vector-path.test.mjs. This is native rendering evidence, not an interactive editing claim in the unactivated Office installation."),
  ], "pptx"),
  pdf: table("select-at-export", [
    structuralRows("Schema, component, identity, geometry and selection fields are validated or lowered before PDF emission; the generated PDF fixture measures their resulting page objects."),
    layoutLoweringRows("The pinned Yoga/OpenPencil geometry fixtures measure these layout inputs before PDF emits absolute drawing operations."),
    roleRows(null, "PDF extraction accepts roleless subtrees and preserves declared physical dimensions."),
    { "root.lang": native("The PDF/UA fixture emits the document Lang entry and passes veraPDF.") },
    { "relationships.import": native("Imports resolve before PDF emission and are recorded as lowered.") },
    { "relationships.notesFor": ignore("Speaker-note relationships have no meaning in static PDF output.") },
    { "relationships.ref": native("Refs resolve to native PDF drawing operations and are recorded as lowered.") },
    nativeRows(["root.axes", "properties.modes", "properties.varies", "nodes.frame", "nodes.group", "nodes.rectangle", "nodes.ellipse", "nodes.line", "nodes.ref", "nodes.text", "properties.accessibility.description", "properties.decorative", "properties.fill", "properties.fill.solid", "properties.stroke", "properties.stroke.fill", "properties.stroke.width", "properties.content", "properties.fontFamily", "properties.fontSize", "properties.fontWeight", "properties.lang", "properties.marks", "properties.paragraphs", "properties.style", "properties.text.paragraph.headingLevel", "properties.text.paragraph.style", "properties.text.run.fill", "properties.text.run.fontFamily", "properties.text.run.fontSize", "properties.text.run.language", "properties.text.run.weight"], "Generated PDF fixtures inspect page geometry, native vector operators, embedded text/fonts, language and tagged accessibility structure; PDF/A-3b and PDF/UA-1 pass the pinned veraPDF run."),
    rasterRows(["nodes.icon", "properties.fill.image", "properties.fill.gradient.linear", "properties.fill.gradient.radial", "properties.fill.gradient.angular", "properties.fill.gradient.mesh", "properties.effect", "properties.effect.shadow", "properties.effect.blur", "properties.blendMode", "properties.clip"], "The current PDF writer has no measured native emission for this construct."),
    { "properties.fill.shader": raster("PDF cannot execute Canvas shaders.") },
    { "properties.effect.background_blur": raster("Backdrop blur is flattened for deterministic PDF output.") },
    ignoreRows(["properties.accessibility.landmark", "properties.accessibility.linkName", "properties.text.run.link"], "The supported static PDF profile has no lowering for this semantic."),
    rasterRows(["properties.cornerRadius", "properties.flipX", "properties.flipY", "properties.opacity", "properties.rotation", "properties.fontStyle", "properties.letterSpacing", "properties.lineHeight", "properties.strikethrough", "properties.text.paragraph.align", "properties.text.paragraph.list", "properties.text.run.italic", "properties.text.run.letterSpacing", "properties.text.run.strikethrough", "properties.text.run.underline", "properties.text.run.wordSpacing", "properties.textAlign", "properties.textAlignVertical", "properties.textGrowth", "properties.underline", "properties.wordSpacing"], "The current PDF writer has no measured native emission for this construct."),
    rasterRows(["properties.effect.shadow.spread", "properties.fill.gradient.linear.transformed", "properties.fill.gradient.radial.transformed", "properties.headingLevel", "properties.icon", "properties.library", "properties.stroke.align", "properties.stroke.cap", "properties.stroke.dash", "properties.stroke.join", "properties.weight"], "The current PDF writer has no measured native emission for this construct."),
    measuredVectorRows("PDF"),
  ], "pdf"),
  html: table("emit-conditional", [
    structuralRows("Schema, component and identity fields lower into the semantic IR; the Chrome fixture inspects the resulting hierarchy and geometry."),
    roleRows("route", "Chrome fixtures load one generated HTML file per selected route."),
    { "root.lang": native("Chrome fixture observes the generated html lang attribute.") },
    { "relationships.import": native("Imports resolve into emitted HTML/CSS and are recorded as lowered.") },
    { "relationships.notesFor": ignore("Speaker-note relationships have no meaning in a web route.") },
    { "relationships.ref": native("Refs resolve into semantic source output and are recorded as lowered.") },
    nativeRows(["root.axes", "properties.modes", "properties.varies", "nodes.frame", "nodes.group", "nodes.rectangle", "nodes.ellipse", "nodes.ref", "nodes.text", "properties.accessibility.description", "properties.accessibility.landmark", "properties.decorative", "properties.cornerRadius", "properties.fill", "properties.fill.solid", "properties.opacity", "properties.rotation", "properties.stroke", "properties.stroke.fill", "properties.stroke.width", "properties.content", "properties.fontFamily", "properties.fontSize", "properties.fontWeight", "properties.gap", "properties.gridColumn", "properties.gridRow", "properties.gridTemplateColumns", "properties.gridTemplateRows", "properties.layout", "properties.marks", "properties.paragraphs", "properties.rowGap", "properties.style", "properties.text.paragraph.headingLevel", "properties.text.run.fill", "properties.text.run.fontFamily", "properties.text.run.fontSize", "properties.text.run.weight", "properties.wrap", "properties.clip"], "Generated HTML/CSS is loaded in Chrome; tests inspect semantic hierarchy, native grid/flex rules, responsive variants, clipping, paint, text and accessibility at three viewport widths."),
    rasterRows(["nodes.icon", "nodes.line", "properties.fill.image", "properties.fill.gradient.linear", "properties.fill.gradient.radial", "properties.fill.gradient.angular", "properties.effect", "properties.effect.shadow", "properties.effect.blur", "properties.effect.background_blur", "properties.blendMode", "properties.flipX", "properties.flipY", "properties.stroke.align", "properties.stroke.cap", "properties.stroke.join", "properties.stroke.dash", "properties.padding", "properties.justifyContent", "properties.alignItems", "properties.minWidth", "properties.maxWidth", "properties.minHeight", "properties.maxHeight", "properties.textAlign", "properties.textAlignVertical", "properties.lineHeight", "properties.wordSpacing", "properties.text.paragraph.align", "properties.text.paragraph.style", "properties.text.paragraph.list"], "The current HTML/CSS writer has no measured live emission for this construct."),
    nativeRows(["properties.columnGap", "properties.fontStyle", "properties.lang", "properties.letterSpacing", "properties.strikethrough", "properties.text.run.italic", "properties.text.run.language", "properties.text.run.letterSpacing", "properties.text.run.link", "properties.text.run.strikethrough", "properties.text.run.underline", "properties.text.run.wordSpacing", "properties.underline"], "Chrome parses the emitted span/link language and style attributes in the semantic-source fixture."),
    { "properties.fill.gradient.mesh": raster("CSS has no portable mesh-gradient primitive.") },
    { "properties.fill.shader": raster("Static HTML/CSS export does not ship a shader runtime.") },
    { "properties.accessibility.linkName": ignore("No link-purpose field is emitted without a link element.") },
    rasterRows(["properties.effect.shadow.spread", "properties.fill.gradient.linear.transformed", "properties.fill.gradient.radial.transformed", "properties.headingLevel", "properties.icon", "properties.layoutPosition", "properties.library", "properties.textGrowth", "properties.weight"], "The current HTML/CSS writer has no measured live emission for this construct."),
    measuredVectorRows("HTML"),
  ], "html"),
  swift: table("emit-conditional", [
    structuralRows("Schema, component and identity fields lower into the semantic IR and pinned Swift fixture."),
    roleRows("ios", "The pinned Swift fixture compiles one source file per selected iOS frame."),
    { "relationships.import": native("Imports resolve into generated SwiftUI source and are recorded as lowered.") },
    { "relationships.notesFor": ignore("Speaker-note relationships have no meaning in SwiftUI source.") },
    { "relationships.ref": native("Refs resolve into generated SwiftUI constructs and are recorded as lowered.") },
    rasterRows(["nodes.icon", "nodes.line", "properties.fill.image", "properties.fill.gradient.linear", "properties.fill.gradient.radial", "properties.fill.gradient.angular", "properties.effect", "properties.effect.shadow", "properties.effect.blur", "properties.blendMode", "properties.clip", "properties.rotation", "properties.flipX", "properties.flipY", "properties.stroke", "properties.stroke.width", "properties.stroke.align", "properties.stroke.cap", "properties.stroke.join", "properties.stroke.dash", "properties.stroke.fill", "properties.padding", "properties.justifyContent", "properties.minWidth", "properties.maxWidth", "properties.minHeight", "properties.maxHeight", "properties.gridTemplateRows", "properties.gridColumn", "properties.gridRow", "properties.textAlign", "properties.textAlignVertical", "properties.lineHeight", "properties.wordSpacing", "properties.text.run.wordSpacing", "properties.text.run.language", "properties.text.run.link", "properties.text.paragraph.align", "properties.text.paragraph.style", "properties.text.paragraph.list"], "The current SwiftUI writer has no measured live emission for this construct."),
    { "properties.fill.gradient.mesh": raster("SwiftUI target emits a rendered asset for mesh geometry.") },
    { "properties.fill.shader": raster("SwiftUI target does not ship a shader runtime.") },
    { "properties.effect.background_blur": raster("Canvas backdrop semantics are emitted as an isolated asset.") },
    vectorRows("SwiftUI Path/FillStyle rendered all 20 shared vector cases on iPhone at 3x and iPad at 2x. scripts/verify-mobile-vectors.mjs measures 2079474 and 908950 matching interior pixels against full-resolution Canvas references, with two-pixel boundary and two-channel-step tolerances. Both fill rules, curves, arcs, crossings, polygons, relative commands, offset viewBoxes and open fills are covered. See research/mobile-qa/ios-vector-matrix-3x.png and ipad-vector-matrix-2x.png. Other paint/stroke/layout/semantic rows remain independently gated."),
    mobileCandidateRows("SwiftUI", true),
  ], "swift"),
  kotlin: table("emit-conditional", [
    structuralRows("Schema, component and identity fields lower into the semantic IR and pinned Compose fixture."),
    roleRows("android", "The pinned Compose fixture compiles one source file per selected Android frame."),
    { "relationships.import": native("Imports resolve into generated Compose source and are recorded as lowered.") },
    { "relationships.notesFor": ignore("Speaker-note relationships have no meaning in Compose source.") },
    { "relationships.ref": native("Refs resolve into generated Compose constructs and are recorded as lowered.") },
    rasterRows(["nodes.icon", "nodes.line", "properties.fill.image", "properties.fill.gradient.linear", "properties.fill.gradient.radial", "properties.fill.gradient.angular", "properties.effect", "properties.effect.shadow", "properties.effect.blur", "properties.blendMode", "properties.clip", "properties.rotation", "properties.flipX", "properties.flipY", "properties.stroke", "properties.stroke.width", "properties.stroke.align", "properties.stroke.cap", "properties.stroke.join", "properties.stroke.dash", "properties.stroke.fill", "properties.padding", "properties.justifyContent", "properties.alignItems", "properties.minWidth", "properties.maxWidth", "properties.minHeight", "properties.maxHeight", "properties.gridTemplateRows", "properties.gridColumn", "properties.gridRow", "properties.textAlign", "properties.textAlignVertical", "properties.lineHeight", "properties.wordSpacing", "properties.text.run.wordSpacing", "properties.text.run.language", "properties.text.run.link", "properties.text.paragraph.align", "properties.text.paragraph.style", "properties.text.paragraph.list"], "The current Compose writer has no measured live emission for this construct."),
    { "properties.fill.gradient.mesh": raster("Compose target emits a rendered asset for mesh geometry.") },
    { "properties.fill.shader": raster("Compose target does not ship a shader runtime.") },
    { "properties.effect.background_blur": raster("Canvas backdrop semantics are emitted as an isolated asset.") },
    vectorRows("Compose Path/PathFillType rendered all 20 shared vector cases on API 36 Pixel 8 at 420/320 dpi (2.625x/2x). scripts/verify-mobile-vectors.mjs measures 1577758 and 908950 matching interior pixels against full-resolution Canvas references, with two-pixel boundary and two-channel-step tolerances. Both fill rules, curves, arcs, crossings, polygons, relative commands, offset viewBoxes and open fills are covered. See research/mobile-qa/android-vector-matrix-420dpi.png and android-vector-matrix-320dpi.png. Other paint/stroke/layout/semantic rows remain independently gated."),
    mobileCandidateRows("Compose", false),
  ], "kotlin"),
  svg: table("select-at-export", [
    structuralRows("Schema, component, identity, geometry and selection fields lower before standalone SVG serialization."),
    layoutLoweringRows("The pinned Yoga/OpenPencil geometry fixtures measure these layout inputs before SVG serializes absolute geometry."),
    roleRows(null, "Standalone SVG serialization accepts a subtree selected through any Canvas export role."),
    { "root.lang": native("Generated SVG carries the document language for accessible text.") },
    { "relationships.import": native("Imports resolve before SVG serialization and are recorded as lowered.") },
    { "relationships.notesFor": ignore("Standalone SVG export omits speaker-note relationships.") },
    { "relationships.ref": native("Refs resolve to SVG elements and are recorded as lowered.") },
    nativeRows(["root.axes", "properties.modes", "properties.varies", "nodes.frame", "nodes.group", "nodes.rectangle", "nodes.ellipse", "nodes.line", "nodes.ref", "nodes.text", "properties.accessibility.description", "properties.decorative", "properties.cornerRadius", "properties.fill", "properties.fill.solid", "properties.opacity", "properties.rotation", "properties.stroke", "properties.stroke.fill", "properties.stroke.width", "properties.content", "properties.fontFamily", "properties.fontSize", "properties.fontWeight", "properties.marks", "properties.paragraphs", "properties.style", "properties.text.run.fill", "properties.text.run.fontFamily", "properties.text.run.fontSize", "properties.text.run.weight"], "Generated SVG is parsed and rendered in Chromium; structural tests inspect vector elements, paint, text runs, transforms and accessibility attributes."),
    rasterRows(["nodes.icon", "properties.fill.image", "properties.fill.gradient.linear", "properties.fill.gradient.radial", "properties.fill.gradient.angular", "properties.effect", "properties.effect.shadow", "properties.effect.blur", "properties.blendMode", "properties.clip", "properties.stroke.align", "properties.stroke.cap", "properties.stroke.join", "properties.stroke.dash", "properties.text.run.link", "properties.text.paragraph.align", "properties.text.paragraph.style", "properties.text.paragraph.list"], "The supported SVG writer profile has no measured native emission for this construct."),
    nativeRows(["properties.fontStyle", "properties.lang", "properties.letterSpacing", "properties.strikethrough", "properties.stroke.width", "properties.text.run.italic", "properties.text.run.language", "properties.text.run.letterSpacing", "properties.text.run.strikethrough", "properties.text.run.underline", "properties.text.run.wordSpacing", "properties.underline", "properties.wordSpacing"], "Generated SVG structural fixtures inspect the emitted run style, language, decoration, spacing and stroke-width attributes, and Chromium renders the file."),
    { "properties.fill.gradient.mesh": raster("SVG 1.1 has no mesh-gradient primitive in the supported profile.") },
    { "properties.fill.shader": raster("SVG cannot execute Canvas shaders.") },
    { "properties.effect.background_blur": raster("Portable SVG has no backdrop blur.") },
    ignoreRows(["properties.accessibility.landmark", "properties.accessibility.linkName", "properties.headingLevel", "properties.text.paragraph.headingLevel"], "The supported standalone SVG profile does not emit this document semantic."),
    rasterRows(["properties.effect.shadow.spread", "properties.fill.gradient.linear.transformed", "properties.fill.gradient.radial.transformed", "properties.flipX", "properties.flipY", "properties.icon", "properties.library", "properties.lineHeight", "properties.textAlign", "properties.textAlignVertical", "properties.textGrowth", "properties.weight"], "The supported SVG writer profile has no measured native emission for this construct."),
    measuredVectorRows("SVG"),
  ], "svg"),
});

export const CAPABILITY_TABLES = Object.freeze(Object.fromEntries(
  ["pptx", "html", "swift", "kotlin"].map((format) => [format, EMISSION_SUPPORT[format]]),
));

export function capabilityTableFor(format) {
  return Object.hasOwn(CAPABILITY_TABLES, format) ? CAPABILITY_TABLES[format] : null;
}

// Private writer coverage for truthful fallback while extraction's emitters
// are completed. This is not a role or a deliverable capability contract.
export function extractionEmissionSupport(format) {
  return ["pdf", "svg"].includes(format) ? EMISSION_SUPPORT[format] : null;
}

export function unverifiedCapabilityEntries() {
  return [
    ...Object.entries(CAPABILITY_TABLES).flatMap(([target, tableValue]) =>
    Object.entries(tableValue.properties)
      .filter(([, entry]) => entry.status === "unverified")
      .map(([path, entry]) => ({ target, path, verdict: entry.verdict }))),
  ];
}

export function assertAllCapabilityTables() {
  const errors = [];
  for (const [target, tableValue] of Object.entries(CAPABILITY_TABLES)) {
    try { assertCapabilityTotality(tableValue, inventory); }
    catch (error) { errors.push(`${target}: ${error.message}`); }
  }
  if (errors.length) {
    const error = new Error(`Capability tables are not buildable:\n${errors.join("\n")}`);
    error.code = "CANVAS_CAPABILITY_INCOMPLETE";
    throw error;
  }
  return true;
}

function table(axisLowering, overrides, format) {
  const entries = mergeCapabilityRows([...overrides, physicalGeometryRows(format), staticExportFlowRows()]);
  return { axes: axisLowering, properties: Object.fromEntries(inventory.map((path) => [path, entries[path] ?? unverified()])) };
}
export function mergeCapabilityRows(groups) {
  const entries = {};
  for (const group of groups) for (const [path, entry] of Object.entries(group)) {
    if (Object.hasOwn(entries, path) && (entries[path].verdict !== entry.verdict || entries[path].status !== entry.status)) {
      throw new Error(`Conflicting capability declarations: ${path}`);
    }
    entries[path] = entry;
  }
  return entries;
}
function rasterRows(paths, reason) { return Object.fromEntries(paths.map((path) => [path, raster(reason)])); }
function ignoreRows(paths, reason) { return Object.fromEntries(paths.map((path) => [path, ignore(reason)])); }
function nativeRows(paths, evidence) { return Object.fromEntries(paths.map((path) => [path, native(evidence)])); }
function vectorRows(evidence) {
  return nativeRows(["nodes.path", "nodes.polygon", "properties.geometry", "properties.viewBox", "properties.fillRule"], evidence);
}
function measuredVectorRows(format) {
  return nativeRows(["nodes.path", "nodes.polygon", "properties.geometry", "properties.viewBox", "properties.fillRule"],
    `${format}: compatibility/vector-fidelity.test.mjs measures 20 path/polygon cases at 1x and 2x against Canvas: both fill rules, holes, crossings, cubic/quadratic curves, arcs, relative commands, open fills, offset viewBoxes and nonuniform scaling. Chromium SVG/HTML and Poppler PDF match 538716/2265890 interior pixels within two channel steps, excluding a two-physical-pixel antialiasing boundary. Artifacts: research/vector-fidelity-fixed-20260905. Paint, stroke, effects and other properties retain independent gates.`);
}
function mobileCandidateRows(platform, includesAlignItems) {
  const fallback = `${platform} has no complete native-device fidelity evidence for this construct. Canvas preserves the rendered result as an image and reports the loss of native editability or semantics instead of treating generated source or compilation as proof.`;
  return {
    ...Object.fromEntries([
      "nodes.ellipse", "nodes.frame", "nodes.group", "nodes.rectangle", "nodes.ref", "nodes.text",
      "properties.accessibility.description", "properties.content", "properties.cornerRadius", "properties.decorative",
      "properties.fill", "properties.fill.solid", "properties.fontFamily", "properties.fontSize", "properties.fontStyle", "properties.fontWeight",
      "properties.gap", "properties.gridTemplateColumns", "properties.headingLevel", "properties.layout", "properties.letterSpacing",
      "properties.marks", "properties.modes", "properties.opacity", "properties.paragraphs", "properties.rowGap", "properties.strikethrough",
      "properties.text.paragraph.headingLevel", "properties.text.run.fill", "properties.text.run.fontFamily", "properties.text.run.fontSize",
      "properties.text.run.italic", "properties.text.run.strikethrough", "properties.text.run.underline", "properties.text.run.weight",
      "properties.text.run.letterSpacing",
      "properties.textGrowth", "properties.underline", "properties.varies", "properties.wrap", "root.axes",
      ...(includesAlignItems ? ["properties.alignItems"] : []),
      "properties.effect.shadow.spread", "properties.fill.gradient.linear.transformed", "properties.fill.gradient.radial.transformed", "properties.icon", "properties.layoutPosition", "properties.library", "properties.weight",
      "properties.accessibility.landmark", "properties.accessibility.linkName", "properties.lang", "root.lang",
    ].map((path) => [path, raster(fallback)])),
    ...nativeRows(["nodes.rectangle", "nodes.ellipse"], `${platform} native shape fixtures ran on the installed simulator/emulator. The 2026-09-05 shape-opacity screenshots verify 300x100 rectangles and true ellipses, opaque and translucent paint; earlier grid fixtures verify square circles and authored dimensions. See research/export-verification-2026-09-05.md. Other paint, layout, effect and accessibility property rows remain independently gated.`),
    ...nativeRows(["properties.fontWeight", "properties.text.run.weight"], `${platform} exact bundled Inter 400/500/600/700/800 faces match Canvas glyph interiors on iPhone 3x, iPad 2x and Android 420/320 dpi. Font identity checks reject incorrect family/weight/style bytes; Compose uses fractional base sizing and linear/subpixel text metrics. Retained native captures and former rounded/hinted negative controls run in compatibility/mobile-font-fidelity.test.mjs. Mixed-size runs, other typography properties and accessibility scaling remain separately gated.`),
    ...(platform === "Compose" ? nativeRows(["properties.fontSize"], "Five native Compose text nodes at 24, 28.25, 32, 40 and 48 sp match Canvas glyph interiors at Android 420 and 320 dpi (1576930 and 904895 checked pixels). The fractional base size survives without AbsoluteSizeSpan integer rounding. Retained captures and an iOS rounding negative control run in compatibility/mobile-font-size-fidelity.test.mjs. Differently sized runs within one text node remain separately gated by properties.text.run.fontSize.") : {}),
    ...nativeRows(["properties.gap", "properties.rowGap", "properties.columnGap"], `${platform} independent-gap fixture ran on the installed simulator/emulator. Fourteen measured rectangles verify horizontal and vertical stacks, wrapping rows and a two-column grid, including row/column overrides of gap, within two physical pixels at 3x and 2.625x density. See scripts/verify-mobile-gaps.mjs and research/mobile-qa/*-independent-gaps.png. Grid sizing, alignment and other layout properties retain separate gates.`),
    ...nativeRows(["nodes.frame", "nodes.group", "nodes.ref", "properties.opacity"], `${platform} six-case surface fixture verifies opaque and half-opacity frames, groups and component references with overlapping child paint. Actual iPhone 3x, iPad 2x and Android 420/320 dpi screenshots match Canvas within two channel steps outside two-pixel boundaries. This exposed and repaired dropped instance placement and legacy-only reference root paint inheritance. See scripts/verify-mobile-vectors.mjs --surfaces and research/mobile-qa/*surfaces-fixed*.png. Layout, effects, clipping and text remain independently gated.`),
    "properties.fill.solid": native(`${platform} six-case solid-color matrix verifies shorthand/full hex alpha, numeric rgba, independent paint opacity, multiplied color/paint alpha and transparent paint on iPhone 3x, iPad 2x and Android 420/320 dpi. Every uniform interior matches Canvas within two channel steps; retained native captures and the former Canvas opacity defect are checked by compatibility/mobile-paint-fidelity.test.mjs. The parent fill row remains gated for aggregate paint handling.`),
    "properties.cornerRadius": native(`${platform} rectangle and container backgrounds retain scalar and independent TL/TR/BR/BL radii, omitted array entries and proportional overlap normalization. Eight native-device regions match Skia round-rectangle coverage within two physical boundary pixels at 3x/2.625x density. See scripts/verify-mobile-corners.mjs, src/rounded-rectangle.test.mjs and research/mobile-qa/*-independent-corners.png.`),
    ...nativeRows(["properties.accessibility.description", "properties.decorative"], `${platform} native accessibility tests verify root/text/shape/group descriptions, independent visible child labels, and removal of direct/decorative-group descendant labels while preserving paint. iPhone accessibility XXL, iPad large and Android font scales 1.0/2.0 passed; see research/mobile-qa/*nested-accessibility*. These rows do not claim heading levels, language, speech quality or typography fidelity.`),
  };
}
function layoutLoweringRows(evidence) {
  return nativeRows(["properties.alignItems", "properties.columnGap", "properties.gap", "properties.gridColumn", "properties.gridRow", "properties.gridTemplateColumns", "properties.gridTemplateRows", "properties.justifyContent", "properties.layout", "properties.layoutPosition", "properties.maxHeight", "properties.maxWidth", "properties.minHeight", "properties.minWidth", "properties.padding", "properties.rowGap", "properties.wrap"], evidence);
}
function structuralRows(evidence) {
  return Object.fromEntries([
    "root.module", "root.variables",
    "root.paragraphStyles", "root.imports", "root.children",
    "properties.id", "properties.type", "properties.name", "properties.x", "properties.y",
    "properties.width", "properties.height", "properties.enabled", "properties.export",
    "properties.role", "properties.size", "properties.physical", "properties.properties",
    "properties.bind", "properties.visible",
    "properties.ref", "properties.props", "properties.style", "properties.notesFor",
  ].map((path) => [path, native(evidence)]));
}
function roleRows(selectedRole, evidence) {
  return Object.fromEntries(["slide", "route", "ios", "android"].map((role) => [
    `roles.${role}`,
    selectedRole === null || role === selectedRole ? native(evidence) : ignore(`Role ${role} cannot occur in this exporter's module.`),
  ]));
}
function physicalGeometryRows(format) {
  if (format === "pdf") return {
    "properties.bleed": native("Generated PDF fixture measures MediaBox, CropBox, BleedBox and TrimBox against the declared point bleed."),
    "properties.folds": ignore("Fold positions are authoring guides and emit no PDF marks."),
    "properties.safeMargin": ignore("safeMargin is an authoring guide and is not a PDF page box."),
  };
  return ignoreRows(["properties.bleed", "properties.folds", "properties.safeMargin"], "Bleed boxes belong to PDF extraction; fold positions and safe margins are non-emitting authoring guides.");
}
function staticExportFlowRows() {
  return Object.fromEntries([
    "root.flows", "relationships.flow", "properties.flow.advance", "properties.flow.tap",
    "properties.flow.hover", "properties.flow.keypress",
  ].map((path) => [path, ignore("Product decision 2026-09-04: Canvas exports static designs; prototype flows are not exported and exporter IR emits an empty flows array.")]));
}
