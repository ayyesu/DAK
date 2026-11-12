import { CheckpointRef, RunId } from "@dak/contracts";
import type { ThreadCheckpointSummary } from "@dak/client-runtime/state/thread-checkpoints";
import { describe, expect, it } from "vite-plus/test";

import { goalChangedFiles, goalHasChangedFiles } from "./GoalChanges.logic";

function summary(
  overrides: Partial<ThreadCheckpointSummary> & Pick<ThreadCheckpointSummary, "runId">,
): ThreadCheckpointSummary {
  return {
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make("refs/dak/checkpoints/1"),
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const file = (path: string, additions: number, deletions: number) => ({
  path,
  kind: "modified",
  additions,
  deletions,
});

describe("goalChangedFiles", () => {
  it("ignores changes from before the goal started", () => {
    const changes = goalChangedFiles({
      startedAt: "2026-01-01T00:10:00.000Z",
      summaries: [
        summary({
          runId: RunId.make("run:old"),
          completedAt: "2026-01-01T00:00:00.000Z",
          files: [file("src/old.ts", 5, 5)],
        }),
      ],
    });

    expect(changes.files).toEqual([]);
    expect(changes.latestRunId).toBeNull();
  });

  it("keeps the changes the goal made", () => {
    const changes = goalChangedFiles({
      startedAt: "2026-01-01T00:00:00.000Z",
      summaries: [
        summary({
          runId: RunId.make("run:1"),
          completedAt: "2026-01-01T00:05:00.000Z",
          files: [file("src/app.ts", 12, 3)],
        }),
      ],
    });

    expect(changes.files).toHaveLength(1);
    expect(changes.files[0]?.path).toBe("src/app.ts");
    expect(changes.files[0]?.runId).toBe(RunId.make("run:1"));
    expect(changes.stat).toEqual({ additions: 12, deletions: 3 });
    expect(changes.latestRunId).toBe(RunId.make("run:1"));
  });

  it("lists a file once, carrying its most recent change", () => {
    const changes = goalChangedFiles({
      startedAt: "2026-01-01T00:00:00.000Z",
      summaries: [
        summary({
          runId: RunId.make("run:1"),
          completedAt: "2026-01-01T00:05:00.000Z",
          files: [file("src/app.ts", 30, 2)],
        }),
        summary({
          runId: RunId.make("run:2"),
          completedAt: "2026-01-01T00:09:00.000Z",
          files: [file("src/app.ts", 4, 1), file("src/new.ts", 7, 0)],
        }),
      ],
    });

    expect(changes.files.map((entry) => entry.path)).toEqual(["src/app.ts", "src/new.ts"]);
    // The newest change to src/app.ts wins, and it points at the newer turn.
    expect(changes.files[0]?.additions).toBe(4);
    expect(changes.files[0]?.runId).toBe(RunId.make("run:2"));
    expect(changes.stat).toEqual({ additions: 11, deletions: 1 });
    expect(changes.latestRunId).toBe(RunId.make("run:2"));
  });

  it("skips checkpoints that are not ready", () => {
    const changes = goalChangedFiles({
      startedAt: "2026-01-01T00:00:00.000Z",
      summaries: [
        summary({
          runId: RunId.make("run:1"),
          status: "missing",
          completedAt: "2026-01-01T00:05:00.000Z",
          files: [file("src/app.ts", 12, 3)],
        }),
      ],
    });

    expect(changes.files).toEqual([]);
  });

  it("reports nothing before the goal starts", () => {
    const changes = goalChangedFiles({
      startedAt: null,
      summaries: [
        summary({
          runId: RunId.make("run:1"),
          completedAt: "2026-01-01T00:05:00.000Z",
          files: [file("src/app.ts", 12, 3)],
        }),
      ],
    });

    expect(changes.files).toEqual([]);
    expect(goalHasChangedFiles(changes)).toBe(false);
  });

  it("keeps a file that changed without adding a line", () => {
    const changes = goalChangedFiles({
      startedAt: "2026-01-01T00:00:00.000Z",
      summaries: [
        summary({
          runId: RunId.make("run:1"),
          completedAt: "2026-01-01T00:05:00.000Z",
          files: [file("src/renamed.ts", 0, 0)],
        }),
      ],
    });

    expect(goalHasChangedFiles(changes)).toBe(true);
    expect(changes.stat).toEqual({ additions: 0, deletions: 0 });
  });
});
