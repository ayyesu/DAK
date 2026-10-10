import { materialize, restoreDocumentModel } from "./document-model.mjs";
import { prepareAssetForRendering } from "./document-assets.mjs";

export async function loadCanvasImports(api, document, options = {}) {
  const assets = new Map();
  const load = async (owner, trail, prefix) => {
    const imports = {};
    for (const [alias, record] of Object.entries(owner.imports ?? {})) {
      if (!record?.documentId) throw importError(`Import ${alias} has no documentId.`);
      if (trail.includes(record.documentId)) {
        throw importError(`Import cycle: ${[...trail, record.documentId].join(" -> ")}.`);
      }
      const payload = await api.getDocument(record.documentId);
      const revision = authoritativeSequence(payload);
      if (record.pin === "exact" && revision !== record.version) {
        throw importError(`Import ${alias} pins ${record.documentId} at revision ${record.version}, but revision ${revision} was loaded.`);
      }
      const model = restoreDocumentModel(payload);
      let imported;
      try { imported = materialize(model); }
      finally { model.doc.destroy(); }
      const ownedPrefix = [prefix, "imports", alias].filter(Boolean).join("/");
      for (const asset of payload.assets ?? []) {
        const key = `${ownedPrefix}/${asset.path}`;
        assets.set(key, await prepareAssetForRendering(
          { ...asset, path: key, bytes: await api.readAsset(record.documentId, asset) },
          options.rasterizeSvg,
        ));
      }
      imports[alias] = {
        document: imported,
        imports: await load(imported, [...trail, record.documentId], ownedPrefix),
      };
    }
    return imports;
  };
  return {
    imports: await load(document, options.rootDocumentId ? [options.rootDocumentId] : [], ""),
    assets,
  };
}

function authoritativeSequence(payload) {
  return Math.max(
    Number(payload.snapshot?.throughSequence ?? 0),
    ...(payload.updates ?? []).map((update) => Number(update.sequence ?? 0)),
  );
}

function importError(message) {
  const error = new Error(message);
  error.code = "CANVAS_IMPORT_INVALID";
  return error;
}
