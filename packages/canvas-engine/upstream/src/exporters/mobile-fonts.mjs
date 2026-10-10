import { createHash } from "node:crypto";
import fontkit from "@pdf-lib/fontkit";

export function mobileFontKey(run) {
  return `${run.fontFamily ?? "Inter"}:${Number(run.weight ?? run.fontWeight ?? 400)}:${run.italic || run.fontStyle === "italic" ? "italic" : "normal"}`;
}

export function mobileFontCatalog(ir, sources) {
  const catalog = new Map();
  for (const output of ir.outputs) for (const node of output.nodes) {
    if (node.type !== "text" || node.capability.verdict !== "native") continue;
    for (const run of node.semantics.runs) {
      const key = mobileFontKey(run);
      if (catalog.has(key)) continue;
      const bytes = sources[key] ?? (key.endsWith(":normal") ? sources[key.slice(0, -7)] : undefined);
      if (!bytes) {
        const error = new Error(`Mobile export needs an embeddable exact font face for ${key}.`);
        error.code = "CANVAS_MOBILE_FONT_MISSING";
        throw error;
      }
      const font = fontkit.create(bytes);
      if (!font.postscriptName) throw new Error(`Mobile font ${key} has no PostScript name.`);
      const weight = Number(run.weight ?? run.fontWeight ?? 400);
      const italic = key.endsWith(":italic");
      const selection = font["OS/2"]?.fsSelection;
      // OpenType name ID 1 may split a family into four-style legacy groups.
      // ID 16 declares the full typographic family (e.g. Inter Medium → Inter).
      const families = new Set([font.familyName, ...Object.values(font.name?.records?.preferredFamily ?? {})]);
      if (!families.has(run.fontFamily ?? "Inter") || font["OS/2"]?.usWeightClass !== weight
        || Boolean(selection?.italic || selection?.oblique) !== italic) {
        const error = new Error(`Supplied mobile font bytes do not match the requested face ${key}.`);
        error.code = "CANVAS_MOBILE_FONT_MISMATCH";
        throw error;
      }
      const filename = `${createHash("sha256").update(bytes).digest("hex")}.ttf`;
      catalog.set(key, { bytes, filename, postscriptName: font.postscriptName, weight, italic });
    }
  }
  return catalog;
}

export function addMobileFontFiles(files, catalog, platform) {
  if (!catalog.size) return;
  const directory = platform === "ios" ? "Fonts" : "assets/fonts";
  for (const face of catalog.values()) files.set(`${directory}/${face.filename}`, face.bytes);
  if (platform === "ios") {
    files.set("_canvas/CanvasFonts.swift", `import Foundation\nimport CoreText\n\nenum CanvasFonts {\n  private static let registered: Void = {\n    let names = ${JSON.stringify([...new Set([...catalog.values()].map((face) => face.filename))])}\n    for name in names {\n      guard let url = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "Fonts") ?? Bundle.main.url(forResource: name, withExtension: nil) else { preconditionFailure("Missing exported Canvas font: \\(name)") }\n      var error: Unmanaged<CFError>?\n      if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {\n        guard let value = error?.takeRetainedValue(), CFErrorGetCode(value) == CTFontManagerError.alreadyRegistered.rawValue else { preconditionFailure("Cannot register exported Canvas font: \\(name)") }\n      }\n    }\n  }()\n  static func register() { _ = registered }\n}\n`);
    files.set("FONT-INTEGRATION.md", "# Bundled fonts\n\nAdd the generated Swift sources and all files in Fonts to the app target. Include Fonts in Copy Bundle Resources (a preserved Fonts folder or flattened resource files both work). Generated view initializers register the packaged faces before use. No system-wide installation or font subscription is required.\n");
  } else {
    const cases = [...catalog].map(([key, face]) => `      ${JSON.stringify(key)} -> FontFamily(Font(path = ${JSON.stringify(`fonts/${face.filename}`)}, assetManager = assets, weight = FontWeight(${face.weight}), style = FontStyle.${face.italic ? "Italic" : "Normal"}))`).join("\n");
    files.set("_canvas/CanvasFonts.kt", `package generated.canvas\n\nimport androidx.compose.runtime.Composable\nimport androidx.compose.runtime.remember\nimport androidx.compose.ui.platform.LocalContext\nimport androidx.compose.ui.text.font.Font\nimport androidx.compose.ui.text.font.FontFamily\nimport androidx.compose.ui.text.font.FontStyle\nimport androidx.compose.ui.text.font.FontWeight\n\ninternal object CanvasFonts {\n  @Composable fun family(key: String): FontFamily {\n    val assets = LocalContext.current.assets\n    return remember(assets, key) { when (key) {\n${cases}\n      else -> error("Unknown exported Canvas font: $key")\n    } }\n  }\n}\n`);
    files.set("FONT-INTEGRATION.md", "# Bundled fonts\n\nAdd generated Kotlin sources to your Android source set and copy the contents of assets into src/main/assets. Generated text loads the packaged exact font faces through Android AssetManager; no network font provider or system font installation is used.\n");
  }
}
