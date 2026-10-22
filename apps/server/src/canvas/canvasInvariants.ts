/**
 * The guarantees Canvas depends on, as pure decisions the service makes before it
 * touches a document.
 *
 * Each of these was implicit in the upstream operations layer rather than
 * written down anywhere, so they are pinned here with names and tests. Keeping
 * them pure also keeps them out of the socket and the sandbox, where they would
 * be untestable.
 */

/** The sequence a document is really at: the newest thing the server has accepted. */
export interface CanvasSequencePayload {
  readonly snapshot?: { readonly throughSequence?: number | undefined } | undefined;
  readonly updates?: ReadonlyArray<{ readonly sequence?: number | undefined }> | undefined;
}

/**
 * A snapshot compaction can fail after the update it describes has already
 * committed, so the projection may lag the log. The authoritative sequence is
 * the highest of both, which is also the recovery rule after a crash between an
 * append and its compaction.
 */
export function authoritativeSequence(payload: CanvasSequencePayload): number {
  return Math.max(
    Number(payload.snapshot?.throughSequence ?? 0),
    ...(payload.updates ?? []).map((update) => Number(update.sequence ?? 0)),
  );
}

/**
 * True when the projection reflects every update the server has accepted.
 *
 * This is a comparison, not a count. The update log is never truncated, so "the log is
 * non-empty" says only that the document has been edited once and stays true forever; the
 * projection actually lags only while compaction is behind the log, which is the short window
 * between an append committing and its snapshot being written, and the state a crashed compaction
 * leaves behind.
 */
export function isProjectionCurrent(payload: CanvasSequencePayload): boolean {
  const through = Number(payload.snapshot?.throughSequence ?? 0);
  const newest = (payload.updates ?? []).reduce(
    (highest, update) => Math.max(highest, Number(update.sequence ?? 0)),
    0,
  );
  return through >= newest;
}

/*
 * Implicit layout.
 *
 * The vendored renderer gives a frame with no `layout` key a horizontal auto-layout
 * (`node.layout ??= "horizontal"` in the lowering step), and auto-layout discards the x/y every
 * child was authored at. A design that reads correctly in its document model then renders as one
 * row of its sections: a 390x5250 page came back as a 15630x5251 strip, which no reviewer could
 * read and no exporter could write, because it exceeded the engine's raster limit.
 *
 * The key is what makes this recoverable at the adapter. `??=` only fires when the key is absent,
 * so "the author said nothing" is distinguishable from "the author said horizontal". Silence is
 * read as absolute placement; an explicit mode is honoured as written.
 */

interface CanvasNodeLike {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly layout?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly children?: unknown;
  readonly [key: string]: unknown;
}

const childrenOf = (node: CanvasNodeLike): ReadonlyArray<CanvasNodeLike> =>
  Array.isArray(node.children) ? (node.children as ReadonlyArray<CanvasNodeLike>) : [];

/** A numeric authored coordinate, which is the signal that the author placed this deliberately. */
const hasAuthoredPosition = (node: CanvasNodeLike): boolean =>
  typeof node.x === "number" || typeof node.y === "number";

/**
 * The layout a frame should actually be rendered with, or `undefined` to leave it to the engine.
 *
 * A frame is only overridden when it says nothing *and* at least one of its children carries an
 * authored coordinate. A frame that says `horizontal` or `vertical` is a deliberate choice and is
 * never touched, so an agent building a flex-driven page is unaffected.
 */
export function resolveImplicitLayout(node: CanvasNodeLike): "none" | undefined {
  if (node.type !== "frame") return undefined;
  if (node.layout !== undefined) return undefined;
  return childrenOf(node).some(hasAuthoredPosition) ? "none" : undefined;
}

/**
 * The document as it should be rendered, applying the implicit layout above at every level.
 *
 * Returns the input untouched when nothing needs changing, so an auto-layout document pays
 * nothing. When something does need changing the document is cloned first: this runs on the path
 * that rasterizes, and the document it is given may be the one an edit is about to commit.
 */
export function withImplicitAbsoluteLayout<T>(document: T): T {
  const needsRewrite = (node: unknown): boolean => {
    if (typeof node !== "object" || node === null) return false;
    const candidate = node as CanvasNodeLike;
    if (resolveImplicitLayout(candidate) !== undefined) return true;
    return childrenOf(candidate).some(needsRewrite);
  };
  const root = document as unknown as CanvasNodeLike;
  if (!needsRewrite(root)) return document;

  const rewrite = (node: CanvasNodeLike): CanvasNodeLike => {
    const layout = resolveImplicitLayout(node);
    return {
      ...node,
      ...(layout === undefined ? {} : { layout }),
      ...(Array.isArray(node.children)
        ? { children: (node.children as ReadonlyArray<CanvasNodeLike>).map(rewrite) }
        : {}),
    };
  };
  return rewrite(root) as unknown as T;
}

/**
 * How far past its own box a frame's content may reach on either axis.
 *
 * Per axis rather than by area, because the two failures look nothing alike in area: a page whose
 * sections were laid out in a row is 36 times too wide but only 3 times too large overall when the
 * page is tall, and area alone would have called that fine. A shadow or a deliberately bleeding
 * image is a fraction of a frame on both axes.
 */
const CANVAS_OVERFLOW_AXIS_LIMIT = 2;

/**
 * The absolute excess that counts as overflow at all, so a frame cannot be reported for a bleed of
 * a pixel or a rounding half-point.
 */
const CANVAS_OVERFLOW_MIN_EXCESS_PX = 8;

/** The width below which a frame counts as a phone viewport. */
const CANVAS_PHONE_WIDTH = 480;

const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const boxOf = (node: CanvasNodeLike): Box | undefined => {
  const x = numberOf(node.x);
  const y = numberOf(node.y);
  const width = numberOf(node.width);
  const height = numberOf(node.height);
  if (width === undefined || height === undefined) return undefined;
  return { left: x ?? 0, top: y ?? 0, right: (x ?? 0) + width, bottom: (y ?? 0) + height };
};

const unionOf = (left: Box | undefined, right: Box | undefined): Box | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return {
    left: Math.min(left.left, right.left),
    top: Math.min(left.top, right.top),
    right: Math.max(left.right, right.right),
    bottom: Math.max(left.bottom, right.bottom),
  };
};

/**
 * Content that leaves the frame it belongs to, reported rather than rendered quietly.
 *
 * The engine's own review does not catch this: a design whose sections were laid out in a row came
 * back with zero review issues while rendering as an unreadable strip. Measuring the document's
 * own boxes is what makes that loud, on the edit that caused it, where the agent can still act on
 * it.
 *
 * Each frame is measured against its own children, in its own coordinate space. A frame's `x`/`y`
 * place it in its parent and must not be mixed into that measurement, or every card that sits far
 * down a page looks like it overflows itself. A frame reports only its declared box upward, because
 * to its parent the frame is exactly that size and whatever is inside it is the frame's business.
 *
 * A node without both dimensions cannot be measured and is skipped; text nodes are the usual case,
 * since their height comes from the renderer's text metrics rather than from the document.
 */
export function detectFrameOverflow(document: unknown): ReadonlyArray<CanvasReviewIssue> {
  const issues: CanvasReviewIssue[] = [];
  const visit = (node: CanvasNodeLike): Box | undefined => {
    const own = boxOf(node);
    if (node.type !== "frame") return own;

    let content: Box | undefined;
    for (const child of childrenOf(node)) {
      const childBox = visit(child);
      if (childBox !== undefined) content = unionOf(content, childBox);
    }
    const width = numberOf(node.width);
    const height = numberOf(node.height);
    if (width !== undefined && height !== undefined && content !== undefined) {
      const contentWidth = content.right - content.left;
      const contentHeight = content.bottom - content.top;
      const wideBy = contentWidth / Math.max(1, width);
      const tallBy = contentHeight / Math.max(1, height);
      const overflowsWide =
        wideBy > CANVAS_OVERFLOW_AXIS_LIMIT && contentWidth - width > CANVAS_OVERFLOW_MIN_EXCESS_PX;
      const overflowsTall =
        tallBy > CANVAS_OVERFLOW_AXIS_LIMIT &&
        contentHeight - height > CANVAS_OVERFLOW_MIN_EXCESS_PX;
      if (overflowsWide || overflowsTall) {
        const worst = (overflowsWide ? wideBy : tallBy).toFixed(1);
        issues.push({
          nodeId: typeof node.id === "string" ? node.id : undefined,
          kind: "bounds_overflow",
          severity: "critical",
          message:
            `Frame ${JSON.stringify(node.id)} is ${width}x${height} but its content reaches ` +
            `${contentWidth.toFixed(0)}x${contentHeight.toFixed(0)}, ` +
            `${worst}x too large on one axis. A frame with no layout mode whose children carry ` +
            `their own x and y is read as absolute placement; a frame that should stack them needs ` +
            `an explicit layout ("vertical" to stack, "horizontal" for a row), or ` +
            `layoutPosition "absolute" on the children you placed by hand.`,
        });
      }
    }
    return own;
  };
  for (const child of childrenOf(document as CanvasNodeLike)) visit(child);
  return issues;
}

/**
 * Modules whose frames are reviewed at a known, wider width.
 *
 * `web` routes are read on a desktop or tablet screen, so a phone-width frame in one is a design
 * that will present wrong. `mobile` is the module that means phone, and `generic` has no width at
 * all — its presets run from a phone card to an A4 sheet — so neither is flagged here rather than
 * both being flagged for the same drawing.
 */
const WIDE_VIEWPORT_MODULES: ReadonlySet<string> = new Set(["web"]);

/**
 * One issue per cause, not one per frame.
 *
 * A page with six phone-width frames is one mistake — the module is wrong for the design — and six
 * copies of it bury the single fact the agent needs under a list that looks like six separate
 * problems. The frames are named in the message so the fix is still actionable.
 */
export function detectModuleViewportMismatch(document: unknown): ReadonlyArray<CanvasReviewIssue> {
  const module = (document as { readonly module?: unknown } | null)?.module;
  if (typeof module !== "string" || !WIDE_VIEWPORT_MODULES.has(module)) return [];
  const ids: string[] = [];
  const widths: number[] = [];
  const visit = (node: CanvasNodeLike): void => {
    // Only the frames that are the deliverable. A module describes the artifact as a whole, and a
    // card inside a phone-width page is not a separate artifact with its own wrong width.
    const box = boxOf(node);
    if (node.type === "frame" && node.role !== undefined && box !== undefined) {
      const width = box.right - box.left;
      if (width < CANVAS_PHONE_WIDTH) {
        ids.push(typeof node.id === "string" ? node.id : "(unnamed)");
        widths.push(width);
      }
    }
    for (const child of childrenOf(node)) visit(child);
  };
  for (const child of childrenOf(document as CanvasNodeLike)) visit(child);
  if (ids.length === 0) return [];
  return [
    {
      kind: "viewport_mismatch",
      severity: "major",
      message:
        `${ids.length} frame(s) are drawn at a phone width in a ${JSON.stringify(module)} design ` +
        `(${ids.map((id, index) => `${id} ${widths[index]}px`).join(", ")}). Either the module ` +
        `should be "mobile", or these frames should be drawn at the width a ${JSON.stringify(module)} ` +
        `deliverable is reviewed at. SetModule requires a design with no role-bearing frames, so ` +
        `clear the role on each frame first.`,
      ...(ids.length === 1 ? { nodeId: ids[0] } : { nodeIds: ids }),
    },
  ];
}

export interface CanvasReviewIssue {
  readonly nodeId?: string | undefined;
  /** Every node a grouped issue names, when one issue covers several. */
  readonly nodeIds?: ReadonlyArray<string> | undefined;
  readonly kind?: string | undefined;
  readonly severity?: string | undefined;
  readonly message?: string | undefined;
}

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

export interface CanvasIssueSample {
  /** Bounded so one bad edit cannot flood the agent's context. */
  readonly sample: ReadonlyArray<CanvasReviewIssue>;
  readonly total: number;
  readonly omitted: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly bySeverity: Readonly<Record<string, number>>;
}

/**
 * Issues the agent touched come first, then by severity, then in document order,
 * so a bounded sample still describes the edit it belongs to. Counts stay
 * complete regardless, because a truncated count reads as a complete one.
 */
export function summarizeReviewIssues(
  issues: ReadonlyArray<CanvasReviewIssue>,
  touchedNodeIds: ReadonlyArray<string>,
  sampleSize: number,
): CanvasIssueSample {
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const issue of issues) {
    const kind = issue.kind ?? "other";
    const severity = issue.severity ?? "unspecified";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
  }
  const touched = new Set(touchedNodeIds);
  const sample = issues
    .map((issue, index) => ({ issue, index }))
    .sort(
      (a, b) =>
        Number(touched.has(b.issue.nodeId ?? "")) - Number(touched.has(a.issue.nodeId ?? "")) ||
        (SEVERITY_RANK[a.issue.severity ?? ""] ?? 4) -
          (SEVERITY_RANK[b.issue.severity ?? ""] ?? 4) ||
        a.index - b.index,
    )
    .slice(0, sampleSize)
    .map(({ issue }) => issue);
  return {
    sample,
    total: issues.length,
    omitted: issues.length - sample.length,
    byKind,
    bySeverity,
  };
}

export type CanvasResultLimit =
  | { readonly _tag: "WithinLimits" }
  | {
      readonly _tag: "Exceeded";
      readonly what: "touchedNodeIds" | "issues";
      readonly count: number;
      readonly limit: number;
      /**
       * Written for the model reading it: an unbounded edit is refused with a
       * way forward rather than a ceiling.
       */
      readonly message: string;
    };

/** One execution touches one design intent. Refusing a sprawling edit keeps a mistake cheap to undo. */
export function checkExecutionResultLimits({
  touchedNodeIds,
  issueCount,
  nodeLimit,
  issueLimit,
}: {
  readonly touchedNodeIds: ReadonlyArray<string>;
  readonly issueCount: number;
  readonly nodeLimit: number;
  readonly issueLimit: number;
}): CanvasResultLimit {
  if (touchedNodeIds.length > nodeLimit) {
    return {
      _tag: "Exceeded",
      what: "touchedNodeIds",
      count: touchedNodeIds.length,
      limit: nodeLimit,
      message: `This edit touched ${touchedNodeIds.length} nodes and the limit is ${nodeLimit}. Split unrelated design intents into separate executions.`,
    };
  }
  if (issueCount > issueLimit) {
    return {
      _tag: "Exceeded",
      what: "issues",
      count: issueCount,
      limit: issueLimit,
      message: `This edit produced ${issueCount} review issues and the limit is ${issueLimit}. Narrow the design intent and correct structural problems first.`,
    };
  }
  return { _tag: "WithinLimits" };
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
// oxlint-disable-next-line no-control-regex -- Rejecting control characters is the point of this check.
const UNSAFE_SEGMENT_CHARACTER = /[/\\\0-\x1f]/u;
const MAX_FILENAME_SEGMENT_BYTES = 255;

export function isSafeFilenameSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.normalize("NFC") &&
    !UNSAFE_SEGMENT_CHARACTER.test(value) &&
    value !== "." &&
    value !== ".." &&
    !WINDOWS_RESERVED_NAME.test(value) &&
    new TextEncoder().encode(value).length <= MAX_FILENAME_SEGMENT_BYTES
  );
}

export type CanvasDestination =
  | { readonly _tag: "Ok"; readonly path: string }
  | { readonly _tag: "Unsafe"; readonly message: string }
  | { readonly _tag: "OutsideWorkspace"; readonly message: string };

/**
 * An export may only write inside the project workspace, to a path that does not
 * exist yet. Both are refused rather than repaired, because quietly rewriting a
 * destination is how an agent overwrites work it did not mean to touch.
 */
export function checkExportDestination({
  workspaceRoot,
  destination,
  exists,
}: {
  readonly workspaceRoot: string;
  readonly destination: string;
  readonly exists: boolean;
}): CanvasDestination {
  const segments = destination.split(/[\\/]/).filter((segment) => segment.length > 0);
  // A trailing separator means a directory to create, whose last written segment
  // is still produced by the exporter, so the segments above it are what we check.
  const unsafe = segments.find((segment) => !isSafeFilenameSegment(segment));
  if (unsafe !== undefined) {
    return {
      _tag: "Unsafe",
      message: `${JSON.stringify(unsafe)} is not a safe filename segment, so ${destination} was refused.`,
    };
  }
  const root = workspaceRoot.replace(/[\\/]+$/u, "");
  const normalizedDestination = destination.replace(/[\\/]+$/u, "");
  const inside =
    normalizedDestination === root ||
    normalizedDestination.startsWith(`${root}/`) ||
    normalizedDestination.startsWith(`${root}\\`);
  if (!inside) {
    return {
      _tag: "OutsideWorkspace",
      message: `Exports write inside the project workspace. ${destination} is outside ${root}.`,
    };
  }
  if (exists) {
    return {
      _tag: "Unsafe",
      message: `${destination} already exists. Exports do not overwrite; choose a new destination.`,
    };
  }
  return { _tag: "Ok", path: destination };
}

/**
 * Recoverable trash only. `permanentlyDelete` and `emptyTrash` exist in the
 * engine but must never reach a tool an agent can call, so this asserts over the
 * registered schema rather than trusting a review to have read it.
 */
export function assertNoPermanentDeleteTool(toolNames: Iterable<string>): void {
  const forbidden = ["permanentlydelete", "emptyt", "harddelete", "purge"];
  for (const name of toolNames) {
    const normalized = name.toLowerCase().replace(/[^a-z]/gu, "");
    if (forbidden.some((needle) => normalized.includes(needle))) {
      throw new Error(
        `Canvas tool ${name} can permanently delete a design, which no agent-facing tool may do.`,
      );
    }
  }
}

export type CanvasTrashConfirmation =
  | { readonly _tag: "Confirmed"; readonly title: string }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "TitleMismatch"; readonly currentTitle: string; readonly message: string };

/**
 * Trashing requires the document's exact current title, so a stale reference
 * cannot move a design the user was looking at a moment ago. The current title
 * comes back in the refusal so the agent can confirm the right one.
 */
export function resolveTrashConfirmation({
  currentTitle,
  confirmTitle,
}: {
  readonly currentTitle: string | undefined;
  readonly confirmTitle: string;
}): CanvasTrashConfirmation {
  if (currentTitle === undefined) return { _tag: "NotFound" };
  if (confirmTitle !== currentTitle) {
    return {
      _tag: "TitleMismatch",
      currentTitle,
      message: `Trash confirmation did not match the current title. Pass confirmTitle exactly as ${JSON.stringify(currentTitle)} after the user confirms moving this design to Trash.`,
    };
  }
  return { _tag: "Confirmed", title: currentTitle };
}

export type CanvasConflictDecision =
  | { readonly _tag: "Retry"; readonly attempt: number }
  | {
      readonly _tag: "GiveUp";
      readonly attempts: number;
      /**
       * The user is editing faster than the agent can commit. Retrying forever
       * would spin, so this stops and asks for a quieter moment.
       */
      readonly message: string;
    };

/**
 * A stale agent edit is refused rather than merged, because the script was
 * written against a document the user has since changed. The retry re-reads and
 * reapplies, and is capped so a user editing continuously cannot make the agent
 * loop.
 */
export function decideConflictRetry({
  attempt,
  maxAttempts,
}: {
  readonly attempt: number;
  readonly maxAttempts: number;
}): CanvasConflictDecision {
  return attempt + 1 < maxAttempts
    ? { _tag: "Retry", attempt: attempt + 1 }
    : {
        _tag: "GiveUp",
        attempts: attempt + 1,
        message: `The design changed ${attempt + 1} times while this edit was being applied, so the edit was not applied. Read the current design and retry once the user has stopped editing.`,
      };
}

/** What one render weighs, as the base64 the client would receive. */
export function renderPayloadChars(frames: ReadonlyArray<{ readonly data: string }>): number {
  return frames.reduce((total, frame) => total + frame.data.length, 0);
}

/**
 * What to retry a render at when the frames it produced exceeded the wire budget.
 *
 * PNG weight follows the rendered area, so the reduction follows the square root of how far over
 * budget the payload went, aimed at 80% of the budget rather than at it. Both are approximations: the
 * area relationship is one, and how densely a design's frames compress varies from frame to frame, so
 * a retry that lands on the budget can still come back over it — which costs a frame to the fit rather
 * than a few pixels nobody can see.
 *
 * Both numbers come down by that factor, because either one can be what set a frame's pixels. A frame
 * following the view's scale shrinks with the scale; a frame already at the ceiling shrinks only when
 * the ceiling does, and a design whose tallest frame is at the cap would otherwise be re-rendered for
 * nothing and lose a frame to the fit. `null` means a retry would not help: the payload already fits,
 * or both numbers are at their floor, and a design nobody can read is not a saving.
 */
export function reducedRenderResolution({
  scale,
  maxEdge,
  payloadChars,
  budgetChars,
  minScale,
  minEdge,
}: {
  readonly scale: number;
  readonly maxEdge: number;
  readonly payloadChars: number;
  readonly budgetChars: number;
  readonly minScale: number;
  readonly minEdge: number;
}): { readonly scale: number; readonly maxEdge: number } | null {
  if (payloadChars <= budgetChars) return null;
  const factor = Math.sqrt((budgetChars * 0.8) / payloadChars);
  // Floored to a hundredth, which is the smallest step of scale worth naming, and to whole pixels for
  // the edge, which is what the raster is measured in.
  const nextScale = Math.max(Math.floor(scale * factor * 100) / 100, Math.min(minScale, scale));
  const nextEdge = Math.max(Math.floor(maxEdge * factor), Math.min(minEdge, maxEdge));
  // A retry at the numbers the frames are already at would rasterize the same pixels for nothing.
  if (nextScale >= scale && nextEdge >= maxEdge) return null;
  return { scale: nextScale, maxEdge: nextEdge };
}

/**
 * Drops trailing frames until the payload fits its budget.
 *
 * The first frame always survives, even when it alone is over budget: a view with nothing on screen
 * reads as a broken design, while a slightly heavy first frame reads as a design. What was dropped
 * is reported, so a capped render never looks like the whole thing.
 */
export function fitFramesToBudget<F extends { readonly data: string }>(
  frames: ReadonlyArray<F>,
  budgetChars: number,
): { readonly frames: ReadonlyArray<F>; readonly omitted: number } {
  let total = 0;
  const kept: F[] = [];
  for (const frame of frames) {
    if (kept.length > 0 && total + frame.data.length > budgetChars) break;
    kept.push(frame);
    total += frame.data.length;
  }
  return { frames: kept, omitted: frames.length - kept.length };
}
