import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { CanvasRenderLimiter, layerCanvasRenderLimiter } from "./CanvasSocket.ts";

/**
 * The limiter every design view goes through on its way to the engine.
 *
 * It is tested through the real layer rather than a stub because a limiter that cannot hand out a
 * permit does not look slow — it looks like every design failing to render, and the failure surfaces
 * inside Effect rather than in anything Canvas-shaped. The message was
 * `this.releaseUnsafe is not a function`, from `withPermits` being handed out detached from the
 * semaphore that owned it, which a stub cannot reproduce and a per-client ceiling cannot hide.
 */

describe("canvas render limiter", () => {
  effectIt.effect("hands a render its slot through the service", () =>
    Effect.gen(function* () {
      const limiter = yield* CanvasRenderLimiter;
      const rendered = yield* limiter.withPermits(1)(Effect.succeed("rendered"));
      expect(rendered).toBe("rendered");
    }).pipe(Effect.provide(layerCanvasRenderLimiter)),
  );

  effectIt.effect("returns the slot, so a later render is not blocked by an earlier one", () =>
    Effect.gen(function* () {
      const limiter = yield* CanvasRenderLimiter;
      // Sequential on purpose: a ceiling of one still has to let the second render through, which
      // can only happen if the first put its permit back. That is the property a view depends on
      // every time it follows a design, and it is the one a limiter that only takes would lose.
      const first = yield* limiter.withPermits(1)(Effect.succeed("first"));
      const second = yield* limiter.withPermits(1)(Effect.succeed("second"));
      expect([first, second]).toEqual(["first", "second"]);
    }).pipe(Effect.provide(layerCanvasRenderLimiter)),
  );
});
