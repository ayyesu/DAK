import type { CanvasModule } from "@dak/contracts";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

/**
 * The two things Canvas needs that DAK does not own: the engine that understands a design
 * document, and somewhere to keep one.
 *
 * Both are interfaces rather than direct calls so the service's decisions — the ones that decide
 * whether an agent's edit is applied, refused, or retried — can be tested without CanvasKit and
 * QuickJS, and so the engine can be re-pinned without touching orchestration.
 *
 * The seam is a *payload* rather than a materialized document. Canvas keeps the truth in an
 * append-only log of Yjs updates plus a snapshot it compacts into, and the projection JSON a
 * snapshot carries is allowed to lag. Anything that reads only the projection can be handed stale
 * state, so the payload travels whole and both sides hydrate from the same bytes.
 */

/** A design document as the engine models it. The engine owns this shape, not the contracts. */
export type CanvasDocument = unknown;

/** One committed mutation. The inverse is what makes the mutation undoable later. */
export interface CanvasStoredUpdate {
  readonly sequence: number;
  /** Base64 Yjs update. Applying it to the snapshot produces the document at this sequence. */
  readonly update: string;
  readonly clientUpdateId: string;
  readonly operationId?: string;
  readonly inverseUpdate?: string;
}

/** The compaction artifact. `source` is the readable projection, which may lag `throughSequence`. */
export interface CanvasSnapshot {
  readonly throughSequence: number;
  /** Base64 Yjs state. Applying every `update` newer than `throughSequence` produces the head. */
  readonly state: string;
  /** Readable projection, for git diffs and debugging. Never authoritative on its own. */
  readonly source: unknown;
}

/**
 * Everything the engine needs to reconstruct the document at its authoritative sequence.
 *
 * `authoritativeSequence` is `max(snapshot.throughSequence, every update sequence)`, which is also
 * the crash-recovery rule: a compaction that failed after its append committed leaves the snapshot
 * behind, and the max simply wins.
 */
export interface CanvasDocumentPayload {
  readonly snapshot: CanvasSnapshot;
  readonly updates: ReadonlyArray<CanvasStoredUpdate>;
}

export interface CanvasStoredDocument {
  readonly id: string;
  readonly title: string;
  readonly module: CanvasModule;
  readonly sequence: number;
  /** False when committed updates exist that the projection has not absorbed. */
  readonly projectionCurrent: boolean;
  readonly trashed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CanvasAppendResult {
  readonly sequence: number;
  /** True when this `clientUpdateId` was already applied, so nothing was written twice. */
  readonly duplicate: boolean;
}

export interface CanvasAppendInput {
  readonly documentId: string;
  readonly clientUpdateId: string;
  /** Base64 Yjs update produced by the engine for this mutation. */
  readonly update: string;
  readonly operationId: string;
  readonly inverseUpdate: string;
  /** The sequence the agent wrote against; the store refuses the write if it moved. */
  readonly expectedSequence: number;
}

/**
 * A committed change to one document, published so a live view knows its sequence moved.
 *
 * `title` and `module` travel with it because the design view that reacts to a change usually does
 * not know the document yet — that is the whole point of following activity rather than naming an
 * id — and a tab that has to wait for a render before it can be labelled reads as a blank tab the
 * agent left behind.
 */
export interface CanvasDocumentChange {
  readonly documentId: string;
  readonly sequence: number;
  readonly trashed: boolean;
  readonly title: string;
  readonly module: CanvasModule;
}

/**
 * A change with the project it belongs to.
 *
 * The store is built per project and does not know one; the bus serves the whole environment and
 * has to, so a subscriber can tell another project's design from its own. The project is attached
 * where the two meet, in `CanvasProjects`.
 */
export interface CanvasActivity extends CanvasDocumentChange {
  readonly projectId: string;
}

export interface CanvasStore {
  /**
   * Committed changes, as an effectful stream. A store without one (a test double, or a store
   * built for a single call) reports nothing, which a viewer treats as "no live updates" rather
   * than as an error.
   */
  readonly changes?: Stream.Stream<CanvasDocumentChange, never, Scope.Scope> | undefined;
  readonly listDocuments: (input: {
    readonly query?: string;
    readonly limit?: number;
    readonly includeTrash?: boolean;
  }) => Promise<readonly CanvasStoredDocument[]>;
  readonly getDocument: (documentId: string) => Promise<CanvasStoredDocument>;
  /** The whole payload, so the engine never has to guess whether the projection is current. */
  readonly getDocumentForExecution: (documentId: string) => Promise<{
    readonly summary: CanvasStoredDocument;
    readonly payload: CanvasDocumentPayload;
  }>;
  readonly createDocument: (input: {
    readonly title: string;
    readonly module: CanvasModule;
    readonly snapshot: CanvasSnapshot;
    readonly starterFrameId: string;
  }) => Promise<{ readonly documentId: string }>;
  readonly appendUpdate: (input: CanvasAppendInput) => Promise<CanvasAppendResult>;
  readonly undoOperation: (input: {
    readonly documentId: string;
    readonly operationId?: string;
    readonly expectedSequence: number;
  }) => Promise<{
    readonly operationId: string;
    readonly sequence: number;
    readonly update: string;
    readonly inverseUpdate: string;
  }>;
  /** Compaction. Never allowed to fail a mutation that already committed. */
  readonly createSnapshot: (input: {
    readonly documentId: string;
    readonly throughSequence: number;
    /** Base64 Yjs state at `throughSequence`, so a reader can restore without replaying the log. */
    readonly state: string;
    readonly projection: CanvasDocument;
  }) => Promise<void>;
  readonly trashDocument: (documentId: string) => Promise<void>;
  readonly restoreDocument: (documentId: string) => Promise<void>;
  /** Whether a path already exists. The store owns filesystem access for Canvas. */
  readonly pathExists: (path: string) => Promise<boolean>;
}

/** One structural problem the engine found, such as overflow, overlap, or poor contrast. */
export interface CanvasEngineIssue {
  readonly nodeId?: string;
  readonly kind?: string;
  readonly severity?: "critical" | "major" | "minor" | "info";
  readonly message?: string;
}

/**
 * A window onto a design, in design coordinates.
 *
 * `x`/`y` are the design-space point the viewport's top-left corner sits at, and `width`/`height` are
 * the size of the window in the same units — so zooming in means asking for a smaller window at the
 * same point, and scrolling means moving the point. Sizes are bounded by the engine's raster cap, so
 * a caller that asks for more than that gets a scaled-down window rather than a giant image.
 */
export interface CanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The widest and tallest a single raster may be, in device pixels.
 *
 * The vendored exporter refuses anything larger, and it refuses by throwing rather than by
 * shrinking. A region that exceeds it has to fail with a clear message: quietly returning a
 * narrower strip than the caller asked for is how a screenshot ends up showing part of a design
 * with nothing saying so.
 */
export const CANVAS_RASTER_CAP = 8192;

/** One rendered region of a document, in design units and a scale applied on top. */
export interface CanvasRegionRequest {
  readonly bounds: CanvasViewport;
  readonly scale?: number | undefined;
}

export interface CanvasEngineScreenshot {
  readonly nodeIds: ReadonlyArray<string>;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/png";
  /** Base64 PNG. Travels as MCP image content, never inside a structured payload. */
  readonly data: string;
}

export interface CanvasScriptResult {
  readonly changed: boolean;
  /** The document the script produced, on a private clone. */
  readonly document: CanvasDocument;
  readonly prints: ReadonlyArray<unknown>;
  readonly result: unknown;
  readonly touchedNodeIds: ReadonlyArray<string>;
  /** Every issue found, so the service can sample and count them without re-inspecting. */
  readonly issues: ReadonlyArray<CanvasEngineIssue>;
  readonly screenshots: ReadonlyArray<CanvasEngineScreenshot>;
  /**
   * The forward and inverse Yjs updates for this mutation, base64. Both are produced from the same
   * model the script ran against, so the inverse is guaranteed to be a real undo of the forward.
   * Empty when `changed` is false.
   */
  readonly forward: string;
  readonly inverse: string;
  /**
   * Base64 Yjs state at the head this execution produced (or the unchanged head), so the caller can
   * compact without replaying the log.
   */
  readonly state: string;
}

export interface CanvasEngine {
  /**
   * Builds a blank document together with the initial state a store needs to record it, and the id
   * of the first frame so the agent can author into it without a second round trip.
   */
  readonly createBlankDocument: (input: {
    readonly module: CanvasModule;
    readonly preset?: "a4" | "letter" | undefined;
  }) => Promise<{
    readonly document: CanvasDocument;
    readonly state: string;
    readonly starterFrameId: string;
  }>;

  /**
   * Runs bounded JavaScript against a private copy and returns the result plus the updates that
   * would commit it. Nothing the script produced is visible to anyone else, so a script that throws
   * leaves the stored document untouched, and a result that fails validation is refused here.
   */
  readonly execute: (input: {
    readonly payload: CanvasDocumentPayload;
    readonly code: string;
    readonly module: CanvasModule;
  }) => Promise<CanvasScriptResult>;

  /** The readable document at the payload's authoritative sequence, for viewers and export. */
  readonly materialize: (payload: CanvasDocumentPayload) => Promise<CanvasDocument>;

  /**
   * Rasterizes the payload's top-level frames, for a client view. This is a viewer path rather
   * than an agent one: it renders whatever the payload holds, so a design that is mid-authoring
   * still shows. The engine owns the frame's own size and reports it back.
   */
  readonly renderFrames: (input: {
    readonly payload: CanvasDocumentPayload;
    readonly nodeIds: ReadonlyArray<string>;
    /** Cap on the rendered edge length. The engine also enforces its own maximum. */
    readonly maxEdge?: number | undefined;
    /**
     * The scale to rasterize each frame at, relative to the frame's own size: 2 is twice as many
     * pixels across. The engine draws text and shapes at this scale, so it is detail rather than
     * interpolation. Clamped by `maxEdge` after it is applied.
     */
    readonly scale?: number | undefined;
    /**
     * A window onto the design, in design coordinates, rather than the whole thing.
     *
     * A page taller than the raster cap cannot be shown legibly in one image: fitting 4400px of
     * layout into 2048px makes text unreadable, which is worse than showing less. Asking for a
     * viewport is how the panel pans and zooms the way Penkra's own surface does, instead of
     * approximating it with a stack of slices it then has to assemble.
     */
    readonly viewport?: CanvasViewport | undefined;
  }) => Promise<ReadonlyArray<CanvasEngineScreenshot>>;

  /** Writes one PNG, SVG, or PDF artifact inside the workspace. The path is checked before this. */
  readonly extract: (input: {
    readonly payload: CanvasDocumentPayload;
    readonly nodeIds: ReadonlyArray<string>;
    readonly format: "png" | "svg" | "pdf";
    readonly destination: string;
    readonly scale?: number | undefined;
  }) => Promise<{
    readonly artifacts: ReadonlyArray<string>;
    readonly consequences: ReadonlyArray<string>;
    readonly rasterized: ReadonlyArray<string>;
  }>;

  /**
   * Rasterizes one region of a node at a chosen scale, and nothing else.
   *
   * The single raster primitive. A whole-frame render is this with the frame's own bounds; a
   * screenshot of a selector is this with the selector's bounds; a tile is this with the tile's
   * bounds. Having one is the only way those three can be relied on to agree — three call sites
   * with three sets of defaults is how a panel ends up disagreeing with an export.
   *
   * The document is normalized before it is drawn, so a region of a panel, a region of a
   * screenshot and a region of an export are all cut from the same geometry.
   */
  readonly renderRegion: (input: {
    readonly payload: CanvasDocumentPayload;
    readonly nodeId: string;
    readonly bounds: CanvasViewport;
    readonly scale?: number | undefined;
    /** Cap on the rendered edge length, applied after the scale. */
    readonly maxEdge?: number | undefined;
  }) => Promise<{
    readonly width: number;
    readonly height: number;
    readonly data: string;
    readonly mimeType: "image/png";
  }>;
}
