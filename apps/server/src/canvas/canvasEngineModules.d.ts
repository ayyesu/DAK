/**
 * Types for the vendored Canvas engine.
 *
 * The engine is plain `.mjs` served straight from `packages/canvas-engine/upstream`, so this is the
 * seam where an untyped third-party runtime becomes something DAK can hold to a contract. Only the
 * functions DAK actually calls are declared; the rest of the engine stays opaque on purpose.
 *
 * `CanvasDocument` is deliberately `unknown` here and in the contracts. Canvas owns a recursive,
 * cascade-aware document schema with its own semantic validation, and re-declaring it in TypeScript
 * would create a second authority that drifts the first time upstream changes a field.
 */

declare module "@dak/canvas-engine/upstream/src/blank-document.mjs" {
  export function createBlankDocumentSource(input?: {
    readonly id?: string;
    readonly module?: string;
    readonly preset?: string;
  }): unknown;
}

declare module "@dak/canvas-engine/upstream/src/canvas-schema.mjs" {
  export function validateCanvasDocument(document: unknown): void;
  export const CANVAS_MODULES: readonly string[];
  export const CANVAS_ROLES: readonly string[];
}

declare module "@dak/canvas-engine/upstream/src/document-model.mjs" {
  export interface CanvasDocumentPayload {
    readonly snapshot: {
      readonly state: string;
      readonly throughSequence: number;
      readonly source?: unknown;
    };
    readonly updates?: ReadonlyArray<{ readonly sequence: number; readonly update: string }>;
  }
  export interface CanvasModelHandle {
    readonly doc: { destroy: () => void };
  }
  export const Y: {
    applyUpdate(doc: unknown, update: Uint8Array): void;
  };
  export function createDocumentModel(source: unknown): CanvasModelHandle;
  export function restoreDocumentModel(payload: CanvasDocumentPayload): CanvasModelHandle;
  export function materialize(model: CanvasModelHandle): unknown;
  export function encodeState(model: CanvasModelHandle): string;
  export function createDocumentOperationUpdates(
    model: CanvasModelHandle,
    document: unknown,
  ): { readonly forward: Uint8Array; readonly inverse: Uint8Array };
}

declare module "@dak/canvas-engine/upstream/src/script-runtime.mjs" {
  export interface CanvasScriptExecution {
    readonly document: unknown;
    readonly changed: boolean;
    readonly prints: ReadonlyArray<unknown>;
    readonly result: unknown;
    readonly touchedNodeIds: ReadonlyArray<string>;
    readonly generations: ReadonlyArray<unknown>;
    readonly svgConversions: ReadonlyArray<unknown>;
    readonly screenshots: ReadonlyArray<{ readonly nodeIds: ReadonlyArray<string> }>;
  }
  export function executeCanvasScript(
    document: unknown,
    code: string,
    inspection?: Record<string, unknown>,
  ): Promise<CanvasScriptExecution>;
  export function scriptNeedsInspection(code: string): boolean;
}

declare module "@dak/canvas-engine/upstream/src/document-review.mjs" {
  export interface CanvasReviewFinding {
    readonly nodeId?: string;
    readonly kind?: string;
    readonly message?: string;
    readonly severity?: string;
    readonly suggestion?: string;
  }
  export function reviewDocumentIssues(document: unknown): ReadonlyArray<CanvasReviewFinding>;
  export function designValidationIssues(document: unknown): ReadonlyArray<CanvasReviewFinding>;
}

declare module "@dak/canvas-engine/upstream/src/document-inspection.mjs" {
  export function inspectDocument(
    document: unknown,
    nodes: unknown,
    requestedLimit?: number,
    nodeIds?: ReadonlyArray<string>,
  ): unknown;
}

declare module "@dak/canvas-engine/upstream/src/document-screenshot.mjs" {
  export interface CanvasScreenshotImage {
    readonly nodeIds: ReadonlyArray<string>;
    readonly width: number;
    readonly height: number;
    readonly mimeType: string;
    readonly data: string;
  }
  export function takeDocumentScreenshots(
    document: unknown,
    requests: ReadonlyArray<{
      readonly nodeIds: ReadonlyArray<string>;
      readonly bounds?: unknown;
    }>,
    assets?: Map<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<ReadonlyArray<CanvasScreenshotImage>>;
  export function rasterizeSvgImage(bytes: Uint8Array, options?: unknown): Promise<Uint8Array>;

  /**
   * The shaper's own output for each requested text node.
   *
   * A `Map`, not an object: `JSON.stringify` renders a Map as `{}`, which is how an earlier probe
   * reported an empty measurement for a document full of text.
   */
  export function measureDocumentText(
    document: unknown,
    nodeIds: ReadonlyArray<string>,
    assets?: Map<string, unknown>,
  ): Promise<{
    readonly graph: unknown;
    readonly textLayouts: Map<
      string,
      {
        readonly width: number;
        readonly height: number;
        readonly offsetY: number;
        readonly fontHashes: Record<string, string>;
        readonly lines: ReadonlyArray<{
          readonly baseline: number;
          readonly top: number;
          readonly bottom: number;
          readonly runs: ReadonlyArray<{
            readonly size: number;
            readonly glyphs: ReadonlyArray<unknown>;
            readonly positions: ReadonlyArray<number>;
          }>;
        }>;
      }
    >;
  }>;
}

declare module "@dak/canvas-engine/upstream/src/export-service.mjs" {
  export interface CanvasArtifactReport {
    readonly artifacts: ReadonlyArray<string>;
    readonly consequences?: ReadonlyArray<string>;
    readonly rasterized?: ReadonlyArray<string>;
    readonly format?: string;
    readonly width?: number;
    readonly height?: number;
  }
  export function extractDocumentNode(
    document: unknown,
    request: {
      readonly nodeId: string;
      readonly format: "png" | "svg" | "pdf";
      readonly destination: string;
      readonly scale?: number;
      readonly modes?: Readonly<Record<string, string>>;
      readonly imports?: Readonly<Record<string, unknown>>;
    },
    options?: Record<string, unknown>,
  ): Promise<CanvasArtifactReport>;
  export function extractDocumentNodes(
    document: unknown,
    request: {
      readonly node: ReadonlyArray<string>;
      readonly format: "png" | "svg" | "pdf";
      readonly destination: string;
      readonly scale?: number;
    },
    options?: Record<string, unknown>,
  ): Promise<CanvasArtifactReport>;
  export function exportDocument(
    document: unknown,
    request: {
      readonly role: "slide" | "route" | "ios" | "android";
      readonly frames: ReadonlyArray<string>;
      readonly destination: string;
      readonly modes?: Readonly<Record<string, string>>;
      readonly bindings?: Readonly<Record<string, unknown>>;
      readonly imports?: Readonly<Record<string, unknown>>;
    },
    options?: Record<string, unknown>,
  ): Promise<CanvasArtifactReport>;
}
