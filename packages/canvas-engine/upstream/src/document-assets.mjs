export async function hydrateDocumentAssets(api, documentId, descriptors = [], current = new Map(), dependencies = {}) {
  const assets = current;
  const rasterizeSvg = dependencies.rasterizeSvg;
  let changed = false;
  const changedPaths = new Set();
  const failures = [];
  const retainedPaths = new Set(descriptors.map((descriptor) => descriptor.path));
  for (const path of assets.keys()) {
    if (retainedPaths.has(path)) continue;
    assets.delete(path);
    changed = true;
    changedPaths.add(path);
  }
  await Promise.all(descriptors.map(async (descriptor) => {
    const existing = assets.get(descriptor.path);
    if (
      existing?.bytes
      && existing.sha256 === descriptor.sha256
      && Number(existing.size ?? existing.bytes.byteLength) === Number(descriptor.size)
    ) return;
    try {
      const bytes = await api.readAsset(documentId, descriptor);
      assets.set(descriptor.path, await prepareAssetForRendering({ ...descriptor, bytes }, rasterizeSvg));
      changed = true;
      changedPaths.add(descriptor.path);
    } catch (error) {
      failures.push({ descriptor, error });
    }
  }));
  return { assets, changed, changedPaths, failures };
}

export function isSvgAsset(asset) {
  return asset?.mimeType === "image/svg+xml" || /\.svg$/iu.test(asset?.path ?? "");
}

export async function prepareAssetForRendering(asset, rasterizeSvg) {
  if (!rasterizeSvg || !isSvgAsset(asset)) return asset;
  return { ...asset, renderBytes: await rasterizeSvg(asset.bytes) };
}

export function hasUnloadedDocumentImages(document, assets) {
  let missing = false;
  visit(document, (value) => {
    if (
      value?.type === "image"
      && typeof value.url === "string"
      && !assets.has(value.url)
    ) missing = true;
  });
  return missing;
}

function visit(value, visitor) {
  if (missingValue(value)) return;
  visitor(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    visit(child, visitor);
  }
}

function missingValue(value) {
  return value === null || typeof value !== "object";
}
