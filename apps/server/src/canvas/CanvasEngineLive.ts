// @effect-diagnostics nodeBuiltinImport:off - The host font provider resolves face files against the
// vendored snapshot's own directories, which only exist as real paths. It is called once at engine
// construction, before any Effect service exists.
import { createBlankDocumentSource } from "@dak/canvas-engine/upstream/src/blank-document.mjs";
import { validateCanvasDocument } from "@dak/canvas-engine/upstream/src/canvas-schema.mjs";
import {
  Y,
  createDocumentModel,
  createDocumentOperationUpdates,
  encodeState,
  materialize,
  restoreDocumentModel,
} from "@dak/canvas-engine/upstream/src/document-model.mjs";
import { reviewDocumentIssues } from "@dak/canvas-engine/upstream/src/document-review.mjs";
import { takeDocumentScreenshots } from "@dak/canvas-engine/upstream/src/document-screenshot.mjs";
import { createOpenPencilEditor } from "@dak/canvas-engine/upstream/src/openpencil-engine.mjs";
import {
  getCanvasKit,
  SkiaRenderer,
} from "@dak/canvas-engine/upstream/vendor/open-pencil/engine.source.mjs";
import {
  extractDocumentNode,
  extractDocumentNodes,
} from "@dak/canvas-engine/upstream/src/export-service.mjs";
import { executeCanvasScript } from "@dak/canvas-engine/upstream/src/script-runtime.mjs";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { registerCanvasHostFonts } from "./CanvasHostFonts.ts";

import type { CanvasModule } from "@dak/contracts";
import { HostProcessPlatform } from "@dak/shared/hostProcess";

import type {
  CanvasDocument,
  CanvasDocumentPayload,
  CanvasEngine,
  CanvasEngineIssue,
  CanvasEngineScreenshot,
  CanvasScriptResult,
  CanvasViewport,
} from "./CanvasPorts.ts";

/**
 * Canvas's engine, wrapped so the rest of DAK never sees CanvasKit, QuickJS, or Yjs directly.
 *
 * Everything here is stateless: a mutation hydrates a document model from the payload the store
 * read, runs the script against a private clone, and hands back the delta that would commit it. The
 * store applies that delta to *its own* model, hydrated from the same bytes, so a mutation computed
 * here is a valid delta there. Nothing is cached between calls, which is also what lets several
 * DAK processes read the same project without coordinating — the update log is the only writer.
 *
 * Every model is destroyed in a `finally`. A design that throws is not a design that leaks.
 */

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * Where a face or runtime asset may live, resolved from this module rather than from the caller's cwd.
 *
 * In the bundle this module is a chunk in `dist`, so `import.meta.url` points at the server's own
 * directory and the vendored snapshot's directories are not beside it. Assets are therefore tried in
 * two places: staged beside the bundle, which is what a packaged artifact has, then the source tree,
 * which is what a dev run has.
 */
const canvasAssetPaths = {
  /** The directory this module was loaded from: the bundle's `dist`, or `src/canvas` in dev. */
  moduleDir: () => NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  /** The vendored snapshot: `packages/canvas-engine/upstream`. */
  upstreamDir: () =>
    NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      // `apps/server/src/canvas` -> repo root is four levels up; `apps/server/dist` is two.
      "../../../..",
      "packages/canvas-engine/upstream",
    ),
  /** Faces DAK owns rather than vendored. */
  dakFontsDir: () =>
    NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../../..",
      "packages/canvas-engine/fonts",
    ),
} as const;

/**
 * Finds one runtime asset, staged beside the bundle when it is there and in the snapshot otherwise.
 *
 * The two layouts differ: `place-canvas-assets` writes WASM flat into `dist`, while the snapshot keeps
 * it beside the engine module that loads it. Guessing one and trusting it is how this file's first
 * version looked for `src/canvas/canvaskit.wasm` — a path that exists in neither.
 */
const findCanvasAsset = (fileName: string, snapshotSubdirectory: ReadonlyArray<string>): string => {
  const besideModule = NodePath.join(canvasAssetPaths.moduleDir(), fileName);
  if (NodeFS.existsSync(besideModule)) return besideModule;
  const inSnapshot = NodePath.join(
    canvasAssetPaths.upstreamDir(),
    ...snapshotSubdirectory,
    fileName,
  );
  if (NodeFS.existsSync(inSnapshot)) return inSnapshot;
  // Reported rather than returned: an absent asset should fail with the path it looked in, which is
  // the only useful thing to say about a WASM that did not load.
  throw new Error(
    `Canvas runtime asset ${fileName} was not found beside the bundle or in the snapshot.`,
  );
};

/**
 * The raster cap a single viewport is held to.
 *
 * The vendored screenshot path caps its own longest edge at 2048px, and that ceiling is deliberate:
 * it bounds server CPU, payload size, and what the model can look at. A viewport asks for less than
 * the whole design precisely so it stays inside that ceiling at full legibility, so the cap here is the
 * same number rather than a second policy.
 */
const MAX_VIEWPORT_EDGE = 2048;

/**
 * Renders a window onto a design, the way Penkra's own surface pans and zooms.
 *
 * `takeDocumentScreenshots` renders whatever it is given fitted to one image, so a 1440x4400 page
 * arrives as a 2048px-tall strip with unreadable text. Slicing it into bands would fix legibility but
 * needs the panel to assemble and cache a stack of images per design. This asks the engine for one
 * viewport instead: the caller scrolls by moving `x`/`y` and zooms by shrinking `width`/`height`, and
 * each render stays a single ordinary image.
 *
 * The primitives used here (`createOpenPencilEditor`, `SkiaRenderer`) are already vendored — only
 * Penkra's Vue surface that mounts them is not, and it is a container rather than a requirement.
 */
const renderViewport = async (
  document: CanvasDocument,
  nodeIds: ReadonlyArray<string>,
  viewport: CanvasViewport,
  maxEdge: number | undefined,
): Promise<
  ReadonlyArray<{
    readonly nodeIds: ReadonlyArray<string>;
    readonly data: string;
    readonly width: number;
    readonly height: number;
  }>
> => {
  // A viewport too small to see anything would produce a blank image that looks like a broken design.
  const width = Math.max(1, Math.min(Math.ceil(viewport.width), maxEdge ?? MAX_VIEWPORT_EDGE));
  const height = Math.max(1, Math.min(Math.ceil(viewport.height), maxEdge ?? MAX_VIEWPORT_EDGE));

  const editor = createOpenPencilEditor(document, {
    getViewportSize: () => ({ width, height }),
  });
  try {
    // Resolved against the staged copy rather than `import.meta.url`: in the bundle this module is a
    // chunk in `dist`, so the vendored snapshot's directories are not beside it.
    const ck = await getCanvasKit({
      locateFile: () => findCanvasAsset("canvaskit.wasm", ["src"]),
    });
    // `replaceSurface` deletes the surface it replaces, so the constructor gets a throwaway 1x1 rather
    // than the real one; reusing that would delete the surface we are about to render into.
    const surface = ck.MakeSurface(width, height);
    if (surface === null) {
      throw new Error("CanvasKit could not allocate a viewport surface.");
    }
    const renderer = new SkiaRenderer(ck, ck.MakeSurface(1, 1), null);
    const pageId = editor.graph.getPages()[0]?.id;
    if (pageId === undefined) {
      throw new Error("The design has no page to render.");
    }
    renderer.replaceSurface(surface);
    renderer.pageId = pageId;
    await renderer.loadFonts();

    // The renderer works in design units scaled by zoom, so a viewport of N design units is drawn at
    // `1` zoom and the surface is sized to the viewport's pixel size.
    // `render()` derives `worldViewport` from the renderer's pan and zoom rather than reading it, so a
    // viewport assigned directly is overwritten on the first frame and a scrolled render silently
    // matches an unscrolled one. The state below is the input that derivation actually takes:
    // worldViewport = (-pan/zoom, -pan/zoom, width/zoom, height/zoom).
    renderer.zoom = 1;
    renderer.panX = -viewport.x;
    renderer.panY = -viewport.y;
    renderer.viewportWidth = width;
    renderer.viewportHeight = height;
    const restoreTextMeasurer = await renderer.prepareForExport(
      editor.graph,
      pageId,
      nodeIds as string[],
    );
    try {
      renderer.render(editor.graph, new Set());
    } finally {
      restoreTextMeasurer?.();
    }
    return nodeIds.map((nodeId) => ({
      nodeIds: [nodeId],
      data: base64Of(surface.makeImageSnapshot().encodeToBytes()),
      width,
      height,
    }));
  } finally {
    editor.destroy?.();
  }
};

/**
 * Canvas's exporter insists an export destination is an absolute POSIX path, which a Windows drive
 * letter never is. Converting at the boundary keeps the engine's contract while letting DAK export
 * on every platform it ships on. The extended-length form is what Windows accepts for a fully
 * qualified path written with forward slashes.
 */
const makePathCodec = (platform: NodeJS.Platform) => ({
  toEngine: (path: string): string =>
    platform === "win32" ? `//?/${path.replaceAll("\\", "/")}` : path,
  fromEngine: (path: string): string =>
    platform === "win32" && path.startsWith("//?/") ? path.slice(4).replaceAll("/", "\\") : path,
});

/** The engine reports a free-form severity, so an unknown one is narrowed rather than trusted. */
const toSeverity = (value: string | undefined): NonNullable<CanvasEngineIssue["severity"]> =>
  value === "critical" || value === "major" || value === "minor" || value === "info"
    ? value
    : "minor";

const normalizeIssue = (finding: {
  readonly nodeId?: string;
  readonly kind?: string;
  readonly severity?: string;
  readonly message?: string;
}): CanvasEngineIssue => ({
  ...(finding.nodeId === undefined ? {} : { nodeId: finding.nodeId }),
  kind: finding.kind ?? "other",
  severity: toSeverity(finding.severity),
  message: finding.message ?? "",
});

/** The blank document's first top-level frame is what an agent authors into. */
const starterFrameIdOf = (document: CanvasDocument, fallbackId: string): string => {
  const children = (document as { children?: ReadonlyArray<{ id?: unknown }> } | null)?.children;
  const first = children?.[0]?.id;
  return typeof first === "string" && first.length > 0 ? first : fallbackId;
};

const toScreenshots = (
  images: ReadonlyArray<{
    readonly nodeIds: ReadonlyArray<string>;
    readonly width: number;
    readonly height: number;
    readonly data: string;
  }>,
): ReadonlyArray<CanvasEngineScreenshot> =>
  images.map((image) => ({
    nodeIds: image.nodeIds,
    width: image.width,
    height: image.height,
    mimeType: "image/png" as const,
    data: image.data,
  }));

export interface CanvasEngineOptions {
  /** The host platform, injectable so the export-path encoding can be tested off Windows. */
  readonly platform?: NodeJS.Platform | undefined;
}

export const make = (options: CanvasEngineOptions = {}): CanvasEngine => {
  const paths = makePathCodec(options.platform ?? HostProcessPlatform.defaultValue());
  // Registered once per process, before any render touches the engine. Without it a viewport render
  // reaches the vendored `fetchBundledFont`, which imports a package nothing depends on; the
  // screenshot path happens to install its own loader internally, so this is what keeps the two
  // paths resolving the same faces.
  registerCanvasHostFonts({
    directories: [
      // Faces are staged flat beside the bundle under the name the engine asks for, so that directory
      // is searched directly; the snapshot's own directories cover a dev run.
      canvasAssetPaths.moduleDir(),
      NodePath.join(canvasAssetPaths.upstreamDir(), "src"),
      NodePath.join(canvasAssetPaths.upstreamDir(), "vendor", "open-pencil", "fonts"),
      canvasAssetPaths.dakFontsDir(),
    ],
  });
  const createBlankDocument = async (input: {
    module: CanvasModule;
    preset?: "a4" | "letter" | undefined;
  }) => {
    const document = createBlankDocumentSource({
      module: input.module,
      ...(input.preset === undefined ? {} : { preset: input.preset }),
    });
    // A blank document that cannot validate would be stored and then fail on every read, so it is
    // refused at the source instead.
    validateCanvasDocument(document);
    const model = createDocumentModel(document);
    try {
      return {
        document,
        state: encodeState(model),
        starterFrameId: starterFrameIdOf(document, "frame-1"),
      };
    } finally {
      model.doc.destroy();
    }
  };

  const execute = async (input: {
    payload: CanvasDocumentPayload;
    code: string;
    module: CanvasModule;
  }): Promise<CanvasScriptResult> => {
    const model = restoreDocumentModel(input.payload);
    try {
      const document = materialize(model);
      const execution = await executeCanvasScript(document, input.code);

      if (!execution.changed) {
        return {
          changed: false,
          document,
          prints: execution.prints,
          result: execution.result,
          touchedNodeIds: execution.touchedNodeIds,
          issues: [],
          screenshots: [],
          forward: "",
          inverse: "",
          state: encodeState(model),
        };
      }

      // The clone is validated before anything is returned as committable, so an invalid result is
      // refused here rather than becoming a stored document that fails on the next read. The code is
      // attached so the service can tell the agent to correct the design rather than the script.
      try {
        validateCanvasDocument(execution.document);
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
          code: "CANVAS_SCHEMA_INVALID",
        });
      }

      // Forward and inverse are computed from the very model the script ran against, so the inverse
      // is a faithful undo of the forward and the pair can be appended as one coherent mutation.
      const updates = createDocumentOperationUpdates(model, execution.document);
      // Applying the forward update to the model this execution already holds is the cheapest way
      // to know the state a compaction would record, and the model is destroyed right after.
      Y.applyUpdate(model.doc, updates.forward);
      const state = encodeState(model);

      const issues = reviewDocumentIssues(execution.document).map(normalizeIssue);

      const screenshots =
        execution.screenshots.length === 0
          ? []
          : toScreenshots(
              await takeDocumentScreenshots(
                execution.document,
                execution.screenshots.map((request) => ({ nodeIds: request.nodeIds })),
              ),
            );

      return {
        changed: true,
        document: execution.document,
        prints: execution.prints,
        result: execution.result,
        touchedNodeIds: execution.touchedNodeIds,
        issues,
        screenshots,
        forward: base64Of(updates.forward),
        inverse: base64Of(updates.inverse),
        state,
      };
    } finally {
      model.doc.destroy();
    }
  };

  const materializeDocument = async (payload: CanvasDocumentPayload): Promise<CanvasDocument> => {
    const model = restoreDocumentModel(payload);
    try {
      return materialize(model);
    } finally {
      model.doc.destroy();
    }
  };

  const renderFrames = async (input: {
    payload: CanvasDocumentPayload;
    nodeIds: ReadonlyArray<string>;
    maxEdge?: number | undefined;
    viewport?: CanvasViewport | undefined;
  }): Promise<ReadonlyArray<CanvasEngineScreenshot>> => {
    if (input.nodeIds.length === 0) return [];
    const document = await materializeDocument(input.payload);
    if (input.viewport !== undefined) {
      return toScreenshots(
        await renderViewport(document, input.nodeIds, input.viewport, input.maxEdge),
      );
    }
    return toScreenshots(
      await takeDocumentScreenshots(
        document,
        input.nodeIds.map((nodeIds) => ({ nodeIds: [nodeIds] })),
        undefined,
        input.maxEdge === undefined ? {} : { maxDimension: input.maxEdge },
      ),
    );
  };

  const extract = async (input: {
    payload: CanvasDocumentPayload;
    nodeIds: ReadonlyArray<string>;
    format: "png" | "svg" | "pdf";
    destination: string;
    scale?: number | undefined;
  }) => {
    const document = await materializeDocument(input.payload);
    const destination = paths.toEngine(input.destination);
    const report =
      input.nodeIds.length === 1
        ? await extractDocumentNode(document, {
            nodeId: input.nodeIds[0]!,
            format: input.format,
            destination,
            ...(input.scale === undefined ? {} : { scale: input.scale }),
          })
        : await extractDocumentNodes(document, {
            node: input.nodeIds,
            format: input.format,
            destination,
            ...(input.scale === undefined ? {} : { scale: input.scale }),
          });
    return {
      // Reported back in the caller's own path form, so nothing downstream sees the encoding trick.
      artifacts: report.artifacts.map(paths.fromEngine),
      consequences: report.consequences ?? [],
      rasterized: report.rasterized ?? [],
    };
  };

  return {
    createBlankDocument,
    execute,
    materialize: materializeDocument,
    renderFrames,
    extract,
  };
};
