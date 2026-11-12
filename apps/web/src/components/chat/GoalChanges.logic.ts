import type { RunId } from "@dak/contracts";

import { summarizeTurnDiffStats, type TurnDiffStat } from "../../lib/turnDiffTree";
import type { TurnDiffFileChange, TurnDiffSummary } from "../../types";

/**
 * One file the goal changed, with the turn that last changed it.
 *
 * The run travels with the file because a goal spans many turns: opening the
 * diff has to land on the turn that touched this file, not on the goal's
 * newest turn.
 */
export interface GoalChangedFile extends TurnDiffFileChange {
  readonly runId: RunId;
}

/** What a goal changed on disk, and where to open it. */
export interface GoalChanges {
  /** Every file the goal touched, newest change per file. */
  readonly files: ReadonlyArray<GoalChangedFile>;
  /** The totals behind the `+n -m` badge; the sum of `files`. */
  readonly stat: TurnDiffStat;
  /** The turn whose diff opens when the user picks the summary as a whole. */
  readonly latestRunId: RunId | null;
}

const EMPTY_CHANGES: GoalChanges = {
  files: [],
  stat: { additions: 0, deletions: 0 },
  latestRunId: null,
};

function parseTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The files a goal changed, derived from its thread's checkpoints.
 *
 * Only checkpoints captured at or after the goal started count: the thread
 * may have changed files before the goal existed, and those belong to the
 * work that came before it.
 *
 * A file changed by several turns is listed once, carrying the stat of its
 * most recent change, so the badge and the tree describe the same state and
 * a click lands on the turn that last touched the file.
 */
export function goalChangedFiles(input: {
  readonly summaries: ReadonlyArray<TurnDiffSummary>;
  /** When the goal started; null while it has not. */
  readonly startedAt: string | null;
}): GoalChanges {
  const startedAt = input.startedAt === null ? null : parseTime(input.startedAt);
  // Without a start there is no window to attribute changes to.
  if (startedAt === null) return EMPTY_CHANGES;

  const eligible = input.summaries
    .filter((summary) => {
      if (summary.status !== "ready") return false;
      if (summary.files.length === 0) return false;
      const completedAt = parseTime(summary.completedAt);
      return completedAt !== null && completedAt >= startedAt;
    })
    .toSorted((left, right) => {
      const leftAt = parseTime(left.completedAt) ?? 0;
      const rightAt = parseTime(right.completedAt) ?? 0;
      return rightAt - leftAt;
    });

  const byPath = new Map<string, GoalChangedFile>();
  for (const summary of eligible) {
    for (const file of summary.files) {
      // Newest first, so the first hit for a path is its latest change.
      if (byPath.has(file.path)) continue;
      byPath.set(file.path, { ...file, runId: summary.runId });
    }
  }

  const files = [...byPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) return EMPTY_CHANGES;

  return {
    files,
    stat: summarizeTurnDiffStats(files),
    latestRunId: eligible[0]?.runId ?? null,
  };
}

/**
 * Whether the goal changed anything worth showing.
 *
 * A rename or a mode change can touch a file without adding a line, so the
 * file count decides, not the line totals.
 */
export function goalHasChangedFiles(changes: GoalChanges): boolean {
  return changes.files.length > 0;
}
