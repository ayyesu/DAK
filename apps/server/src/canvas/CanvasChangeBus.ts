import type { CanvasActivity } from "./CanvasPorts.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Who changed a design, so a live view can tell.
 *
 * Canvas designs are written from three directions — the MCP surface an agent drives, a client, and
 * scheduled work — and none of them publish into the orchestration event store this server otherwise
 * streams from. So the store announces its own committed changes here instead, and a view follows
 * this rather than polling the disk.
 *
 * It is one bus for the whole environment, not one per project: `CanvasStoreLive` is constructed per
 * project, and a bus inside it would have nobody listening.
 */
export class CanvasChangeBus extends Context.Service<
  CanvasChangeBus,
  {
    /** Announces a committed change. Never blocks and never fails a write that already committed. */
    readonly publish: (change: CanvasActivity) => Effect.Effect<void>;
    readonly changes: Stream.Stream<CanvasActivity, never, Scope.Scope>;
  }
>()("dak/canvas/CanvasChangeBus") {}

export const layer = Layer.effect(
  CanvasChangeBus,
  Effect.gen(function* () {
    // Unbounded and never failing, for the same reasons the preview manager uses one: these are
    // tiny, and a closed subscriber must not be able to fail a committed write.
    const pubSub = yield* PubSub.unbounded<CanvasActivity>();
    return {
      publish: (change: CanvasActivity) => PubSub.publish(pubSub, change),
      changes: Stream.fromPubSub(pubSub),
    };
  }).pipe(Effect.scoped),
);
