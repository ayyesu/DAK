const policies = Object.freeze({
  slide: Object.freeze([{ name: "1x", ppi: 96, scale: 1 }]),
  route: Object.freeze([{ name: "1x", ppi: 96, scale: 1 }, { name: "2x", ppi: 192, scale: 2 }, { name: "3x", ppi: 288, scale: 3 }]),
  ios: Object.freeze([{ name: "@2x", ppi: 192, scale: 2 }, { name: "@3x", ppi: 288, scale: 3 }]),
  android: Object.freeze([
    { name: "ldpi", ppi: 120, scale: 0.75 }, { name: "mdpi", ppi: 160, scale: 1 },
    { name: "hdpi", ppi: 240, scale: 1.5 }, { name: "xhdpi", ppi: 320, scale: 2 },
    { name: "xxhdpi", ppi: 480, scale: 3 }, { name: "xxxhdpi", ppi: 640, scale: 4 },
  ]),
});

export function rasterPolicyFor(role) {
  const variants = policies[role];
  if (!variants) {
    const error = new Error(`Raster policy is not defined for ${String(role)}.`);
    error.code = "CANVAS_RASTER_POLICY_UNDEFINED";
    throw error;
  }
  return variants.map((variant) => ({ ...variant }));
}

export function skiaBlurKernelRadius(radius) {
  const value = Number(radius ?? 0);
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Effect radius must be a non-negative number.");
  return value / 2 <= 0.03 ? 0 : Math.ceil(3 * value / 2);
}

export function effectOutset(effects) {
  const outset = { left: 0, top: 0, right: 0, bottom: 0 };
  for (const effect of (Array.isArray(effects) ? effects : [effects]).filter(Boolean)) {
    const type = effect.type === "backgroundBlur" ? "background_blur" : String(effect.type ?? "").toLowerCase();
    if (type === "background_blur" || effect.shadowType === "inner" || effect.inner === true) continue;
    const kernel = skiaBlurKernelRadius(effect.radius ?? effect.blur ?? 0);
    if (["blur", "layer_blur", "foreground_blur"].includes(type)) {
      for (const side of ["left", "top", "right", "bottom"]) outset[side] = Math.max(outset[side], kernel);
      continue;
    }
    if (type !== "shadow" && type !== "drop_shadow") continue;
    const spread = Number(effect.spread ?? 0);
    const dx = Number(effect.offset?.x ?? effect.offsetX ?? 0);
    const dy = Number(effect.offset?.y ?? effect.offsetY ?? 0);
    outset.left = Math.max(outset.left, kernel + spread - dx, 0);
    outset.right = Math.max(outset.right, kernel + spread + dx, 0);
    outset.top = Math.max(outset.top, kernel + spread - dy, 0);
    outset.bottom = Math.max(outset.bottom, kernel + spread + dy, 0);
  }
  return outset;
}
