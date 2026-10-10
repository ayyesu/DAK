/**
 * Places CanvasKit's WASM beside the module that loads it.
 *
 * Canvas's exporter resolves `canvaskit.wasm` relative to `src/document-screenshot.mjs` — upstream's
 * own build copies it there — and DAK's vendored snapshot has no build step of its own. Without this
 * the engine compiles, screenshots throw `CANVAS_SCREENSHOT_RUNTIME_UNAVAILABLE`, and the agent's
 * visual review loop silently has nothing to look at.
 *
 * The file is generated, never vendored: it is hard-linked when the filesystem allows (no second
 * copy on disk) and copied otherwise. Both `scripts/canvas-vendor.ts check` and `.gitignore` know to
 * ignore it, so it can never be mistaken for part of the pinned snapshot.
 *
 * Runs from this package's `prepare` script, so `pnpm install` is enough to make the engine ready.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const packageRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const destination = NodePath.join(packageRoot, "upstream", "src", "canvaskit.wasm");

const source = (() => {
  try {
    const entry = NodeFS.realpathSync(NodePath.join(packageRoot, "node_modules", "canvaskit-wasm"));
    return NodePath.join(entry, "bin", "canvaskit.wasm");
  } catch {
    return null;
  }
})();

if (source === null || !NodeFS.existsSync(source)) {
  // Not an error: a checkout that has not installed dependencies yet still has to be able to run
  // typecheck and lint. The asset appears the moment dependencies do.
  console.log("canvas-engine: canvaskit-wasm is not installed yet; skipping the WASM asset.");
  process.exit(0);
}

if (NodeFS.existsSync(destination)) {
  const [placed, wanted] = [NodeFS.statSync(destination), NodeFS.statSync(source)];
  if (placed.size === wanted.size) {
    console.log("canvas-engine: canvaskit.wasm already in place.");
    process.exit(0);
  }
  NodeFS.rmSync(destination, { force: true });
}

NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
try {
  // A hard link is a second name for the same bytes, so the repository carries one copy, not two.
  NodeFS.linkSync(source, destination);
  console.log("canvas-engine: linked canvaskit.wasm beside the engine.");
} catch {
  NodeFS.copyFileSync(source, destination);
  console.log("canvas-engine: copied canvaskit.wasm beside the engine.");
}
