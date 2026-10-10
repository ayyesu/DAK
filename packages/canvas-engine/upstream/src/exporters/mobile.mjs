import { scaledVectorCommands } from "../vector-path.mjs";
import { roundedRectangleVector } from "../rounded-rectangle.mjs";
import { normalizeStrokeDash } from "../stroke-dash.mjs";
import { parseCssColor } from "../canvas-theme.mjs";
import { addMobileFontFiles, mobileFontCatalog, mobileFontKey } from "./mobile-fonts.mjs";

export function exportSwiftUI(ir, options = {}) {
  assertScreenNames(ir.outputs);
  if (options.fonts) options = { ...options, fontCatalog: mobileFontCatalog(ir, options.fonts) };
  const files = new Map([["_canvas/FlowLayout.swift", swiftFlowHelper]]);
  for (const output of ir.outputs) files.set(`${sourceName(output.name)}.swift`, swiftScreen(output, options));
  if (options.fontCatalog) addMobileFontFiles(files, options.fontCatalog, "ios");
  return files;
}

export function exportCompose(ir, options = {}) {
  assertScreenNames(ir.outputs);
  if (options.fonts) options = { ...options, fontCatalog: mobileFontCatalog(ir, options.fonts) };
  const files = new Map([["_canvas/CanvasFlowLayout.kt", composeFlowHelper]]);
  for (const output of ir.outputs) files.set(`${sourceName(output.name)}.kt`, composeScreen(output, options));
  if (options.fontCatalog) addMobileFontFiles(files, options.fontCatalog, "android");
  return files;
}

function assertScreenNames(outputs) {
  const names = new Set(["flowlayout", "canvasflowlayout", "canvasfonts", "canvasrasterimage"]);
  for (const output of outputs) {
    const name = sourceName(output.name).normalize("NFC").toLowerCase();
    if (names.has(name)) {
      const error = new Error(`Screen ${output.id} has a colliding generated source name: ${sourceName(output.name)}.`);
      error.code = "CANVAS_EXPORT_NAME_COLLISION";
      throw error;
    }
    names.add(name);
  }
}

function swiftScreen(output, options) {
  const children = groupChildren(output.nodes);
  const root = output.root ?? rootNode(output);
  return `import SwiftUI\n\npublic struct ${sourceName(output.name)}: View {\n  public init() {${options.fontCatalog?.size ? " CanvasFonts.register() " : ""}}\n  public var body: some View {\n${swiftContainer(root, orderedChildren(root, children), children, options, 2, true)}\n      .accessibilityElement(children: .contain)${swiftAccessibility(root)}\n  }\n}\n`;
}

function swiftNode(node, children, options, depth, parentLayout) {
  if (node.capability.verdict === "ignore") return "";
  const indent = "  ".repeat(depth);
  const position = swiftGeometry(node, parentLayout);
  const access = swiftAccessibility(node);
  if (node.capability.verdict === "raster") {
    const data = options.rasterData?.(node.id);
    if (!data) throw new Error(`SwiftUI rasterizer is required for ${node.id}.`);
    return `${indent}CanvasRasterImage(base64: ${JSON.stringify(data)})${position}${access}`;
  }
  if (node.type === "text") return `${indent}(${swiftText(node, options)}).opacity(${n(node.paint.opacity ?? 1)})${position}${access}`;
  if (node.vector) return `${indent}${swiftVector(node)}${position}${access}`;
  const descendants = orderedChildren(node, children);
  if (descendants.length || ["frame", "group", "ref"].includes(node.type)) return swiftContainer(node, descendants, children, options, depth, false, parentLayout, access);
  if (node.type !== "ellipse" && node.paint.cornerRadius != null) return `${indent}${swiftVector({ ...node, vector: roundedRectangleVector(node) })}${position}${access}`;
  const shape = node.type === "ellipse" ? "Ellipse()" : "Rectangle()";
  return `${indent}${shape}.fill(${swiftColor(solid(node.paint.fill))}).opacity(${n(node.paint.opacity ?? 1)})${position}${access}`;
}

function swiftVector(node) {
  const statements = scaledVectorCommands(node.vector, node.geometry.w, node.geometry.h).map((command) => {
    if (command.type === "move") return `path.move(to: CGPoint(x: ${n(command.x)}, y: ${n(command.y)}))`;
    if (command.type === "line") return `path.addLine(to: CGPoint(x: ${n(command.x)}, y: ${n(command.y)}))`;
    if (command.type === "cubic") return `path.addCurve(to: CGPoint(x: ${n(command.x)}, y: ${n(command.y)}), control1: CGPoint(x: ${n(command.c1x)}, y: ${n(command.c1y)}), control2: CGPoint(x: ${n(command.c2x)}, y: ${n(command.c2y)}))`;
    return "path.closeSubpath()";
  }).join("; ");
  const path = `Path { path in ${statements} }`;
  const stroke = mobileVectorStroke(node);
  const fill = `${path}.fill(${swiftColor(solid(node.paint.fill))}, style: FillStyle(eoFill: ${node.vector.fillRule === "evenodd"}))`;
  let overlay = "";
  if (stroke) {
    const style = `StrokeStyle(lineWidth: ${n(stroke.width * (stroke.align === "center" ? 1 : 2))}, lineCap: .${stroke.cap}, lineJoin: .${stroke.join}, miterLimit: 4, dash: [${stroke.dash.map(n).join(", ")}])`;
    if (stroke.align === "center") overlay = `.overlay(${path}.stroke(${swiftColor(stroke.color)}, style: ${style}))`;
    else {
      // Keep the inverse-clip drawing surface larger than the authored box so
      // an outside stroke is not cut off at the edge of its own node.
      const outset = stroke.width * 4;
      overlay = `.overlay(alignment: .topLeading) { Canvas { context, _ in context.translateBy(x: ${n(outset)}, y: ${n(outset)}); let path = ${path}; context.clip(to: path, style: FillStyle(eoFill: ${node.vector.fillRule === "evenodd"}), options: ${stroke.align === "outside" ? ".inverse" : "[]"}); context.stroke(path, with: .color(${swiftColor(stroke.color)}), style: ${style}) }.frame(width: ${n(node.geometry.w + outset * 2)}, height: ${n(node.geometry.h + outset * 2)}).offset(x: ${n(-outset)}, y: ${n(-outset)}) }`;
    }
  }
  return `${fill}${overlay}.compositingGroup().opacity(${n(node.paint.opacity ?? 1)})`;
}

function swiftContainer(node, descendants, children, options, depth, root = false, parentLayout = "none", access = "") {
  const indent = "  ".repeat(depth);
  const inner = descendants.map((child) => swiftNode(child, children, options, depth + 1, node.layout.layout || (node.layout.wrap ? "wrap" : "none"))).filter(Boolean).join("\n");
  const { row, column } = mobileGaps(node);
  const columns = Math.max(1, node.layout.gridTemplateColumns?.length ?? 1);
  let open;
  if (node.layout.layout === "grid") open = `LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: ${column}), count: ${columns}), spacing: ${row})`;
  else if (node.layout.wrap) open = `FlowLayout(spacing: ${column}, rowSpacing: ${row})`;
  else if (node.layout.layout === "horizontal") open = `HStack(alignment: ${swiftAlignment(node.layout.alignItems)}, spacing: ${column})`;
  else if (node.layout.layout === "vertical") open = `VStack(alignment: ${swiftHorizontalAlignment(node.layout.alignItems)}, spacing: ${row})`;
  else open = "ZStack(alignment: .topLeading)";
  const background = !solid(node.paint.fill) ? "" : node.paint.cornerRadius != null
    ? `.background(alignment: .topLeading) { ${swiftVector({ ...node, vector: roundedRectangleVector(node), paint: { fill: node.paint.fill, opacity: 1 } })} }`
    : `.background(${swiftColor(solid(node.paint.fill))}, ignoresSafeAreaEdges: [])`;
  const insets = mobilePadding(node);
  const padding = insets ? `.padding(EdgeInsets(top: ${n(insets[0])}, leading: ${n(insets[3])}, bottom: ${n(insets[2])}, trailing: ${n(insets[1])}))` : "";
  const rootFrame = root ? `.frame(width: ${n(node.geometry.w)}, height: ${n(node.geometry.h)}, alignment: ${swiftFrameAlignment(node)})` : "";
  const paint = `${background}.compositingGroup().opacity(${n(node.paint.opacity ?? 1)})`;
  const geometry = root ? `${rootFrame}${paint}` : swiftGeometry(node, parentLayout, paint);
  const childSemantics = !root && descendants.length ? ".accessibilityElement(children: .contain)" : "";
  return `${indent}${open} {\n${inner}\n${indent}}${padding}${geometry}${childSemantics}${access}`;
}

function swiftText(node, options) {
  const runs = node.semantics.runs.length ? node.semantics.runs : [{ from: 0, to: node.semantics.content.length }];
  return runs.map((run) => {
    const text = node.semantics.content.slice(run.from, run.to);
    let result = `Text(${JSON.stringify(text)})`;
    const face = options.fontCatalog?.get(mobileFontKey(run));
    result += `.font(.custom(${JSON.stringify(face?.postscriptName ?? run.fontFamily ?? "Inter")}, size: ${n(run.fontSize ?? 16)}, relativeTo: .body)${face ? "" : `.weight(${swiftWeight(run.weight ?? run.fontWeight)})`})`;
    result += `.foregroundColor(${swiftColor(run.fill ?? "#000000")})`;
    if (run.letterSpacing != null) result += `.tracking(${n(run.letterSpacing)})`;
    if (!face && (run.italic || run.fontStyle === "italic")) result += ".italic()";
    if (run.underline) result += ".underline()";
    if (run.strikethrough) result += ".strikethrough()";
    return result;
  }).join(" + ");
}

function swiftGeometry(node, parentLayout, afterFrame = "") {
  if (node.type === "text" && ["auto", "fixed-width"].includes(node.layout.textGrowth)) {
    const sizing = node.layout.textGrowth === "auto"
      ? ".fixedSize(horizontal: true, vertical: true)"
      : `.frame(width: ${n(node.geometry.w)}, alignment: .topLeading).fixedSize(horizontal: false, vertical: true)`;
    return ["grid", "horizontal", "vertical", "wrap"].includes(parentLayout)
      ? sizing
      : `${sizing}.offset(x: ${n(node.geometry.localX)}, y: ${n(node.geometry.localY)})`;
  }
  const base = `.frame(width: ${n(node.geometry.w)}, height: ${n(node.geometry.h)}, alignment: ${swiftFrameAlignment(node)})${afterFrame}`;
  if (["grid", "horizontal", "vertical", "wrap"].includes(parentLayout)) return base;
  return `${base}.position(x: ${n(node.geometry.localX + node.geometry.w / 2)}, y: ${n(node.geometry.localY + node.geometry.h / 2)})`;
}

function swiftAccessibility(node) {
  if (node.semantics.decorative) return ".accessibilityRepresentation { EmptyView() }.accessibilityHidden(true)";
  let value = node.semantics.description ? `.accessibilityLabel(${JSON.stringify(node.semantics.description)})` : "";
  if (node.type === "text" && node.semantics.paragraphs.some((paragraph) => paragraph.headingLevel)) value += ".accessibilityAddTraits(.isHeader)";
  return value;
}

function composeScreen(output, options) {
  const children = groupChildren(output.nodes);
  const root = output.root ?? rootNode(output);
  return `package generated.canvas\n\nimport android.graphics.BitmapFactory\nimport android.util.Base64\nimport androidx.compose.foundation.Image\nimport androidx.compose.foundation.Canvas\nimport androidx.compose.foundation.background\nimport androidx.compose.foundation.layout.*\nimport androidx.compose.foundation.lazy.grid.GridCells\nimport androidx.compose.foundation.lazy.grid.LazyVerticalGrid\nimport androidx.compose.foundation.shape.CircleShape\nimport androidx.compose.foundation.shape.RoundedCornerShape\nimport androidx.compose.material3.Text\nimport androidx.compose.runtime.Composable\nimport androidx.compose.ui.Modifier\nimport androidx.compose.ui.draw.alpha\nimport androidx.compose.ui.graphics.Color\nimport androidx.compose.ui.graphics.Path\nimport androidx.compose.ui.graphics.PathFillType\nimport androidx.compose.ui.graphics.asImageBitmap\nimport androidx.compose.ui.semantics.clearAndSetSemantics\nimport androidx.compose.ui.semantics.contentDescription\nimport androidx.compose.ui.semantics.heading\nimport androidx.compose.ui.semantics.semantics\nimport androidx.compose.ui.text.SpanStyle\nimport androidx.compose.ui.text.buildAnnotatedString\nimport androidx.compose.ui.text.withStyle\nimport androidx.compose.ui.text.font.FontStyle\nimport androidx.compose.ui.text.font.FontWeight\nimport androidx.compose.ui.text.style.TextDecoration\nimport androidx.compose.ui.unit.dp\nimport androidx.compose.ui.unit.em\nimport androidx.compose.ui.unit.sp\n\n@OptIn(ExperimentalLayoutApi::class)\n@Composable fun ${sourceName(output.name)}() {\n${composeContainer(root, orderedChildren(root, children), children, options, 1, true)}\n}\n`;
}

function composeNode(node, children, options, depth, parentLayout) {
  if (node.capability.verdict === "ignore") return "";
  const indent = "  ".repeat(depth);
  const modifier = composeModifier(node, parentLayout);
  if (node.capability.verdict === "raster") {
    const data = options.rasterData?.(node.id);
    if (!data) throw new Error(`Compose rasterizer is required for ${node.id}.`);
    const name = `bytes${identifier(node.id)}`;
    return `${indent}run { val ${name} = Base64.decode(${JSON.stringify(data)}, Base64.DEFAULT); Image(BitmapFactory.decodeByteArray(${name}, 0, ${name}.size).asImageBitmap(), null, ${modifier}) }`;
  }
  if (node.type === "text") return `${indent}Text(${composeText(node, options)}, style = androidx.compose.ui.text.TextStyle(fontSize = ${n(composeBaseFontSize(node.semantics.runs))}.sp, letterSpacing = 0.sp, textMotion = androidx.compose.ui.text.style.TextMotion.Animated), modifier = ${modifier}.alpha(${kotlinFloat(node.paint.opacity ?? 1)}))`;
  if (node.vector) return `${indent}${composeVector(node, modifier)}`;
  const descendants = orderedChildren(node, children);
  if (descendants.length || ["frame", "group", "ref"].includes(node.type)) return composeContainer(node, descendants, children, options, depth, false, modifier);
  if (node.type === "ellipse") return `${indent}Canvas(modifier = ${modifier}.alpha(${kotlinFloat(node.paint.opacity ?? 1)})) { drawOval(color = ${composeColor(solid(node.paint.fill))}) }`;
  const shape = composeRoundedShape(node);
  return `${indent}Spacer(${modifier}.alpha(${kotlinFloat(node.paint.opacity ?? 1)}).background(${composeColor(solid(node.paint.fill))}, ${shape}))`;
}

function composeVector(node, modifier) {
  const statements = scaledVectorCommands(node.vector, node.geometry.w, node.geometry.h).map((command) => {
    if (command.type === "move") return `moveTo(${kotlinFloat(command.x)}, ${kotlinFloat(command.y)})`;
    if (command.type === "line") return `lineTo(${kotlinFloat(command.x)}, ${kotlinFloat(command.y)})`;
    if (command.type === "cubic") return `cubicTo(${kotlinFloat(command.c1x)}, ${kotlinFloat(command.c1y)}, ${kotlinFloat(command.c2x)}, ${kotlinFloat(command.c2y)}, ${kotlinFloat(command.x)}, ${kotlinFloat(command.y)})`;
    return "close()";
  }).join("; ");
  const fillType = node.vector.fillRule === "evenodd" ? "PathFillType.EvenOdd" : "PathFillType.NonZero";
  const stroke = mobileVectorStroke(node);
  const clip = stroke && stroke.align !== "center" ? ` drawContext.canvas.clipPath(path, androidx.compose.ui.graphics.ClipOp.${stroke.align === "inside" ? "Intersect" : "Difference"});` : "";
  const strokeDraw = stroke ? `${clip} drawPath(path, ${composeColor(stroke.color)}, style = androidx.compose.ui.graphics.drawscope.Stroke(width = ${kotlinFloat(stroke.width * (stroke.align === "center" ? 1 : 2))}, cap = androidx.compose.ui.graphics.StrokeCap.${{ butt: "Butt", round: "Round", square: "Square" }[stroke.cap]}, join = androidx.compose.ui.graphics.StrokeJoin.${{ miter: "Miter", round: "Round", bevel: "Bevel" }[stroke.join]}${stroke.dash.length ? `, pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(${stroke.dash.map(kotlinFloat).join(", ")}))` : ""}));` : "";
  const opacity = node.paint.opacity ?? 1;
  const layer = opacity < 1 ? ` drawContext.canvas.saveLayer(path.getBounds().inflate(${kotlinFloat((stroke?.width ?? 0) * 4 + 1)}), androidx.compose.ui.graphics.Paint().apply { alpha = ${kotlinFloat(opacity)} });` : "";
  return `Canvas(modifier = ${modifier}) { val path = Path().apply { fillType = ${fillType}; ${statements} }; drawContext.canvas.save(); drawContext.canvas.scale(size.width / ${kotlinFloat(node.geometry.w)}, size.height / ${kotlinFloat(node.geometry.h)});${layer} drawPath(path, ${composeColor(solid(node.paint.fill))});${strokeDraw}${layer ? " drawContext.canvas.restore();" : ""} drawContext.canvas.restore() }`;
}

function mobileVectorStroke(node) {
  const stroke = node.paint.stroke;
  if (!stroke) return null;
  const color = solid(stroke.fill ?? stroke.color);
  const width = Number(stroke.width ?? stroke.thickness ?? 1);
  if (!color || !Number.isFinite(width) || width < 0) throw new Error(`Mobile vector stroke for ${node.id} requires a solid color and finite non-negative width.`);
  if (!width) return null;
  const align = stroke.align ?? "center";
  if (!["center", "inside", "outside"].includes(align)) throw new Error(`Unsupported mobile vector stroke alignment for ${node.id}.`);
  const dash = normalizeStrokeDash(stroke.dash ?? stroke.dashPattern);
  const cap = stroke.cap ?? "butt"; const join = stroke.join ?? "miter";
  if (!["butt", "round", "square"].includes(cap) || !["miter", "round", "bevel"].includes(join)) throw new Error(`Unsupported mobile vector cap or join for ${node.id}.`);
  return { color, width, cap, join, dash, align };
}

function composeContainer(node, descendants, children, options, depth, root = false, suppliedModifier = "Modifier") {
  const indent = "  ".repeat(depth);
  const { row, column } = mobileGaps(node);
  const content = descendants.map((child) => composeNode(child, children, options, depth + 1, node.layout.layout || (node.layout.wrap ? "wrap" : "none"))).filter(Boolean).join("\n");
  let modifier = root ? composeModifier(node, "vertical") : suppliedModifier;
  if (node.paint.opacity != null) modifier += `.alpha(${kotlinFloat(node.paint.opacity)})`;
  if (solid(node.paint.fill)) modifier += `.background(${composeColor(solid(node.paint.fill))}${node.paint.cornerRadius != null ? `, ${composeRoundedShape(node)}` : ""})`;
  const insets = mobilePadding(node);
  if (insets) modifier += `.padding(start = ${n(insets[3])}.dp, top = ${n(insets[0])}.dp, end = ${n(insets[1])}.dp, bottom = ${n(insets[2])}.dp)`;
  if (node.layout.layout === "grid") {
    const columns = Math.max(1, node.layout.gridTemplateColumns?.length ?? 1);
    return `${indent}LazyVerticalGrid(columns = GridCells.Fixed(${columns}), modifier = ${modifier}, horizontalArrangement = Arrangement.spacedBy(${column}.dp), verticalArrangement = Arrangement.spacedBy(${row}.dp)) {\n${descendants.map((child) => `${indent}  item {\n${composeNode(child, children, options, depth + 2, "grid")}\n${indent}  }`).join("\n")}\n${indent}}`;
  }
  if (node.layout.wrap) return `${indent}FlowRow(modifier = ${modifier}, horizontalArrangement = Arrangement.spacedBy(${column}.dp), verticalArrangement = Arrangement.spacedBy(${row}.dp)) {\n${content}\n${indent}}`;
  if (node.layout.layout === "horizontal") return `${indent}Row(modifier = ${modifier}, horizontalArrangement = Arrangement.spacedBy(${column}.dp), verticalAlignment = androidx.compose.ui.Alignment.${node.layout.alignItems === "end" ? "Bottom" : node.layout.alignItems === "center" ? "CenterVertically" : "Top"}) {\n${content}\n${indent}}`;
  if (node.layout.layout === "vertical") return `${indent}Column(modifier = ${modifier}, verticalArrangement = Arrangement.spacedBy(${row}.dp), horizontalAlignment = androidx.compose.ui.Alignment.${node.layout.alignItems === "end" ? "End" : node.layout.alignItems === "center" ? "CenterHorizontally" : "Start"}) {\n${content}\n${indent}}`;
  return `${indent}Box(modifier = ${modifier}) {\n${content}\n${indent}}`;
}

function composeBaseFontSize(runs) {
  const first = runs[0]?.fontSize ?? 16;
  // A hidden zero-size first run cannot be the relative-size denominator.
  return first === 0 ? (runs.map(run => run.fontSize ?? 16).find(size => size > 0) ?? first) : first;
}

function composeText(node, options) {
  const runs = node.semantics.runs.length ? node.semantics.runs : [{ from: 0, to: node.semantics.content.length }];
  // Absolute-size spans round to whole pixels. Relative spans preserve the
  // floating-point size; deriving the ratio in pixels also retains Android's
  // nonlinear font-scale conversion for each authored sp size.
  const baseSize = composeBaseFontSize(runs);
  const mixedSizes = runs.some(run => (run.fontSize ?? 16) !== baseSize);
  const body = runs.map((run, index) => {
    const decorations = [run.underline ? "TextDecoration.Underline" : null, run.strikethrough ? "TextDecoration.LineThrough" : null].filter(Boolean);
    const style = [`color = ${composeColor(run.fill ?? "#000000")}`, (run.fontSize ?? 16) !== baseSize ? `fontSize = with(canvasDensity) { (${n(run.fontSize ?? 16)}.sp.toPx() / ${n(baseSize)}.sp.toPx()).em }` : null, `fontWeight = FontWeight(${Number(run.weight ?? run.fontWeight ?? 400)})`, run.letterSpacing != null ? `letterSpacing = ${n(run.letterSpacing)}.sp` : null, (run.italic || run.fontStyle === "italic") ? "fontStyle = FontStyle.Italic" : null, decorations.length ? `textDecoration = ${decorations.length === 1 ? decorations[0] : `TextDecoration.combine(listOf(${decorations.join(", ")}))`}` : null].filter(Boolean).join(", ");
    return `withStyle(SpanStyle(${style}${options.fontCatalog?.size ? `, fontFamily = canvasFont${index}` : ""})) { append(${JSON.stringify(node.semantics.content.slice(run.from, run.to))}) }`;
  }).join("; ");
  const expression = `buildAnnotatedString { ${body} }`;
  const declarations = [mixedSizes ? "val canvasDensity = androidx.compose.ui.platform.LocalDensity.current" : null,
    ...(options.fontCatalog?.size ? runs.map((run, index) => `val canvasFont${index} = CanvasFonts.family(${JSON.stringify(mobileFontKey(run))})`) : [])].filter(Boolean);
  return declarations.length ? `run { ${declarations.join("; ")}; ${expression} }` : expression;
}

function composeModifier(node, parentLayout) {
  let value = "Modifier";
  // Lazy grids impose the cell width as a minimum. Keep the authored child
  // dimensions inside that cell instead of stretching e.g. a circle to a pill.
  if (parentLayout === "grid") value += ".wrapContentSize(androidx.compose.ui.Alignment.TopStart)";
  if (!["grid", "horizontal", "vertical", "wrap"].includes(parentLayout)) value += `.offset(${n(node.geometry.localX)}.dp, ${n(node.geometry.localY)}.dp)`;
  if (node.type === "text" && node.layout.textGrowth === "auto") value += ".wrapContentSize(androidx.compose.ui.Alignment.TopStart, unbounded = true)";
  else if (node.type === "text" && node.layout.textGrowth === "fixed-width") value += `.width(${n(node.geometry.w)}.dp).wrapContentHeight(androidx.compose.ui.Alignment.Top, unbounded = true)`;
  else value += `.size(${n(node.geometry.w)}.dp, ${n(node.geometry.h)}.dp)`;
  if (node.semantics.decorative) return `${value}.clearAndSetSemantics { }`;
  if (node.semantics.description) value += `.semantics { contentDescription = ${JSON.stringify(node.semantics.description)} }`;
  if (node.type === "text" && node.semantics.paragraphs.some((paragraph) => paragraph.headingLevel)) value += ".semantics { heading() }";
  return value;
}

function groupChildren(nodes) { const map = new Map(); for (const node of nodes) { const list = map.get(node.parent) ?? []; list.push(node); map.set(node.parent, list); } return map; }
function orderedChildren(node, children) { return children.get(node.id) ?? []; }
function rootNode(output) { return { id: output.id, type: "frame", geometry: { x: 0, y: 0, localX: 0, localY: 0, w: output.width, h: output.height }, paint: {}, semantics: {}, layout: {} }; }
function sourceName(value) { const name = String(value).normalize("NFC").replace(/[^A-Za-z0-9]+/gu, " ").trim().split(/\s+/u).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(""); if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) throw new Error(`Frame name ${value} is not a safe source identifier.`); return name; }
function identifier(value) { const result = String(value).replace(/[^A-Za-z0-9]/gu, ""); return result ? result[0].toUpperCase() + result.slice(1) : "Raster"; }
function n(value) { return Number(Number(value).toFixed(3)); }
function kotlinFloat(value) { const rounded = Number(Number(value).toFixed(3)); return Number.isInteger(rounded) ? `${rounded}.0f` : `${rounded}f`; }
function solid(fill) {
  if (Array.isArray(fill)) {
    const active = fill.filter((paint) => paint?.enabled !== false);
    if (active.length > 1) throw new Error("Mobile multi-paint emission is not implemented.");
    return solid(active[0]);
  }
  if (fill?.enabled === false) return null;
  return typeof fill === "string" || typeof fill?.color === "string" ? fill : null;
}
function swiftColor(value) { const rgba = rgbaHex(value); return `Color(red: ${rgba.r}, green: ${rgba.g}, blue: ${rgba.b}, opacity: ${rgba.a})`; }
function composeColor(value) { return `Color(0x${rgbaHex(value).argb})`; }
function rgbaHex(value) {
  const paint = value && typeof value === "object" ? value : null;
  const color = paint?.color ?? value ?? "transparent";
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(color);
  let rgba;
  if (match) {
    const hex = match[1].length <= 4 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
    const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
    rgba = { r: channels[0], g: channels[1], b: channels[2], a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1 };
  } else rgba = color === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : parseCssColor(color);
  const opacity = paint?.opacity ?? 1;
  if (!rgba || Object.values(rgba).some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 1) || typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error("Mobile solid color or paint opacity cannot be emitted faithfully.");
  rgba.a *= opacity;
  const byte = (channel) => Math.round(channel * 255).toString(16).padStart(2, "0").toUpperCase();
  return { r: n(rgba.r), g: n(rgba.g), b: n(rgba.b), a: n(rgba.a), argb: [rgba.a, rgba.r, rgba.g, rgba.b].map(byte).join("") };
}
function swiftWeight(weight) { const value = Number(weight ?? 400); if (value >= 700) return ".bold"; if (value >= 600) return ".semibold"; if (value >= 500) return ".medium"; return ".regular"; }
function swiftAlignment(value) { return value === "end" ? ".bottom" : value === "center" ? ".center" : ".top"; }
function swiftHorizontalAlignment(value) { return value === "end" ? ".trailing" : value === "center" ? ".center" : ".leading"; }
function swiftFrameAlignment(node) {
  // A stack aligns its children within its intrinsic extent. Its surrounding
  // authored-size frame must align that extent on the same cross axis too.
  if (!node.layout.wrap && node.layout.layout === "vertical") return node.layout.alignItems === "end" ? ".topTrailing" : node.layout.alignItems === "center" ? ".top" : ".topLeading";
  if (!node.layout.wrap && node.layout.layout === "horizontal") return node.layout.alignItems === "end" ? ".bottomLeading" : node.layout.alignItems === "center" ? ".leading" : ".topLeading";
  return ".topLeading";
}
function mobileGaps(node) {
  const row = Number(node.layout.rowGap ?? node.layout.gap ?? 0);
  const column = Number(node.layout.columnGap ?? node.layout.gap ?? 0);
  if (![row, column].every(Number.isFinite)) throw new Error(`Mobile gaps for ${node.id} must resolve to finite numbers.`);
  return { row: n(row), column: n(column) };
}

function composeRoundedShape(node) {
  const vector = roundedRectangleVector(node);
  const commands = scaledVectorCommands(vector, 1, 1).map((command) => {
    const fraction = (value) => `${Number(value).toFixed(9)}f`;
    const x = (value) => `${fraction(value)} * size.width`;
    const y = (value) => `${fraction(value)} * size.height`;
    if (command.type === "move") return `moveTo(${x(command.x)}, ${y(command.y)})`;
    if (command.type === "line") return `lineTo(${x(command.x)}, ${y(command.y)})`;
    if (command.type === "cubic") return `cubicTo(${x(command.c1x)}, ${y(command.c1y)}, ${x(command.c2x)}, ${y(command.c2y)}, ${x(command.x)}, ${y(command.y)})`;
    return "close()";
  }).join("; ");
  return `androidx.compose.foundation.shape.GenericShape { size, _ -> ${commands} }`;
}

function mobilePadding(node) {
  if (node.layout.padding === undefined || (!node.layout.wrap && !["horizontal", "vertical", "grid"].includes(node.layout.layout))) return null;
  const values = Array.isArray(node.layout.padding) ? node.layout.padding : [node.layout.padding];
  if (values.length < 1 || values.length > 4 || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error(`Mobile padding for ${node.id} must resolve to one through four finite non-negative numbers.`);
  const [top, right = top, bottom = top, left = right] = values;
  return [top, right, bottom, left];
}

const swiftFlowHelper = `import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
public struct CanvasRasterImage: View { let base64: String; public init(base64: String) { self.base64 = base64 }; @ViewBuilder public var body: some View {
#if canImport(UIKit)
 if let data = Data(base64Encoded: base64), let image = UIImage(data: data) { Image(uiImage: image).resizable() }
#elseif canImport(AppKit)
 if let data = Data(base64Encoded: base64), let image = NSImage(data: data) { Image(nsImage: image).resizable() }
#endif
} }
public struct FlowLayout: Layout {
 public let spacing: CGFloat
 public let rowSpacing: CGFloat
 public init(spacing: CGFloat = 0, rowSpacing: CGFloat? = nil) { self.spacing = spacing; self.rowSpacing = rowSpacing ?? spacing }
 private func arrange(width: CGFloat, subviews: Subviews) -> (positions: [CGPoint], sizes: [CGSize], height: CGFloat) {
  var positions: [CGPoint] = []; var sizes: [CGSize] = []
  var x: CGFloat = 0; var y: CGFloat = 0; var row: CGFloat = 0
  for view in subviews {
   let size = view.sizeThatFits(.unspecified)
   if x > 0 && x + size.width > width { x = 0; y += row + rowSpacing; row = 0 }
   positions.append(CGPoint(x: x, y: y)); sizes.append(size)
   x += size.width + spacing; row = max(row, size.height)
  }
  return (positions, sizes, y + row)
 }
 public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
  let width = proposal.width ?? subviews.reduce(CGFloat(0)) { $0 + $1.sizeThatFits(.unspecified).width } + CGFloat(max(0, subviews.count - 1)) * spacing
  return CGSize(width: width, height: arrange(width: width, subviews: subviews).height)
 }
 public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
  let layout = arrange(width: bounds.width, subviews: subviews)
  for index in subviews.indices { subviews[index].place(at: CGPoint(x: bounds.minX + layout.positions[index].x, y: bounds.minY + layout.positions[index].y), proposal: ProposedViewSize(layout.sizes[index])) }
 }
}
`;
const composeFlowHelper = `package generated.canvas\nimport androidx.compose.foundation.layout.ExperimentalLayoutApi\nimport androidx.compose.foundation.layout.FlowRow\nimport androidx.compose.runtime.Composable\n@OptIn(ExperimentalLayoutApi::class)\n@Composable fun CanvasFlowLayout(content: @Composable () -> Unit) { FlowRow { content() } }\n`;
