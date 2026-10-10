/** Build the same minimal valid document for UI and operation-driven creation. */
export function createBlankDocumentSource({ id = crypto.randomUUID(), module = "generic", preset: presetName } = {}) {
  let preset = modulePreset(module);
  if (presetName !== undefined) {
    if (module !== "generic" || !["a4", "letter"].includes(presetName)) throw new Error("A4 and Letter are generic blank-document presets.");
    preset = presetName === "a4"
      ? { name: "A4", width: 794, height: 1123, physical: { w: 210, h: 297, unit: "mm" } }
      : { name: "Letter", width: 816, height: 1056, physical: { w: 8.5, h: 11, unit: "in" } };
  }
  return {
    module,
    axes: {},
    variables: {},
    paragraphStyles: {},
    imports: {},
    flows: [],
    children: [
      {
        id,
        type: "frame",
        name: preset.name,
        x: 120,
        y: 100,
        width: preset.width,
        height: preset.height,
        ...(preset.role ? { role: preset.role } : {}),
        ...(preset.size ? { size: preset.size } : {}),
        ...(preset.physical ? { physical: preset.physical } : {}),
        fill: "#ffffff",
        children: [],
      },
    ],
  };
}

function modulePreset(module) {
  if (module === "generic") return { name: "Frame 1", width: 720, height: 480 };
  if (module === "deck") return { name: "Slide 1", width: 1280, height: 720, role: "slide", size: "widescreen", physical: { w: 13.333, h: 7.5, unit: "in" } };
  if (module === "mobile") return { name: "Screen", width: 393, height: 852, role: "ios", size: "iphone" };
  if (module === "web") return { name: "Home", width: 720, height: 480, role: "route" };
  throw new Error(`Unknown Canvas module ${module}.`);
}
