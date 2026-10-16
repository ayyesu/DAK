import { describe, expect, it } from "vite-plus/test";

import {
  applyCanvasSequence,
  canvasCatchUpDue,
  canvasIsUnderResolved,
  canvasRenderSettled,
  canvasRenderStarted,
  initialCanvasViewState,
  isCanvasDeleted,
  isCanvasGone,
  shouldRenderCanvas,
  type CanvasViewState,
} from "./canvasViewState";

const frame = (nodeId: string, sequence: number, scale = 1) => ({
  nodeId,
  // Deliberately different from the raster: a frame taller than the render ceiling comes back below
  // the scale it was asked for, and the layout uses the design size, not the bitmap's.
  designWidth: 390,
  designHeight: 844,
  width: Math.ceil(390 * scale),
  height: Math.ceil(844 * scale),
  data: "png",
  sequence,
});

const rendered = (sequence: number, nodeId = "frame-1", scale = 1) => ({
  frames: [frame(nodeId, sequence, scale)],
  sequence,
  title: "Landing page",
  omittedFrames: 0,
  projectionCurrent: true,
});

const state = (overrides: Partial<CanvasViewState> = {}): CanvasViewState => ({
  ...initialCanvasViewState,
  ...overrides,
});

describe("canvas sequence", () => {
  it("treats the first sequence as a change, because nothing has been rendered yet", () => {
    const next = applyCanvasSequence(state(), { sequence: 4, trashed: false });
    expect(next.observedSequence).toBe(4);
    expect(next.stale).toBe(true);
  });

  it("returns the same state for a sequence that moved nothing, so a quiet view never repaints", () => {
    const current = state({ observedSequence: 4, renderedSequence: 4, stale: false });
    expect(applyCanvasSequence(current, { sequence: 4, trashed: false })).toBe(current);
  });

  it("reacts to a sequence that moved backwards, which is what an undo or rollback looks like", () => {
    const current = state({ observedSequence: 9, renderedSequence: 9, stale: false });
    const next = applyCanvasSequence(current, { sequence: 8, trashed: false });
    // A view that only reacted to growth would sit there showing a design that no longer exists.
    expect(next.observedSequence).toBe(8);
    expect(next.stale).toBe(true);
  });

  it("reacts to a design entering the trash at a sequence it already holds", () => {
    const current = state({ observedSequence: 4, renderedSequence: 4, stale: false });
    const next = applyCanvasSequence(current, { sequence: 4, trashed: true });
    expect(next.observedTrashed).toBe(true);
  });
});

describe("deciding to render", () => {
  it("renders when forced, even with nothing to catch up on", () => {
    const current = state({ observedSequence: 4, renderedSequence: 4 });
    expect(shouldRenderCanvas(current, { force: true })).toBe(true);
    expect(shouldRenderCanvas(current, {})).toBe(false);
  });

  it("renders when nothing is on screen", () => {
    expect(shouldRenderCanvas(state(), {})).toBe(true);
  });

  it("renders once per new sequence, not once per subscription tick", () => {
    const behind = state({ observedSequence: 5, renderedSequence: 4 });
    expect(shouldRenderCanvas(behind, {})).toBe(true);
    const caughtUp = state({ observedSequence: 5, renderedSequence: 5 });
    expect(shouldRenderCanvas(caughtUp, {})).toBe(false);
  });

  it("does not start a second render while one is already in flight", () => {
    const inFlight = state({ observedSequence: 5, renderedSequence: 4, rendering: true });
    expect(shouldRenderCanvas(inFlight, {})).toBe(false);
  });

  it("retries after a failure rather than leaving the design stuck behind a marker", () => {
    const failed = state({ observedSequence: 5, renderedSequence: 5, error: "Could not update." });
    expect(shouldRenderCanvas(failed, {})).toBe(true);
  });
});

describe("detail the frames on screen do not have", () => {
  it("is not reported before the first render, when there is nothing to compare", () => {
    expect(canvasIsUnderResolved(state(), 1)).toBe(false);
  });

  it("is reported when the frames came back below the scale the view is showing them at", () => {
    // The engine's ceiling and the payload budget both answer below the scale that was asked for, so
    // the frames themselves are the only evidence of what arrived.
    const soft = state({ frames: [frame("frame-1", 4)] });
    expect(canvasIsUnderResolved(soft, 2)).toBe(true);
    expect(canvasIsUnderResolved(soft, 1)).toBe(false);
  });

  it("reports a frame the ceiling left short even when its neighbours are sharp", () => {
    const mixed = state({
      frames: [
        frame("frame-1", 4, 2),
        { ...frame("frame-2", 4, 2), designWidth: 1200, width: 1200 },
      ],
    });
    // frame-1 is at the scale the view is showing; frame-2 came back at half of it, which is what a
    // 1200-wide design hits when its long edge is capped.
    expect(canvasIsUnderResolved(mixed, 2)).toBe(true);
    expect(canvasIsUnderResolved(mixed, 1)).toBe(false);
  });

  it("calls a raster rounded up from the needed size resolved", () => {
    // Half a pixel of slack: the multiply that decides what a zoom needs is floating point, and a
    // frame rounded up by a fraction must not be reported as soft.
    const rounded = state({
      frames: [{ ...frame("frame-1", 4), designWidth: 300, width: 330 }],
    });
    expect(canvasIsUnderResolved(rounded, 1.1)).toBe(false);
  });
});

describe("a render in flight", () => {
  it("keeps the previous frames rather than blanking the panel", () => {
    const current = state({ frames: [frame("frame-1", 3)], renderedSequence: 3 });
    const started = canvasRenderStarted(current);
    expect(started.rendering).toBe(true);
    expect(started.frames).toEqual(current.frames);
  });
});

describe("a settled render", () => {
  it("drops a response that is not the newest request, frames and sequence together", () => {
    const current = state({ rendering: true });
    const stale = canvasRenderSettled(
      current,
      { requestId: 1, ok: true, rendered: rendered(3) },
      2,
    );
    // Letting it land would show older frames under a newer sequence label.
    expect(stale).toBe(current);
  });

  it("shows the rendered frames at the sequence they came from", () => {
    const next = canvasRenderSettled(
      state({ rendering: true, observedSequence: 6 }),
      { requestId: 2, ok: true, rendered: rendered(6, "frame-7") },
      2,
    );
    expect(next.frames.map((entry) => entry.nodeId)).toEqual(["frame-7"]);
    expect(next.renderedSequence).toBe(6);
    expect(next.stale).toBe(false);
    expect(next.error).toBeNull();
    expect(next.title).toBe("Landing page");
  });

  it("keeps the last good frames and says why they are old when a render fails", () => {
    const current = state({
      frames: [frame("frame-1", 3)],
      renderedSequence: 3,
      rendering: true,
      observedSequence: 4,
    });
    const next = canvasRenderSettled(
      current,
      { requestId: 1, ok: false, message: "This design could not be updated." },
      1,
    );
    expect(next.frames).toEqual(current.frames);
    expect(next.renderedSequence).toBe(3);
    expect(next.rendering).toBe(false);
    expect(next.error).toBe("This design could not be updated.");
  });

  it("does not move the observed sequence backwards when a render lands older than the stream", () => {
    const next = canvasRenderSettled(
      state({ rendering: true, observedSequence: 9 }),
      { requestId: 1, ok: true, rendered: rendered(7) },
      1,
    );
    expect(next.observedSequence).toBe(9);
  });

  it("keeps the frames a reduced render landed, so the marker still has something to go on", () => {
    const reduced = canvasRenderSettled(
      state({ rendering: true }),
      { requestId: 1, ok: true, rendered: rendered(4, "frame-1", 0.5) },
      1,
    );
    expect(reduced.frames[0]?.width).toBe(195);
    const failed = canvasRenderSettled(
      reduced,
      { requestId: 2, ok: false, message: "This design could not be updated." },
      2,
    );
    // The frames on screen are still the reduced ones, so the marker must not change its story.
    expect(failed.frames[0]?.width).toBe(195);
  });

  it("still knows the design is in the trash after a render settles", () => {
    const next = canvasRenderSettled(
      state({ rendering: true, observedTrashed: true }),
      { requestId: 1, ok: true, rendered: rendered(4) },
      1,
    );
    // Forgetting this would swap the recoverable "Restore it" notice for a dead end.
    expect(next.observedTrashed).toBe(true);
  });
});

describe("an edit that arrives during a render", () => {
  // Regression: the render it asked for is declined while one is in flight, so the settled render is
  // the only place a catch-up can be requested. Without it the view holds the older frames until an
  // unrelated later sequence arrives, while the marker claims an update that never happens.
  const inFlight = state({ frames: [frame("frame-1", 4)], renderedSequence: 4, rendering: true });

  it("declines the render at the time, because one is already running", () => {
    const observed = applyCanvasSequence(inFlight, { sequence: 6, trashed: false });
    expect(observed.observedSequence).toBe(6);
    expect(observed.stale).toBe(true);
    expect(shouldRenderCanvas(observed, {})).toBe(false);
  });

  it("still owes a render once the in-flight one lands behind it", () => {
    const settled = canvasRenderSettled(
      applyCanvasSequence(inFlight, { sequence: 6, trashed: false }),
      { requestId: 1, ok: true, rendered: rendered(5, "frame-2") },
      1,
    );
    expect(settled.renderedSequence).toBe(5);
    expect(settled.observedSequence).toBe(6);
    expect(settled.stale).toBe(true);
    expect(canvasCatchUpDue(settled)).toBe(true);
    // And the catch-up is a normal render, so it coalesces behind the burst rather than spinning.
    expect(shouldRenderCanvas(settled, {})).toBe(true);
  });

  it("owes nothing once the catch-up render lands", () => {
    const settled = canvasRenderSettled(
      canvasRenderStarted(inFlight),
      { requestId: 1, ok: true, rendered: rendered(6, "frame-3") },
      1,
    );
    expect(settled.stale).toBe(false);
    expect(canvasCatchUpDue(settled)).toBe(false);
    // No follow-up, so a quiet design cannot spin a render per settle.
    expect(shouldRenderCanvas(settled, {})).toBe(false);
  });

  it("does not spin on a design the server cannot rasterize", () => {
    const failed = canvasRenderSettled(
      applyCanvasSequence(inFlight, { sequence: 6, trashed: false }),
      { requestId: 1, ok: false, message: "This design could not be updated." },
      1,
    );
    expect(failed.stale).toBe(true);
    expect(canvasCatchUpDue(failed)).toBe(false);
  });
});

describe("a view that has nothing to show", () => {
  it("is gone when the server said the design is deleted", () => {
    const deleted = canvasRenderSettled(
      state({ rendering: true }),
      {
        requestId: 1,
        ok: false,
        message: "That design no longer exists.",
        code: "document_not_found",
      },
      1,
    );
    expect(deleted.gone).toBe(true);
    expect(isCanvasDeleted(deleted)).toBe(true);
  });

  // Regression: a runtime that could not rasterize reported itself as a deleted design, which sent
  // the user looking for a design that was still on disk. Only the server's code may say "gone".
  it("is not gone when a design exists but could not be read", () => {
    const unreadable = canvasRenderSettled(
      state({ rendering: true }),
      { requestId: 1, ok: false, message: "Could not read the design.", code: "storage_failed" },
      1,
    );
    expect(unreadable.gone).toBe(false);
    expect(isCanvasGone(unreadable)).toBe(false);
    expect(isCanvasDeleted(unreadable)).toBe(false);
    // The error still stands, so the panel can say what actually happened.
    expect(unreadable.error).toBe("Could not read the design.");
  });

  it("treats an unrecognised failure as not-gone, since that is the safe direction", () => {
    const unknown = canvasRenderSettled(
      state({ rendering: true }),
      { requestId: 1, ok: false, message: "Could not reach the server." },
      1,
    );
    expect(unknown.gone).toBe(false);
  });

  it("stops being gone once a render succeeds again", () => {
    const recovered = canvasRenderSettled(
      canvasRenderSettled(
        state({ rendering: true }),
        { requestId: 1, ok: false, message: "gone", code: "document_not_found" },
        1,
      ),
      { requestId: 2, ok: true, rendered: rendered(4) },
      2,
    );
    expect(recovered.gone).toBe(false);
    expect(isCanvasDeleted(recovered)).toBe(false);
  });

  it("is not gone while the last good frames are still on screen", () => {
    const showing = state({
      frames: [frame("frame-1", 3)],
      renderedSequence: 3,
      error: "This design could not be updated.",
      gone: true,
    });
    expect(isCanvasGone(showing)).toBe(false);
  });

  it("is not gone before any read has failed", () => {
    expect(isCanvasGone(state())).toBe(false);
    expect(isCanvasDeleted(state())).toBe(false);
  });
});
