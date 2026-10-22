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
import { preloadCanvasHostFonts } from "./CanvasHostFonts.ts";
import { CANVAS_RASTER_CAP } from "./CanvasPorts.ts";
import {
  detectFrameOverflow,
  detectModuleViewportMismatch,
  type CanvasReviewIssue,
} from "./canvasInvariants.ts";
import { normalizeForRender, normalizedDocument } from "./canvasNormalize.ts";
import {
  absoluteBoxes,
  findEmptyButtonShapes,
  measureTextNodes,
  textNodeIds,
  type MeasuredText,
} from "./canvasText.ts";

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

const normalizeIssue = (finding: CanvasReviewIssue): CanvasEngineIssue => ({
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

/**
 * Problems that need measured text: shapes with no label, and text whose box is too small for the
 * lines the shaper actually produced.
 *
 * Both are measured rather than estimated, because both failed as estimates: a text width guessed
 * from character count flagged three nodes that fit perfectly well, and a button cannot be told from
 * a decorative panel by counting characters at all.
 */
const measuredIssues = async (
  document: CanvasDocument,
  measured: ReadonlyMap<string, MeasuredText>,
): Promise<ReadonlyArray<CanvasEngineIssue>> => {
  const ids = textNodeIds(document);
  if (ids.length === 0) return [];
  const boxes = absoluteBoxes(document, measured);
  const issues: CanvasEngineIssue[] = [];

  for (const shape of findEmptyButtonShapes(document, boxes)) {
    issues.push({
      nodeId: shape.id,
      kind: "empty_control",
      severity: "major",
      message:
        `Shape ${JSON.stringify(shape.id)} is a filled ${shape.width}x${Math.round(shape.height)} ` +
        `rectangle with no text on it, so it reads as a button the user cannot read. Give it a text ` +
        `node, or remove it if it was meant to be decoration.`,
    });
  }

  for (const id of ids) {
    const entry = measured.get(id);
    if (entry === undefined) continue;
    const node = findIn(document, id);
    if (node === undefined) continue;
    const declaredHeight = typeof node.height === "number" ? node.height : undefined;
    if (declaredHeight !== undefined && entry.derivedHeight > declaredHeight + 1) {
      issues.push({
        nodeId: id,
        kind: "text_overflow",
        severity: "major",
        message:
          `Text ${JSON.stringify(id)} needs ${entry.derivedHeight}px for its ${entry.lines} wrapped ` +
          `line(s) but is ${declaredHeight}px tall, so the last line is clipped. Give it a height of ` +
          `${entry.derivedHeight} or more.`,
      });
    }
  }
  return issues;
};

/**
 * The structural problems the renderer would show but the engine's own review does not report.
 *
 * Returned on the edit that causes them rather than at review time, because by then the agent has
 * usually moved on and the cost of a wrong layout is invisible until the export fails.
 */
const structuralIssues = (document: CanvasDocument): ReadonlyArray<CanvasEngineIssue> =>
  [...detectFrameOverflow(document), ...detectModuleViewportMismatch(document)].map(normalizeIssue);

const childrenArray = (document: unknown): ReadonlyArray<unknown> =>
  Array.isArray((document as { children?: unknown }).children)
    ? (document as { children: ReadonlyArray<unknown> }).children
    : [];

const findIn = (document: unknown, id: string): Record<string, unknown> | undefined => {
  const visit = (node: unknown): Record<string, unknown> | undefined => {
    const candidate = node as { id?: unknown; children?: unknown };
    if (candidate.id === id) return candidate as Record<string, unknown>;
    for (const child of childrenArray(candidate)) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const child of childrenArray(document)) {
    const found = visit(child);
    if (found !== undefined) return found;
  }
  return undefined;
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
  const fontDirectories = [
    // Faces are staged flat beside the bundle under the name the engine asks for, so that directory
    // is searched directly; the snapshot's own directories cover a dev run.
    canvasAssetPaths.moduleDir(),
    NodePath.join(canvasAssetPaths.upstreamDir(), "src"),
    NodePath.join(canvasAssetPaths.upstreamDir(), "vendor", "open-pencil", "fonts"),
    canvasAssetPaths.dakFontsDir(),
  ];
  registerCanvasHostFonts({ directories: fontDirectories });
  // Every shipped face into the engine's font cache, so the screenshot/measure path — which
  // installs its own loader over the one above and names none of the DAK-owned families — still
  // draws DAK's bytes rather than fetching the family from the network. Awaited inside
  // `measureTextNodes`, which every render path funnels through; a missing shipped face rejects
  // there instead of limping on a fallback.
  preloadCanvasHostFonts(fontDirectories);
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

      // The commit path normalizes for reporting and rasterizing but does NOT write the measured
      // heights back: doing so turned every silent text node into its own mutation, so a single
      // author edit advanced the sequence by dozens and filled the log with changes nobody made.
      // The document committed is exactly the document the script produced.
      //
      // Deliberately uncached: an execution has no document identity yet, and keying it on a
      // placeholder would hand the next unrelated edit the previous one's measurements.
      const rendered = (await normalizeForRender(execution.document)) as typeof execution.document;
      const measured = await measureTextNodes(rendered, textNodeIds(rendered));

      // Forward and inverse are computed from the very model the script ran against, so the inverse
      // is a faithful undo of the forward and the pair can be appended as one coherent mutation.
      const updates = createDocumentOperationUpdates(model, execution.document);
      // Applying the forward update to the model this execution already holds is the cheapest way
      // to know the state a compaction would record, and the model is destroyed right after.
      Y.applyUpdate(model.doc, updates.forward);
      const state = encodeState(model);

      const issues = [
        ...reviewDocumentIssues(rendered).map(normalizeIssue),
        ...structuralIssues(rendered),
        ...(await measuredIssues(rendered, measured)),
      ];

      const screenshots =
        execution.screenshots.length === 0
          ? []
          : toScreenshots(
              await takeDocumentScreenshots(
                rendered,
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
    scale?: number | undefined;
    viewport?: CanvasViewport | undefined;
  }): Promise<ReadonlyArray<CanvasEngineScreenshot>> => {
    if (input.nodeIds.length === 0) return [];
    const document = (
      await normalizedDocument({
        payload: input.payload,
        document: await materializeDocument(input.payload),
      })
    ).document as CanvasDocument;
    if (input.viewport !== undefined) {
      return toScreenshots(
        await renderViewport(document, input.nodeIds, input.viewport, input.maxEdge),
      );
    }
    const screenshotOptions: { scale?: number; maxDimension?: number } = {};
    // Undefined means the exporter's own default, which is 1. Passing it would be the same render.
    if (input.scale !== undefined) screenshotOptions.scale = input.scale;
    if (input.maxEdge !== undefined) screenshotOptions.maxDimension = input.maxEdge;
    return toScreenshots(
      await takeDocumentScreenshots(
        document,
        input.nodeIds.map((nodeIds) => ({ nodeIds: [nodeIds] })),
        undefined,
        screenshotOptions,
      ),
    );
  };

  /**
   * The one raster primitive.
   *
   * Everything that draws — a whole frame, a section of one, a selector, a future tile — is this
   * function with different bounds, so they cannot drift apart. The document goes through the same
   * normalization a panel view does, which is why a screenshot of a region is pixel-identical to
   * that region of the panel.
   */
  const renderRegion: CanvasEngine["renderRegion"] = async (
    input: Parameters<CanvasEngine["renderRegion"]>[0],
  ) => {
    const document = (
      await normalizedDocument({
        payload: input.payload,
        document: await materializeDocument(input.payload),
      })
    ).document as CanvasDocument;
    const scale = input.scale ?? 1;
    const width = Math.ceil(input.bounds.width * scale);
    const height = Math.ceil(input.bounds.height * scale);
    // The vendored exporter throws above this rather than shrinking, and a caller that was handed a
    // narrower strip than it asked for would not know. Refused here, with the number that overflowed.
    if (width > CANVAS_RASTER_CAP || height > CANVAS_RASTER_CAP) {
      throw Object.assign(
        new Error(
          `Region rasterizes to ${width}x${height}px, past the ${CANVAS_RASTER_CAP}px limit. ` +
            `Ask for a smaller region or a lower scale; nothing was rendered.`,
        ),
        { code: "CANVAS_REGION_TOO_LARGE" },
      );
    }
    const shots = await takeDocumentScreenshots(
      document,
      [
        {
          nodeIds: [input.nodeId],
          bounds: {
            minX: input.bounds.x,
            minY: input.bounds.y,
            maxX: input.bounds.x + input.bounds.width,
            maxY: input.bounds.y + input.bounds.height,
          },
        },
      ],
      undefined,
      {
        scale,
        ...(input.maxEdge === undefined ? {} : { maxDimension: input.maxEdge }),
      },
    );
    const shot = shots[0];
    if (shot === undefined) {
      throw Object.assign(new Error(`Node ${input.nodeId} produced no raster.`), {
        code: "CANVAS_REGION_EMPTY",
      });
    }
    return {
      width: shot.width,
      height: shot.height,
      data: shot.data,
      mimeType: "image/png" as const,
    };
  };

  const extract = async (input: {
    payload: CanvasDocumentPayload;
    nodeIds: ReadonlyArray<string>;
    format: "png" | "svg" | "pdf";
    destination: string;
    scale?: number | undefined;
  }) => {
    const document = (
      await normalizedDocument({
        payload: input.payload,
        document: await materializeDocument(input.payload),
      })
    ).document as CanvasDocument;
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
    renderRegion,
    extract,
  };
};
