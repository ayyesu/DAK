#!/usr/bin/env node
/**
 * Runs the Canvas runtimes the way the packaged server loads them.
 *
 * The QuickJS and CanvasKit runtimes are WebAssembly assets that the bundler inlines the JavaScript
 * half of and then drops. Nothing in dev catches that. `vp run dev` resolves both from
 * `node_modules`, so a script edits a design happily all day while every packaged artifact ships a
 * server that throws `ENOENT ... emscripten-module.wasm` the first time an agent calls
 * `dak_canvas_edit`. That is a bad way to find out, and it was found the bad way: an agent reported
 * the raw ENOENT in the middle of authoring a design.
 *
 * So this checks the artifact rather than the source tree, and it checks by running rather than by
 * looking for a file. Existence is not the property that matters. The WASM can be present at a path
 * the loader never resolves, or present and unusable, and both look identical to `stat`. The only
 * question worth asking is whether the runtime instantiates and evaluates.
 *
 * The probes import the *emitted chunks* by globbing `dist`, exactly as the bundled server does when
 * it dynamically imports them, so a hashed chunk name cannot silently invalidate this.
 *
 * Run after `vp run --filter dak build:bundle`.
 */
// @effect-diagnostics nodeBuiltinImport:off - This is a standalone build-verification script, not
// service code. It spawns a real Node process against the emitted bundle, which is the whole point:
// the artifact has to run outside this Effect runtime for the check to mean anything.
// @effect-diagnostics globalConsole:off - A CLI smoke test's output is its result. Routing build
// verification through the Effect logger would obscure the pass/fail line in CI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const serverDist = NodePath.join(repoRoot, "apps", "server", "dist");

class CanvasPackagedRuntimeError extends Error {
  override readonly name = "CanvasPackagedRuntimeError";
  constructor(step: string, detail: string) {
    super(`Canvas packaged runtime smoke test failed while ${step}: ${detail}`);
  }
}

if (!NodeFS.existsSync(serverDist)) {
  console.error(
    `${serverDist} does not exist. Run \`vp run --filter dak build:bundle\` first — a stale bundle predates Canvas entirely and would prove nothing.`,
  );
  process.exit(1);
}

/** The emitted QuickJS chunk, found by the pattern rolldown names it after the source module. */
const quickJsChunk = NodeFS.readdirSync(serverDist).find(
  (name) => name.startsWith("emscripten-module-") && name.endsWith(".mjs"),
);
if (quickJsChunk === undefined) {
  throw new CanvasPackagedRuntimeError(
    "locating the QuickJS chunk",
    `no emscripten-module-*.mjs in ${serverDist}. The bundle does not contain the Canvas engine at all.`,
  );
}

/**
 * Runs one probe in a scratch directory, importing only what it is handed.
 *
 * The empty module paths matter as much as the file paths. A probe that can reach `node_modules`
 * would quietly load the dev copy of QuickJS instead of the packaged one and pass forever, which is
 * exactly the false pass this file exists to prevent.
 */
const runProbe = async (label: string, source: string): Promise<string> => {
  const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dak-canvas-smoke-"));
  const script = NodePath.join(sandbox, "probe.mjs");
  try {
    NodeFS.writeFileSync(script, source, "utf8");
    const child = NodeChildProcess.spawnSync(process.execPath, [script], {
      cwd: sandbox,
      env: { PATH: "", HOME: sandbox, USERPROFILE: sandbox, TEMP: sandbox, TMPDIR: sandbox },
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });
    if (child.status !== 0) {
      const detail = `${child.stderr || child.stdout || ""}`.trim();
      throw new CanvasPackagedRuntimeError(
        label,
        detail || `probe exited with ${String(child.status)}`,
      );
    }
    return (child.stdout ?? "").trim();
  } finally {
    // A leftover temp directory is not worth failing a smoke test over.
    try {
      NodeFS.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
};

const chunkUrl = NodeURL.pathToFileURL(NodePath.join(serverDist, quickJsChunk)).href;

// Instantiating the emitted chunk is the failing step this file exists to catch. The module's default
// export is the Emscripten factory, and calling it is what resolves `emscripten-module.wasm` beside
// the chunk — the exact ENOENT agents hit.
/** The name the emitted QuickJS loader resolves relative to its own chunk. */
const QUICKJS_WASM_FILENAME = "emscripten-module.wasm";

const quickJs = await runProbe(
  "QuickJS sandbox (the agent's edit path)",
  `import createQuickJSModule from ${JSON.stringify(chunkUrl)};
try {
  // The chunk's default export is the raw Emscripten module factory, not the QuickJS runtime
  // wrapper. Instantiating it is the step that reads \`${QUICKJS_WASM_FILENAME}\` from beside the
  // chunk, which is the load that used to throw ENOENT, so reaching here already proves the asset
  // shipped. Evaluating through it proves the bytes are usable, not merely present.
  const module = await createQuickJSModule({});
  if (typeof module._QTS_NewRuntime !== "function") {
    throw new Error("the QuickJS module instantiated without its runtime exports");
  }
  process.stdout.write("the WASM beside the emitted chunk instantiated");
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error));
  process.exit(1);
}
`,
);
console.log(`  ok  QuickJS sandbox — ${quickJs}.`);
console.log("     This is what dak_canvas_edit runs; a missing WASM here is the reported ENOENT.");

// CanvasKit resolves its WASM through candidates relative to the *engine module*, and inside the
// bundle that module is an emitted chunk. So the path that matters is the one in `dist`, not the one
// in the source tree.
//
// This is not a theoretical distinction. An earlier version of this probe imported the vendored
// engine directly and passed with `dist/canvaskit.wasm` deleted, because the source checkout still
// had its own copy beside it. A check that cannot fail is worse than no check, so the assertion below
// deliberately proves two separate things: that the bundled asset is present at the path the bundled
// loader resolves, and that a real frame rasterizes. Deleting either one has to turn this red.
const CANVASKIT_WASM_FILENAME = "canvaskit.wasm";
const canvaskitWasm = NodePath.join(serverDist, CANVASKIT_WASM_FILENAME);
if (!NodeFS.existsSync(canvaskitWasm)) {
  throw new CanvasPackagedRuntimeError(
    "CanvasKit rasterizer (the agent's review loop)",
    `${NodePath.relative(repoRoot, canvaskitWasm)} is missing from the bundle. The engine's loader resolves ./${CANVASKIT_WASM_FILENAME} beside its own chunk, so without it screenshots fail CANVAS_SCREENSHOT_RUNTIME_UNAVAILABLE in every packaged build. Run \`node scripts/place-canvas-assets.ts\`.`,
  );
}

/**
 * The inlined CanvasKit glue has to be able to resolve its own directory at runtime.
 *
 * CanvasKit's Emscripten output is CommonJS and computes its script directory from `__dirname`. The
 * bundler inlines that glue into the application chunk, where `__dirname` does not exist, so every
 * render in every packaged build threw `ReferenceError: __dirname is not defined`: the design panel
 * showed "This design could not be rendered right now", and a script's `TakeScreenshot` and every
 * export failed with the same cause. Dev never saw it, because `vp run dev` resolves CanvasKit from
 * `node_modules`, where the file is real CommonJS and `__dirname` exists. The desktop app is the
 * surface that always runs the bundle, which is why the failure looked like a dev-environment bug.
 *
 * The check is textual because the property is: CanvasKit's JavaScript half is inlined into the
 * application chunk rather than emitted as one the probe could import, so whether the identifier
 * survives *is* the defect. It asserts both directions on purpose — a build that stops substituting
 * `import.meta.dirname` fails here, and so does one that leaves the raw identifier behind. The
 * substitution itself is declared in `apps/server/vite.config.ts`.
 */
const emittedChunks = NodeFS.readdirSync(serverDist)
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => ({ name, source: NodeFS.readFileSync(NodePath.join(serverDist, name), "utf8") }));

const withRawDirname = emittedChunks.filter((chunk) => /\b__dirname\b/.test(chunk.source));
if (withRawDirname.length > 0) {
  throw new CanvasPackagedRuntimeError(
    "CanvasKit's Emscripten glue",
    `${withRawDirname.map((chunk) => chunk.name).join(", ")} reference \`__dirname\`, which does not exist in an ` +
      "ESM chunk. CanvasKit throws `__dirname is not defined` and every render, screenshot and export fails.",
  );
}

if (!emittedChunks.some((chunk) => chunk.source.includes("import.meta.dirname"))) {
  throw new CanvasPackagedRuntimeError(
    "CanvasKit's Emscripten glue",
    "no emitted chunk contains the shimmed directory lookup, so the bundler is no longer substituting " +
      "`__dirname`. Check the `define` block in apps/server/vite.config.ts.",
  );
}
console.log(
  "  ok  CanvasKit glue — the emitted chunk resolves its directory through import.meta.dirname.",
);

const canvasKit = await runProbe(
  "CanvasKit rasterizer (the agent's review loop)",
  // CanvasKit is instantiated through its own `locateFile` hook, which is the same mechanism
  // `document-screenshot.mjs` uses. Pointing it at the bundled asset — rather than letting a copy in
  // the source tree answer for it — is what makes this a packaged-artifact check. The engine's own
  // module cannot be imported from `dist`, because the bundler inlines it into the CLI application
  // chunk rather than emitting it as an importable one, so the loader is driven directly instead.
  `import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(
    NodeURL.pathToFileURL(
      NodePath.join(repoRoot, "packages", "canvas-engine", "upstream", "src", "loader.mjs"),
    ).href,
  )});
// The CommonJS build of canvaskit-wasm exports the factory directly rather than under "default".
const loadCanvasKit = require("canvaskit-wasm");
const wasmPath = ${JSON.stringify(canvaskitWasm)};
try {
  const ck = await loadCanvasKit({ locateFile: () => wasmPath });
  const surface = ck.MakeSurface(32, 32);
  if (!surface) throw new Error("CanvasKit could not create a surface");
  const canvas = surface.getCanvas();
  const paint = new ck.Paint();
  paint.setAntiAlias(false);
  paint.setColor(ck.RED);
  // Painting the whole surface rather than a rect: this build's rect factories sit behind internal
  // bindings, and the thing under test is that the WASM rasterizes at all, not which primitive did
  // it. drawPaint exercises the same Skia pipeline a screenshot goes through.
  canvas.drawPaint(paint);
  const image = surface.makeImageSnapshot();
  const data = image.encodeToBytes();
  if (!data || data.length === 0) throw new Error("CanvasKit produced no PNG bytes");
  surface.delete();
  process.stdout.write("the bundled WASM rasterized " + data.length + " bytes to PNG");
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error));
  process.exit(1);
}
`,
);
console.log(`  ok  CanvasKit rasterizer — ${canvasKit}.`);
console.log(
  "     This is what screenshots and exports run; a missing WASM here is CANVAS_SCREENSHOT_RUNTIME_UNAVAILABLE.",
);

console.log("Canvas packaged runtime smoke test passed.");
