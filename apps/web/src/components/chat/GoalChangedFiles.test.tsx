import { RunId } from "@dak/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GoalChangedFiles } from "./GoalChangedFiles";
import { goalChangedFiles } from "./GoalChanges.logic";
import type { TurnDiffSummary } from "../../types";

function summary(
  overrides: Partial<TurnDiffSummary> & Pick<TurnDiffSummary, "runId">,
): TurnDiffSummary {
  return {
    checkpointTurnCount: 1,
    checkpointRef: "refs/dak/checkpoints/1" as TurnDiffSummary["checkpointRef"],
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const changes = goalChangedFiles({
  startedAt: "2026-01-01T00:00:00.000Z",
  summaries: [
    summary({
      runId: RunId.make("run-1"),
      completedAt: "2026-01-01T00:05:00.000Z",
      files: [
        { path: "apps/web/src/GoalModePanel.tsx", kind: "modified", additions: 42, deletions: 7 },
        { path: "apps/web/src/GoalChangedFiles.tsx", kind: "added", additions: 131, deletions: 0 },
      ],
    }),
  ],
});

describe("GoalChangedFiles", () => {
  it("shows the changed file count and the line totals", () => {
    const markup = renderToStaticMarkup(
      <GoalChangedFiles changes={changes} onOpenTurnDiff={() => {}} />,
    );

    expect(markup).toContain('data-goal-changed-files="true"');
    expect(markup).toContain("2 changed files");
    expect(markup).toContain('role="group" aria-label="173 additions, 7 deletions"');
    expect(markup).toContain("+173");
    expect(markup).toContain("-7");
  });

  it("keeps the file list behind a toggle", () => {
    const markup = renderToStaticMarkup(
      <GoalChangedFiles changes={changes} onOpenTurnDiff={() => {}} />,
    );

    expect(markup).toContain('aria-label="Show the changed files"');
    expect(markup).not.toContain("GoalModePanel.tsx");
  });

  it("renders nothing when the goal changed no files", () => {
    const markup = renderToStaticMarkup(
      <GoalChangedFiles
        changes={goalChangedFiles({ startedAt: "2026-01-01T00:00:00.000Z", summaries: [] })}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toBe("");
  });
});
