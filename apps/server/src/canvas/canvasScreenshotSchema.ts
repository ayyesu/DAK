import { Schema } from "effect";

import { TrimmedNonEmptyString } from "@dak/contracts";

/**
 * The screenshot tool's wire shapes.
 *
 * Kept out of `canvas.ts` on purpose: those are the panel's contracts, subscribed to and cached over
 * a socket, and this is a one-shot answer to a single tool call. Putting it there would make a
 * throwaway read look like part of the streaming surface.
 */
export const CanvasScreenshotRegion = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type CanvasScreenshotRegion = typeof CanvasScreenshotRegion.Type;

export const CanvasScreenshotPart = Schema.Struct({
  role: Schema.Literals(["overview", "section"]),
  /** Offset into the target, in design units, so a caller can order the parts. */
  y: Schema.Number,
  /** Height of this part in design units. */
  height: Schema.Number,
  /** Rendered width in pixels. */
  width: Schema.Number,
  /** Rendered height in pixels. */
  heightPx: Schema.Number,
  mimeType: Schema.Literal("image/png"),
  /** Absent when the caller asked not to write. */
  path: Schema.optional(TrimmedNonEmptyString),
  /**
   * Base64 PNG, present only when the caller asked for it. Deliberately not on the panel's
   * subscriptions: this is a one-shot answer, and base64 over a socket on every render is the
   * weight this whole tool exists to avoid.
   */
  data: Schema.optional(TrimmedNonEmptyString),
});
export type CanvasScreenshotPart = typeof CanvasScreenshotPart.Type;

export const CanvasScreenshotAnswer = Schema.Struct({
  documentId: TrimmedNonEmptyString,
  /** The frame's name, or its id when it has none. */
  target: TrimmedNonEmptyString,
  nodeId: TrimmedNonEmptyString,
  /** The design-space box that was captured. */
  bounds: CanvasScreenshotRegion,
  /** Multiplier applied to design units to get pixels. */
  scale: Schema.Number,
  /** True when the target was split into more than one image. */
  tall: Schema.Boolean,
  maxEdge: Schema.Number,
  parts: Schema.Array(CanvasScreenshotPart),
});
export type CanvasScreenshotAnswer = typeof CanvasScreenshotAnswer.Type;
