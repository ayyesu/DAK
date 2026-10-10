/**
 * Deciding when a live design view re-renders.
 *
 * The server sends one sequence line per change and a fast agent produces dozens. Rendering on each
 * one would queue a rasterization per edit behind a view the user is still scrolling, so this
 * collapses a burst into a single render and keeps the last good frames on screen throughout.
 *
 * Kept as pure transitions rather than a hook so the burst, reorder, and reconnect behaviour can be
 * tested with fake timers and no renderer.
 */

/** How long a burst is allowed to keep pushing the render out, in milliseconds. */
export const CANVAS_RENDER_COALESCE_MS = 120;

export interface CanvasViewState {
  /** What is on screen now, or null before the first render lands. */
  readonly frames: readonly CanvasRenderedFrame[];
  /** The sequence those frames were rendered at. */
  readonly renderedSequence: number | null;
  /** The edge those frames were actually rasterized at, which the server may have lowered. */
  readonly renderedEdge: number | null;
  readonly title: string | null;
  /** The newest sequence the stream has reported, which may be ahead of what is on screen. */
  readonly observedSequence: number | null;
  readonly observedTrashed: boolean;
  /** True while a render is in flight. */
  readonly rendering: boolean;
  /** True when a newer sequence is known than the one on screen. */
  readonly stale: boolean;
  /** A render that failed, kept beside the last good frames rather than replacing them. */
  readonly error: string | null;
  /**
   * True only when the server said the design itself is gone.
   *
   * Kept apart from `error` because the two call for different things: a deleted design needs the
   * user to do something about it, while anything else needs the product to fix something.
   */
  readonly gone: boolean;
  /** Frames the last render left out, so a capped render does not read as a whole design. */
  readonly omittedFrames: number;
  /** True when the render on screen may lag the document it came from. */
  readonly projectionCurrent: boolean;
}

export interface CanvasRenderedFrame {
  readonly nodeId: string;
  readonly role?: string;
  readonly width: number;
  readonly height: number;
  readonly data: string;
  readonly sequence: number;
}

export const initialCanvasViewState: CanvasViewState = {
  frames: [],
  renderedSequence: null,
  renderedEdge: null,
  title: null,
  observedSequence: null,
  observedTrashed: false,
  rendering: false,
  stale: false,
  error: null,
  gone: false,
  omittedFrames: 0,
  projectionCurrent: true,
};

/**
 * A sequence the stream reported.
 *
 * Compared with `!==` rather than `>`: an undo, a restore, or a rollback can move a design back to a
 * sequence it held before, and a view that only reacted to growth would sit there showing a design
 * that no longer exists. Equality means "nothing moved", which is the common case and must not
 * repaint.
 */
export function applyCanvasSequence(
  state: CanvasViewState,
  next: { readonly sequence: number; readonly trashed: boolean },
): CanvasViewState {
  if (state.observedSequence === next.sequence && state.observedTrashed === next.trashed) {
    return state;
  }
  return {
    ...state,
    observedSequence: next.sequence,
    observedTrashed: next.trashed,
    stale: state.renderedSequence !== next.sequence,
  };
}

/**
 * Whether a render should start now.
 *
 * A view renders when it has nothing on screen, when the stream has moved past what it shows, or when
 * a previous render failed. It does not render on every subscription tick: an unchanged sequence must
 * not repaint, or a panel left open all day would repaint forever.
 */
export function shouldRenderCanvas(
  state: CanvasViewState,
  options: { readonly force?: boolean },
): boolean {
  if (options.force === true) return true;
  if (state.error !== null) return true;
  if (state.rendering) return false;
  if (state.renderedSequence === null) return true;
  return state.observedSequence !== null && state.observedSequence !== state.renderedSequence;
}

/**
 * Whether a settled render left an edit that still has not been rendered.
 *
 * `canvasRenderSettled` marks itself stale when a sequence arrived mid-render, but the request that
 * edit asked for was declined while a render was in flight, so nothing will ask again until some
 * later sequence happens to arrive. Without this the view holds the older frames indefinitely and
 * the staleness marker claims a catch-up that is never coming. A failed render is deliberately
 * excluded: `shouldRenderCanvas` retries a failure on the next sequence rather than immediately,
 * and doing it here would spin on a design the server cannot rasterize.
 */
export function canvasCatchUpDue(state: CanvasViewState): boolean {
  return state.stale && state.error === null && !state.rendering && !state.gone;
}

/**
 * A render started. The frames stay: a blank panel during an agent edit reads as a crash, so the
 * previous design remains visible and is marked stale until the new one lands.
 */
export function canvasRenderStarted(state: CanvasViewState): CanvasViewState {
  if (state.rendering) return state;
  return { ...state, rendering: true, error: null };
}

/**
 * A render finished.
 *
 * `requestId` is what makes this latest-wins. A render that was already in flight when a newer
 * sequence arrived resolves after the newer one, and letting it land would put older frames back on
 * screen with a newer sequence label — the view would then look current while showing a stale design.
 * A response that is not the newest request is dropped whole, frames and sequence together.
 */
export function canvasRenderSettled(
  state: CanvasViewState,
  result:
    | { readonly requestId: number; readonly ok: true; readonly rendered: CanvasRenderSettled }
    | {
        readonly requestId: number;
        readonly ok: false;
        readonly message: string;
        /** The server's stable failure code, so "deleted" is told apart from "could not read". */
        readonly code?: string | undefined;
      },
  latestRequestId: number,
): CanvasViewState {
  if (result.requestId !== latestRequestId) return state;
  if (!result.ok) {
    // The last good frames stay put. The marker says why they are old rather than blanking them.
    return {
      ...state,
      rendering: false,
      error: result.message,
      // Only the server's word makes a design gone. Treating every failure as a deletion is what
      // made a missing WebAssembly runtime read as "you deleted your design".
      gone: result.code === "document_not_found" || result.code === "document_deleted",
    };
  }
  const { rendered } = result;
  const observedSequence =
    state.observedSequence === null || rendered.sequence > state.observedSequence
      ? rendered.sequence
      : state.observedSequence;
  return {
    frames: rendered.frames,
    renderedSequence: rendered.sequence,
    renderedEdge: rendered.maxEdge,
    title: rendered.title,
    rendering: false,
    // An edit that landed while this render was in flight belongs to a sequence newer than the one
    // these frames came from. Reporting it as current would show a stale design under a fresh label,
    // so the staleness is derived rather than assumed and the caller asks for the follow-up.
    stale: observedSequence !== rendered.sequence,
    error: null,
    // A design that renders again is by definition not gone, whatever the last attempt said.
    gone: false,
    omittedFrames: rendered.omittedFrames,
    projectionCurrent: rendered.projectionCurrent,
    // Whether the design is in the trash outlives a render: dropping it here would swap the
    // recoverable "Restore it" notice for one that reads as a dead end.
    observedTrashed: state.observedTrashed,
    observedSequence,
  };
}

export interface CanvasRenderSettled {
  readonly frames: readonly CanvasRenderedFrame[];
  readonly sequence: number;
  /** The edge the server actually rasterized at, which is lower than asked when it reduced detail. */
  readonly maxEdge: number;
  readonly title: string;
  readonly omittedFrames: number;
  readonly projectionCurrent: boolean;
}

/**
 * Whether the view is showing something other than a live design: gone, or gone from a project.
 *
 * A persisted tab can outlive its design — the user trashes it, or removes the project — and must
 * land somewhere quiet rather than retrying a read that will never succeed.
 */
export function isCanvasGone(state: CanvasViewState): boolean {
  return state.gone && state.renderedSequence === null && state.frames.length === 0;
}

/**
 * Whether the server says this design is deleted, rather than merely unreadable.
 *
 * The panel used to answer "is it gone?" with "did anything go wrong?", which turned every failure
 * into "This design is no longer available" — a server that could not rasterise a design, or a
 * runtime missing its WebAssembly, was reported to the user as a design they had deleted. The
 * server already distinguishes the two with a stable `code`; collapsing them here threw that away
 * and sent people hunting for a design that was sitting on disk the whole time.
 */
export function isCanvasDeleted(state: CanvasViewState): boolean {
  return isCanvasGone(state) && state.gone;
}
