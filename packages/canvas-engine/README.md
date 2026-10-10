# Canvas engine

The Canvas design engine, vendored from
[penkrahq/penkra-apps](https://github.com/penkrahq/penkra-apps) under `canvas/`.

Canvas is a Penkra App, not a library, so only part of it is reusable inside DAK. This holds the
subset DAK executes: the document schema and its semantic validation, the Yjs document model, the
QuickJS script sandbox, document inspection and review, screenshots, and the export pipeline.

`upstream/` is generated. Do not edit it. Every file's SHA-256 is recorded in
`upstream/vendor-manifest.json`, and `node scripts/canvas-vendor.ts check` fails on a modified,
added, or missing file. To move to a newer Canvas, re-run the sync command and read the diff.

The subset is resolved from real import statements starting at `CANVAS_ENTRY_POINTS` in
[`scripts/canvas-vendor.ts`](../../scripts/canvas-vendor.ts), not from a hand-maintained list.
Excluded on purpose, with reasons recorded in the manifest: upstream's tests, its Penkra operation
layer, its Vue editor, its research recordings, and the 10.5 MB colour emoji font. A document that
needs a font DAK does not ship fails as `unknown_font` rather than rendering with a silent fallback.

## Running it

The engine runs on the DAK **server**, in Node — that is where its `node:` imports, its QuickJS
sandbox, and its CanvasKit renderer belong. DAK wraps it in `apps/server/src/canvas/CanvasEngineLive.ts`
and never exposes the `.mjs` modules to a client bundle.

Its dependencies are declared here so `pnpm install` fetches them. One asset needs a step of its own:
upstream's build places `canvaskit.wasm` beside `src/document-screenshot.mjs`, and this snapshot has
no build. `scripts/place-canvaskit.mjs` runs from this package's `prepare` script and hard-links (or
copies) the WASM into place, so a plain install is enough. The file is generated, not vendored: it is
ignored by `.gitignore`, by `canvas-vendor.ts check`, and by the size budgets. Without it, screenshots
and raster exports fail with `CANVAS_SCREENSHOT_RUNTIME_UNAVAILABLE` and the agent loses its review
loop.

### Exports on Windows

The exporter asserts an absolute POSIX path and rejects a Windows drive letter, so
`CanvasEngineLive` converts destinations through the extended-length form Windows accepts
(`//?/C:/…`) and converts the reported artifacts back. This is done at the adapter boundary because
the engine's check cannot be relaxed without editing vendored code; the caller still sees and passes
ordinary platform paths.

## Licensing

Canvas is MIT. Everything it bundles is permissive: MIT, ISC, BSD-3-Clause, Apache-2.0, and the
SIL Open Font License. `upstream/THIRD_PARTY_NOTICES.md` and `upstream/licenses/` are copied
verbatim from upstream and travel with the code they cover.

## Size

The engine is the code a browser downloads to show an editor, so it is the number with a hard
ceiling, enforced by `scripts/canvas-vendor.ts check` rather than left as an intention:

|                 | Measured | Ceiling |
| --------------- | -------- | ------- |
| Engine, gzipped | 743 KB   | 900 KB  |
| Whole snapshot  | 5243 KB  | 6144 KB |
| Shipped fonts   | 1306 KB  | 2048 KB |

Fonts are document data rather than application code, so they are fetched for a document that
actually references them, not bundled into the editor chunk.

Measured numbers are for the vendored snapshot, which does not include the 7 MB CanvasKit WASM or
anything the package manager installed.
