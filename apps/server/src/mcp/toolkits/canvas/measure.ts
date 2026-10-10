import { Schema } from "effect";

import { CanvasTouchedNode, TrimmedNonEmptyString } from "@dak/contracts";

/**
 * What a measure call answers with.
 *
 * Local to the MCP toolkit rather than the shared contracts because it is a shape the agent reads,
 * not a shape a client subscribes to: it has no streaming, no caching and no lifecycle, and giving it
 * a home in `canvas.ts` would make it look like part of the panel's wire format.
 */
export const CanvasMeasureResult = Schema.Struct({
  /** Every node measured, in document order. */
  nodes: Schema.Array(CanvasTouchedNode),
  /** How many text nodes were measured against the shaper, and how many were not. */
  measuredTextNodes: Schema.Number,
  /** Set when a selector matched nothing, so "no problems" is never the answer about nothing. */
  unmatchedSelectors: Schema.Array(TrimmedNonEmptyString),
});
export type CanvasMeasureResult = typeof CanvasMeasureResult.Type;
