/**
 * Places the Canvas WebAssembly runtimes beside the packaged server's chunks.
 *
 * Canvas needs two WASM runtimes at request time: QuickJS, which is the script sandbox behind every
 * `dak_canvas_edit`, and CanvasKit, which is the rasterizer behind screenshots. Both are ordinary
 * package-manager dependencies, and both are resolved at runtime *relative to the module that loads
 * them* — QuickJS through `new URL("emscripten-module.wasm", import.meta.url)` and CanvasKit through
 * the candidates in `document-screenshot.mjs`.
 *
 * The bundler inlines the JavaScript half of each and emits nothing for the WASM, so every packaged
 * server shipped a loader pointing at a file that was not there. Dev never noticed, because dev
 * resolves both from `node_modules`. The symptom reached users as a raw
 * `ENOENT ... emscripten-module.wasm` thrown at an agent halfway through authoring a design, with
 * `dak_canvas_read`, `dak_canvas_list` and `dak_canvas_create` all still working — which is exactly
 * the shape of a failure that survives until someone uses the product.
 *
 * This runs after `vp pack` and copies the assets into `dist` under the names the emitted loaders
 * actually resolve. It is deliberately a copy rather than an inline base64 blob: a WASM neighbour is
 * what both upstream loaders are written against, it keeps the JavaScript chunks smaller, and it
 * matches how `packages/canvas-engine/scripts/place-canvaskit.mjs` already handles CanvasKit for the
 * source tree.
 *
 * The files are generated, never vendored. `.gitignore` and `scripts/canvas-vendor.ts check` already
 * ignore CanvasKit's copy for the same reason, and `scripts/canvas-packaged-runtime.smoke.ts` proves
 * the result actually runs rather than merely existing.
 */
// @effect-diagnostics nodeBuiltinImport:off - This is a build script run directly by the pack step,
// not service code. It copies files into the output directory before anything else loads them, so
// there is no Effect runtime to be inside yet.
// @effect-diagnostics globalConsole:off - This script's console output is the build log for a step
// that runs between `vp pack` and the artifact, and a failure here must abort that build.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { CANVAS_EXCLUDED_FONT_FILES, readPromisedFontFiles } from "./canvas-font-coverage.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const serverDist = NodePath.join(repoRoot, "apps", "server", "dist");

/**
 * Resolves a package asset from the canvas engine, which is what declares these dependencies.
 *
 * Resolution starts inside `packages/canvas-engine` rather than at the repo root because that is the
 * package whose `package.json` lists `quickjs-emscripten` and `canvaskit-wasm`. Resolving from the
 * root would find whatever hoisted version happened to be nearest, which is not the version the
 * engine was tested against.
 */
const requireFromCanvasEngine = NodeModule.createRequire(
  NodePath.join(repoRoot, "packages", "canvas-engine", "upstream", "src", "resolve-assets.mjs"),
);

/**
 * The variant's own resolution context.
 *
 * pnpm's strict layout keeps `@jitl/*` out of the canvas engine's `node_modules`, because the engine
 * depends on `quickjs-emscripten` and that package depends on the variant. Resolving from the engine
 * therefore fails even though the file is present. `quickjs-emscripten` is reachable, and requiring
 * *from it* lands inside the dependency that owns the WASM, which is the resolution the bundled
 * loader itself performs.
 */
const requireFromQuickJs = NodeModule.createRequire(
  requireFromCanvasEngine.resolve("quickjs-emscripten"),
);

/**
 * The QuickJS variant to ship.
 *
 * `script-runtime.mjs` calls a bare `getQuickJS()`, which `quickjs-emscripten` resolves to
 * `RELEASE_SYNC`. That default is read from the installed 0.32.0, not assumed: the parameter is
 * `newQuickJSWASMModule(variantOrPromise = RELEASE_SYNC)`. Pinning it here means a change to that
 * default cannot silently ship a WASM the loader will not ask for — the smoke test would fail, but
 * this comment is why the two names match.
 */
const QUICKJS_VARIANT = "@jitl/quickjs-wasmfile-release-sync";
const QUICKJS_WASM_FILENAME = "emscripten-module.wasm";

/**
 * The font faces, copied into `dist` beside the bundle.
 *
 * `document-screenshot.mjs` resolves a face with `new URL("./<file>", import.meta.url)` and then a
 * `../vendor/open-pencil/fonts/<file>` fallback. Inside the bundle `import.meta.url` is the emitted
 * chunk in `apps/server/dist`, so both candidates point outside anything that ships — the same
 * failure shape as the missing WASM, and the reason a design using any vendored face rendered in dev
 * and threw in every packaged build. Staging the files next to the chunk is what makes the loader's
 * first candidate resolve.
 *
 * Every face in the vendored font directory is staged, not a hand-picked list, so a weight added by
 * the sync is staged without anyone remembering to update this file.
 */
const fontsSourceDirectory = NodePath.join(
  repoRoot,
  "packages",
  "canvas-engine",
  "upstream",
  "vendor",
  "open-pencil",
  "fonts",
);

/** The host-owned faces, which ship as TTF under their own names. See `CANVAS_FONT_FILENAME_ALIASES`. */
const dakFontsDirectory = NodePath.join(repoRoot, "packages", "canvas-engine", "fonts");

/** The name the engine's font map asks for, mapped to the TTF DAK actually ships. */
const FONT_FILENAME_ALIASES: Readonly<Record<string, string>> = {
  "jetbrains-mono-400.woff2": "jetbrains-mono-400.ttf",
  "jetbrains-mono-500.woff2": "jetbrains-mono-500.ttf",
};

const assets = [
  {
    label: "QuickJS script sandbox",
    // The `wasm` export is the one that is unambiguously the binary; the package's main entry is the
    // JS loader, which is what the bundler already emitted.
    source: () => requireFromQuickJs.resolve(`${QUICKJS_VARIANT}/wasm`),
    destination: NodePath.join(serverDist, QUICKJS_WASM_FILENAME),
  },
  {
    label: "CanvasKit rasterizer",
    // `document-screenshot.mjs` tries `./canvaskit.wasm` beside itself first, then the installed
    // package. In the bundle only the first candidate is reachable, so that is the one to satisfy.
    source: () => requireFromCanvasEngine.resolve("canvaskit-wasm/bin/canvaskit.wasm"),
    destination: NodePath.join(serverDist, "canvaskit.wasm"),
  },
] as const;

if (!NodeFS.existsSync(serverDist)) {
  console.error(
    `${serverDist} does not exist. Run \`vp run --filter dak build:bundle\` first; there is no bundle to place assets beside.`,
  );
  process.exit(1);
}

for (const asset of assets) {
  let source: string;
  try {
    source = asset.source();
  } catch (error) {
    // A missing dependency is a real problem: the bundle is already built, and shipping it without
    // its WASM is precisely the bug this script exists to prevent. Failing loudly beats emitting an
    // artifact that throws ENOENT at a user's agent.
    console.error(
      `canvas-assets: could not resolve the ${asset.label} WASM: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
  if (!NodeFS.existsSync(source)) {
    console.error(`canvas-assets: the ${asset.label} WASM resolved to a missing file: ${source}`);
    process.exit(1);
  }
  NodeFS.mkdirSync(NodePath.dirname(asset.destination), { recursive: true });
  // Copied rather than linked: the bundle is packaged and shipped, and a hard link into a pnpm store
  // that a user's installer may prune is not something to depend on.
  NodeFS.copyFileSync(source, asset.destination);
  const { size } = NodeFS.statSync(asset.destination);
  console.log(
    `canvas-assets: placed ${asset.label} at ${NodePath.relative(repoRoot, asset.destination)} (${Math.round(size / 1024)} KB).`,
  );
}

/**
 * Stage every face the engine's font map names, under the name it asks for.
 *
 * Iterating the map rather than the directory means a face that is vendored but unnamed still fails
 * here, which is the state that produced a design that rendered nowhere: present in the repository,
 * absent from the bundle, and no error until an agent used that weight.
 */
const promisedFontFiles = readPromisedFontFiles();

for (const { family, file } of promisedFontFiles) {
  // The engine asks for a name; DAK may ship that face under a different one. A woff2 is never
  // substituted: bytes reach CanvasKit unmodified, so a renamed file must still be a real TTF.
  const shippedName = FONT_FILENAME_ALIASES[file] ?? file;
  if (FONT_FILENAME_ALIASES[file] !== undefined && !shippedName.endsWith(".ttf")) {
    console.error(
      `canvas-assets: ${file} is aliased to ${shippedName}, which is not a TTF. CanvasKit cannot ` +
        `decompress woff2, so this alias would fail at render time rather than here.`,
    );
    process.exit(1);
  }
  const source = [fontsSourceDirectory, dakFontsDirectory]
    .map((directory) => NodePath.join(directory, shippedName))
    .find((candidate) => NodeFS.existsSync(candidate));
  if (source === undefined) {
    // Deliberately-excluded faces are expected to be absent; anything else is the bug this catches.
    const excluded = CANVAS_EXCLUDED_FONT_FILES.some((entry) => entry.file === file);
    if (excluded) continue;
    console.error(
      `canvas-assets: the ${family} face (${file}) is neither vendored nor DAK-owned, so a design ` +
        `using it will fail to render in this build.`,
    );
    process.exit(1);
  }
  // Staged under the name the engine asks for, because that is the filename its `new URL` lookup
  // will build. The alias only changes which file the bytes came from.
  const destination = NodePath.join(serverDist, file);
  NodeFS.copyFileSync(source, destination);
  console.log(
    `canvas-assets: placed font ${family} at apps/server/dist/${file} (${Math.round(
      NodeFS.statSync(destination).size / 1024,
    )} KB).`,
  );
}
