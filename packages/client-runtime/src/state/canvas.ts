import { WS_METHODS } from "@dak/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Canvas as a client sees it: rendered frames plus the sequence they were rendered at.
 *
 * The engine is server-only, so a client never holds a design. It asks for rasterized frames and
 * follows a one-line sequence, which is what keeps an agent editing a design from queueing a render
 * per keystroke behind a view the user is still scrolling.
 */
export function createCanvasEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Frames for one design, at the sequence they were rendered from. */
    render: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:canvas:render",
      tag: WS_METHODS.canvasRender,
      // A render is server CPU and the frames are large, so a repeat read is only worth it when the
      // sequence has actually moved. The view drives this by refreshing on a sequence bump.
      staleTimeMs: 30_000,
      // Dropped as soon as nothing watches it, so a closed tab stops holding megabytes of base64.
      idleTtlMs: 0,
    }),
    /** The designs in a project, for the palette and for restoring tabs after a reload. */
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:canvas:list",
      tag: WS_METHODS.canvasList,
      staleTimeMs: 5_000,
      idleTtlMs: 0,
    }),
    /**
     * One design's sequence as it moves.
     *
     * `idleTtlMs` is short because a view that nobody is looking at should not hold a subscription
     * open: the design costs nothing to follow while it is quiet, but a client parked on a thread
     * with a dozen tabs would otherwise keep a dozen live streams.
     */
    sequence: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:canvas:sequence",
      tag: WS_METHODS.canvasSubscribe,
      idleTtlMs: 60_000,
    }),
    /**
     * Every design this project touches, as a latest-value atom.
     *
     * A thread follows this so a design the agent starts appears in the panel without the user
     * having to find it. Only the newest item matters, which is what an atom already gives: a burst
     * of edits to one design collapses to its last sequence rather than replaying every commit.
     */
    activity: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:canvas:activity",
      tag: WS_METHODS.canvasActivity,
      idleTtlMs: 60_000,
    }),
    /** Brings a trashed design back. The user restoring their own work, not an agent destroying it. */
    restore: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:restore",
      tag: WS_METHODS.canvasRestore,
    }),
  };
}
