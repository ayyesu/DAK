import { describe, expect, it } from "vite-plus/test";

import { createFrameClock } from "./clock";
import { islandMotion } from "./motion";
import { createIslandStore, deriveScene } from "./store";

const compact = (id: string) => ({ compact: { leading: id, trailing: id } });

describe("island activity priority", () => {
  it("keeps simultaneous activities registered while showing the two most urgent", () => {
    const clock = createFrameClock();
    clock.pause();
    const store = createIslandStore({ clock, motion: () => islandMotion });

    store.api.start({ id: "plan", priority: 10, ...compact("plan") });
    store.api.start({ id: "update", priority: 50, ...compact("update") });
    store.api.start({ id: "goal", priority: 70, ...compact("goal") });
    store.api.start({ id: "input", priority: 100, ...compact("input") });

    expect(store.api.activities.map((activity) => activity.id)).toEqual([
      "input",
      "goal",
      "update",
      "plan",
    ]);
    const scene = deriveScene(store.getSnapshot());
    expect(scene.presentation.kind).toBe("minimal");
    expect(scene.primary?.id).toBe("input");
    expect(scene.detached?.id).toBe("goal");

    store.api.end("input");
    const afterInput = deriveScene(store.getSnapshot());
    expect(afterInput.primary?.id).toBe("goal");
    expect(afterInput.detached?.id).toBe("update");
  });

  it("lets a transient alert temporarily take over, then restores the priority split", () => {
    const clock = createFrameClock();
    clock.pause();
    const store = createIslandStore({ clock, motion: () => islandMotion });

    store.api.start({ id: "input", priority: 100, ...compact("input") });
    store.api.start({ id: "goal", priority: 70, ...compact("goal") });
    store.api.start({ id: "notice", priority: 60, alert: true, ...compact("notice") });

    expect(deriveScene(store.getSnapshot()).primary?.id).toBe("notice");
    expect(deriveScene(store.getSnapshot()).presentation.kind).toBe("expanded");

    clock.step((islandMotion.alertHold + 1) * 1_000);
    const afterAlert = deriveScene(store.getSnapshot());
    expect(afterAlert.presentation.kind).toBe("minimal");
    expect(afterAlert.primary?.id).toBe("input");
    expect(afterAlert.detached?.id).toBe("goal");
  });
});
