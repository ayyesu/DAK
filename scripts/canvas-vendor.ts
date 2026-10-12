// @effect-diagnostics nodeBuiltinImport:off -- A vendoring CLI that copies a tree between two checkouts on disk; the Effect Node FileSystem is an async service this tool does not run.
/**
 * Vendored Canvas engine snapshot.
 *
 * Canvas is a Penkra App, not a library, so only part of it is reusable inside DAK. This copies the
 * subset DAK executes — the schema, the Yjs document model, the script sandbox, inspection,
 * screenshots, and the exporters — as a pinned snapshot, and records what it copied so drift is
 * detectable.
 *
 * The closure is resolved from real import statements rather than a hand-maintained list, because a
 * list silently rots the first time upstream adds an import. Upstream's own tests, its Penkra
 * operation layer, its Vue editor, and its research recordings are deliberately left behind.
 *
 * Never edit anything under `packages/canvas-engine/upstream`. Re-sync with
 * `node scripts/canvas-vendor.ts sync --source <path-to-penkra-apps-checkout>`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Where the snapshot lives. Everything under it is generated except this file's siblings. */
export const CANVAS_VENDOR_DIR = "packages/canvas-engine/upstream";

/** Faces DAK owns rather than vendored, recorded in `fonts/manifest.json` next to them. */
export const CANVAS_OWNED_FONTS_DIR = "packages/canvas-engine/fonts";

/** Upstream revision this snapshot was taken from. Bump deliberately, never by a range. */
export const CANVAS_UPSTREAM_REPOSITORY = "https://github.com/penkrahq/penkra-apps";
export const CANVAS_UPSTREAM_PATH = "canvas";

/**
 * Entry points for the subset DAK runs. Each is a module DAK calls into directly; everything they
 * reach is pulled in transitively.
 */
export const CANVAS_ENTRY_POINTS = [
  "src/canvas-schema.mjs",
  "src/document-model.mjs",
  "src/operation-document-store.mjs",
  "src/script-runtime.mjs",
  "src/blank-document.mjs",
  "src/document-inspection.mjs",
  "src/document-review.mjs",
  "src/document-screenshot.mjs",
  "src/export-service.mjs",
  "src/document-assets.mjs",
  "src/svg-vectors.mjs",
  "src/image-materialization.mjs",
  "src/canvas-imports.mjs",
  "src/canvas-resolver.mjs",
  "src/capability-tables.mjs",
  "src/pencil-icon-provider.mjs",
  "src/codec.mjs",
] as const;

/**
 * Files copied outside the import closure. The engine is reached through a relative path that no
 * import statement in `src` owns, and the licences must travel with the code they cover.
 */
export const CANVAS_EXTRA_FILES = [
  "vendor/open-pencil/engine.source.mjs",
  // Every Inter weight the engine's font map names. ExtraBold was missing here for a long time
  // because this list and `BUNDLED_FONT_FILES` were maintained separately and never compared, so a
  // design using weight 800 failed to render with a module-resolution error. `canvas-font-coverage`
  // now fails the build when the two disagree; do not add a weight to the map without adding it here.
  "vendor/open-pencil/fonts/Inter-Regular.ttf",
  "vendor/open-pencil/fonts/Inter-Medium.ttf",
  "vendor/open-pencil/fonts/Inter-SemiBold.ttf",
  "vendor/open-pencil/fonts/Inter-Bold.ttf",
  "vendor/open-pencil/fonts/Inter-ExtraBold.ttf",
  "vendor/open-pencil/fonts/Inter-OFL.txt",
  "vendor/open-pencil/PROVENANCE.json",
  "licenses/OpenPencil-LICENSE.txt",
  "licenses/Inter-OFL.txt",
  "licenses/ICC-sRGB-profile.txt",
  "licenses/Noto-Emoji-OFL.txt",
  "THIRD_PARTY_NOTICES.md",
] as const;

/**
 * Deliberately excluded, recorded so a future reader does not add them back by accident.
 *
 * `NotoColorEmoji.ttf` is 10.5 MB, which is 87% of the font payload for glyphs almost no design
 * uses. It stays upstream and is fetched only for a document that actually needs it, which is why
 * `unknown_font` is a Canvas failure code rather than a silent fallback.
 */
export const CANVAS_EXCLUSIONS: ReadonlyArray<{ readonly path: string; readonly reason: string }> =
  [
    { path: "research/", reason: "16 MB of QA recordings and reports; evidence, not code." },
    {
      path: "src/*.test.mjs",
      reason: "Upstream tests run against the Penkra runtime DAK does not have.",
    },
    { path: "compatibility/", reason: "Browser conformance harness for the Penkra host." },
    { path: "operations/", reason: "Penkra operation docs; DAK exposes its own agent surface." },
    {
      path: "src/operations.mjs",
      reason: "The Penkra operation layer DAK replaces with native services.",
    },
    { path: "src/app.mjs", reason: "The Vue editor, hosted in an iframe by its own entry point." },
    {
      path: "vendor/open-pencil/source",
      reason: "The full upstream engine tree; DAK ships the generated module.",
    },
    {
      path: "vendor/open-pencil/fonts/NotoColorEmoji.ttf",
      reason: "10.5 MB; fetched on demand only.",
    },
    { path: "scripts/", reason: "Upstream's Bun build, which DAK does not use." },
  ];

/**
 * Size ceilings, enforced rather than intended. `engineGzipBytes` is what a user's browser actually
 * downloads for the editor, so that is the number with a hard limit; the rest bound what the
 * repository carries.
 */
export const CANVAS_BUDGETS = {
  /** Measured 741 KB gzipped. The headroom is deliberate, not slack to spend. */
  engineGzipBytes: 900 * 1024,
  /** The whole committed snapshot, emoji font excluded. */
  snapshotBytes: 6 * 1024 * 1024,
  /**
   * Every TTF DAK ships: the pinned Inter weights in the snapshot plus the DAK-owned faces in
   * `packages/canvas-engine/fonts`. Measured 2.4 MB (Inter 1.6 MB pinned, owned 0.8 MB for
   * JetBrains Mono and the three M4b display families as Latin subsets). The ceiling is 6 MB,
   * which is room for two or three more families at current subset sizes — or one deliberate
   * CJK decision — while the per-family cap in `canvas-font-coverage.ts` stays at 2 MB so a
   * single family cannot eat it. Neither the engine gzip nor the snapshot ceiling moves with
   * fonts: no font bytes enter the engine bundle, and owned faces live outside the snapshot.
   */
  fontBytes: 6 * 1024 * 1024,
} as const;

/** A static `import`/`export ... from "..."` of a relative specifier, which is all this resolves. */
const RELATIVE_SPECIFIER = /(?:^|[\s;])(?:import|export)\b[^'"`;]*?from\s*["'](\.[^"']+)["']/g;
const BARE_IMPORT = /(?:^|[\s;])import\s*["'](\.[^"']+)["']/g;

export interface CanvasVendorManifest {
  readonly repository: string;
  readonly upstreamPath: string;
  readonly revision: string;
  readonly generatedBy: string;
  readonly entryPoints: ReadonlyArray<string>;
  readonly exclusions: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * The manifest is this script's own contract with CI, so it is decoded as one rather than cast from
 * `JSON.parse`. A malformed manifest should fail as a decode error, not as a confusing `undefined`
 * three lines later.
 */
const CanvasVendorManifestSchema = Schema.Struct({
  repository: Schema.String,
  upstreamPath: Schema.String,
  revision: Schema.String,
  generatedBy: Schema.String,
  entryPoints: Schema.Array(Schema.String),
  exclusions: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  files: Schema.Record(Schema.String, Schema.String),
});

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(CanvasVendorManifestSchema));
const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CanvasVendorManifestSchema),
);

export function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

/** Rewrites a specifier's path to the snapshot's own POSIX layout, or null if it escapes the tree. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const resolved = NodePath.posix.normalize(
    NodePath.posix.join(NodePath.posix.dirname(fromFile), specifier),
  );
  if (resolved.startsWith("..") || NodePath.posix.isAbsolute(resolved)) return null;
  return resolved;
}

/**
 * The set of files reachable from the entry points through relative imports. Missing files are
 * reported rather than skipped, because a silent omission becomes a runtime failure inside the
 * sandbox instead of a build error.
 */
export async function resolveModuleClosure(
  rootDir: string,
  entryPoints: ReadonlyArray<string>,
): Promise<{ readonly files: ReadonlySet<string>; readonly missing: ReadonlyArray<string> }> {
  const found = new Set<string>();
  const missing: string[] = [];
  const queue = [...entryPoints];
  while (queue.length > 0) {
    const relative = queue.pop()!;
    if (found.has(relative)) continue;
    const absolute = NodePath.join(rootDir, relative);
    if (!NodeFS.existsSync(absolute)) {
      missing.push(relative);
      continue;
    }
    found.add(relative);
    const source = await NodeFSP.readFile(absolute, "utf8");
    for (const pattern of [RELATIVE_SPECIFIER, BARE_IMPORT]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const resolved = resolveRelative(relative, match[1]!);
        if (resolved !== null && !found.has(resolved)) queue.push(resolved);
      }
    }
  }
  return { files: found, missing };
}

export async function listFilesRecursively(dir: string, prefix = ""): Promise<string[]> {
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      output.push(...(await listFilesRecursively(NodePath.join(dir, entry.name), relative)));
    } else {
      output.push(relative);
    }
  }
  return output;
}

/**
 * Files that live under the snapshot but are not part of it.
 *
 * `src/canvaskit.wasm` is placed by this package's `prepare` script so the engine's renderer can
 * find its WASM, and `node_modules` is whatever the package manager installed. Both are generated,
 * so neither may be reported as vendored drift, and neither counts against the size budgets — the
 * budgets exist to bound what the repository carries, not what a checkout happens to have installed.
 */
const CANVAS_GENERATED_FILES: ReadonlySet<string> = new Set([
  "src/canvaskit.wasm",
  "vendor-manifest.json",
]);

export const isGeneratedSnapshotFile = (file: string): boolean =>
  CANVAS_GENERATED_FILES.has(file) || file.split("/").includes("node_modules");

export interface CanvasDrift {
  readonly added: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  readonly modified: ReadonlyArray<string>;
}

export const isEmptyDrift = (drift: CanvasDrift): boolean =>
  drift.added.length === 0 && drift.missing.length === 0 && drift.modified.length === 0;

/**
 * Compares a snapshot on disk with the manifest that was written when it was taken. This catches
 * local edits to vendored code and files that appeared without being recorded, and needs no
 * network, so CI can run it on every change.
 */
export async function verifySnapshot(
  snapshotDir: string,
  manifest: CanvasVendorManifest,
): Promise<CanvasDrift> {
  const recorded = new Set(Object.keys(manifest.files));
  const present = new Set(
    (await listFilesRecursively(snapshotDir)).filter((file) => !isGeneratedSnapshotFile(file)),
  );
  const added = [...present].filter((file) => !recorded.has(file));
  const missing = [...recorded].filter((file) => !present.has(file));
  const modified: string[] = [];
  for (const file of recorded) {
    if (!present.has(file)) continue;
    const digest = sha256(await NodeFSP.readFile(NodePath.join(snapshotDir, file)));
    if (digest !== manifest.files[file]) modified.push(file);
  }
  return { added, missing, modified };
}

export interface CanvasBudgetViolation {
  readonly what: string;
  readonly actual: number;
  readonly limit: number;
}

export interface CanvasSnapshotSizes {
  readonly snapshotBytes: number;
  readonly fontBytes: number;
  readonly engineGzipBytes: number;
}

async function gzipSize(absolute: string): Promise<number> {
  const { gzipSync } = await import("node:zlib");
  return gzipSync(await NodeFSP.readFile(absolute)).byteLength;
}

/** What a snapshot actually weighs, which is what the budgets are argued against. */
export async function measureSnapshot(
  snapshotDir: string,
  ownedFontsDir: string = NodePath.join(snapshotDir, "..", "fonts"),
): Promise<CanvasSnapshotSizes> {
  const files = (await listFilesRecursively(snapshotDir)).filter(
    (file) => !isGeneratedSnapshotFile(file),
  );
  let snapshotBytes = 0;
  let fontBytes = 0;
  let engineGzipBytes = 0;
  for (const file of files) {
    const absolute = NodePath.join(snapshotDir, file);
    snapshotBytes += (await NodeFSP.stat(absolute)).size;
    if (file.endsWith(".ttf")) fontBytes += (await NodeFSP.stat(absolute)).size;
    if (file === "vendor/open-pencil/engine.source.mjs") engineGzipBytes = await gzipSize(absolute);
  }
  // DAK-owned faces live outside the snapshot but count against the font ceiling all the same:
  // a budget that ignores them is what let the total grow past 2 MB unnoticed. A missing
  // directory counts as zero here; presence is the manifest parity test's job, not the budget's.
  if (NodeFS.existsSync(ownedFontsDir)) {
    for (const file of await listFilesRecursively(ownedFontsDir)) {
      if (file.endsWith(".ttf")) {
        fontBytes += (await NodeFSP.stat(NodePath.join(ownedFontsDir, file))).size;
      }
    }
  }
  return { snapshotBytes, fontBytes, engineGzipBytes };
}

/** The ceilings, measured against a snapshot on disk. */
export async function checkBudgets(snapshotDir: string): Promise<CanvasBudgetViolation[]> {
  const sizes = await measureSnapshot(snapshotDir);
  const violations: CanvasBudgetViolation[] = [];
  if (sizes.engineGzipBytes > CANVAS_BUDGETS.engineGzipBytes) {
    violations.push({
      what: "engine gzip",
      actual: sizes.engineGzipBytes,
      limit: CANVAS_BUDGETS.engineGzipBytes,
    });
  }
  if (sizes.snapshotBytes > CANVAS_BUDGETS.snapshotBytes) {
    violations.push({
      what: "snapshot size",
      actual: sizes.snapshotBytes,
      limit: CANVAS_BUDGETS.snapshotBytes,
    });
  }
  if (sizes.fontBytes > CANVAS_BUDGETS.fontBytes) {
    violations.push({
      what: "shipped fonts",
      actual: sizes.fontBytes,
      limit: CANVAS_BUDGETS.fontBytes,
    });
  }
  return violations;
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

const reportBudgetViolations = (violations: ReadonlyArray<CanvasBudgetViolation>) =>
  Effect.forEach(violations, (violation) =>
    Console.error(
      `  BUDGET ${violation.what}: ${kib(violation.actual)} exceeds ${kib(violation.limit)}`,
    ),
  );

const sync = (
  repoRoot: string,
  sourceDir: string,
  revision: string,
): Effect.Effect<number, Schema.SchemaError> =>
  Effect.gen(function* () {
    const { files, missing } = yield* Effect.promise(() =>
      resolveModuleClosure(sourceDir, [...CANVAS_ENTRY_POINTS]),
    );
    const extras = CANVAS_EXTRA_FILES.filter((file) =>
      NodeFS.existsSync(NodePath.join(sourceDir, file)),
    );
    const absentExtras = CANVAS_EXTRA_FILES.filter((file) => !extras.includes(file));
    if (missing.length > 0 || absentExtras.length > 0) {
      yield* Console.error(
        `Upstream is missing ${[...missing, ...absentExtras].join(", ")}. ` +
          "The subset changed upstream; update CANVAS_ENTRY_POINTS or CANVAS_EXTRA_FILES deliberately.",
      );
      return 1;
    }
    const snapshotDir = NodePath.join(repoRoot, CANVAS_VENDOR_DIR);
    yield* Effect.promise(() => NodeFSP.rm(snapshotDir, { recursive: true, force: true }));
    // The closure and the extra files are copied together: the engine module and the
    // licences are not reachable by import, so copying only the closure would ship
    // code with no attribution and no fonts.
    const copied = [...new Set([...files, ...extras])].sort();
    const digests: Record<string, string> = {};
    for (const file of copied) {
      const destination = NodePath.join(snapshotDir, file);
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.cp(NodePath.join(sourceDir, file), destination));
      digests[file] = sha256(yield* Effect.promise(() => NodeFSP.readFile(destination)));
    }
    const manifest = {
      repository: CANVAS_UPSTREAM_REPOSITORY,
      upstreamPath: CANVAS_UPSTREAM_PATH,
      revision,
      generatedBy: "node scripts/canvas-vendor.ts sync",
      entryPoints: [...CANVAS_ENTRY_POINTS],
      exclusions: CANVAS_EXCLUSIONS,
      files: digests,
    };
    const encoded = yield* encodeManifest(manifest);
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(snapshotDir, "vendor-manifest.json"), `${encoded}\n`),
    );
    const sizes = yield* Effect.promise(() => measureSnapshot(snapshotDir));
    const violations = yield* Effect.promise(() => checkBudgets(snapshotDir));
    yield* Console.log(
      `Vendored ${Object.keys(digests).length} files from ${revision.slice(0, 12)}`,
    );
    yield* Console.log(
      `  engine gzip: ${kib(sizes.engineGzipBytes)} of ${kib(CANVAS_BUDGETS.engineGzipBytes)}`,
    );
    yield* Console.log(
      `  snapshot: ${kib(sizes.snapshotBytes)} of ${kib(CANVAS_BUDGETS.snapshotBytes)}`,
    );
    yield* Console.log(`  fonts: ${kib(sizes.fontBytes)} of ${kib(CANVAS_BUDGETS.fontBytes)}`);
    yield* reportBudgetViolations(violations);
    return violations.length;
  });

function check(repoRoot: string): Effect.Effect<number, Schema.SchemaError> {
  return Effect.gen(function* () {
    const snapshotDir = NodePath.join(repoRoot, CANVAS_VENDOR_DIR);
    const manifestPath = NodePath.join(snapshotDir, "vendor-manifest.json");
    if (!NodeFS.existsSync(manifestPath)) {
      yield* Console.error(`No Canvas snapshot at ${CANVAS_VENDOR_DIR}. Run the sync command.`);
      return 1;
    }
    const manifest = yield* decodeManifest(
      yield* Effect.promise(() => NodeFSP.readFile(manifestPath, "utf8")),
    );
    const drift = yield* Effect.promise(() => verifySnapshot(snapshotDir, manifest));
    if (!isEmptyDrift(drift)) {
      for (const file of drift.modified) yield* Console.error(`  modified: ${file}`);
      for (const file of drift.added) yield* Console.error(`  added: ${file}`);
      for (const file of drift.missing) yield* Console.error(`  missing: ${file}`);
      yield* Console.error("Vendored Canvas code drifted. Never edit it; re-sync deliberately.");
      return 1;
    }
    const violations = yield* Effect.promise(() => checkBudgets(snapshotDir));
    yield* reportBudgetViolations(violations);
    if (violations.length === 0) {
      const sizes = yield* Effect.promise(() => measureSnapshot(snapshotDir));
      yield* Console.log(
        `Canvas snapshot matches ${manifest.revision.slice(0, 12)}; ` +
          `engine ${kib(sizes.engineGzipBytes)} gzip, snapshot ${kib(sizes.snapshotBytes)}.`,
      );
    }
    return violations.length;
  });
}

/** Usage is printed rather than thrown, so importing this module for tests has no side effects. */
const USAGE =
  "Usage: node scripts/canvas-vendor.ts <sync --source <path> [--revision <sha]> | check>";

const main = (
  argv: ReadonlyArray<string>,
  repoRoot: string,
): Effect.Effect<number, Schema.SchemaError> => {
  const [command, ...rest] = argv;
  const flag = (name: string) => {
    const index = rest.indexOf(`--${name}`);
    return index === -1 ? undefined : rest[index + 1];
  };
  if (command === "sync") {
    const source = flag("source");
    if (source === undefined) return Effect.as(Console.error(USAGE), 1);
    const revision = flag("revision") ?? "unknown";
    return Effect.map(sync(repoRoot, source, revision), (violations) => (violations === 0 ? 0 : 1));
  }
  if (command === "check") return check(repoRoot);
  return Effect.as(Console.error(USAGE), 1);
};

/** Only runs as a command; a test importing this module gets the functions and no exit. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // A manifest this script cannot decode is a broken checkout, reported as a failed
  // run rather than an unhandled rejection.
  process.exitCode = await Effect.runPromise(
    main(process.argv.slice(2), process.cwd()).pipe(
      Effect.catch((error: Schema.SchemaError) =>
        Effect.as(Console.error(`Canvas vendor snapshot failed: ${error.message}`), 1),
      ),
    ),
  );
}
