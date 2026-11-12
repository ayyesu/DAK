import type { RunId } from "@dak/contracts";
import { ChevronDownIcon, ChevronRightIcon, FileDiffIcon, FilesIcon } from "lucide-react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useCallback, useMemo, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import type { TurnDiffFileChange } from "../../types";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChangedFilesTree, type ChangedFileContextMenuHandler } from "./ChangedFilesTree";
import { DiffStatLabel } from "./DiffStatLabel";
import { goalHasChangedFiles, type GoalChanges } from "./GoalChanges.logic";

/**
 * The files a goal changed.
 *
 * The card above the composer is where a goal lives while it runs, so the
 * change it makes belongs there too: the same `+n -m` badge the timeline
 * uses, over the same file tree, opening the same diff panel.
 */
export function GoalChangedFiles(props: {
  readonly changes: GoalChanges;
  readonly onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  readonly onFileContextMenu?: ChangedFileContextMenuHandler | undefined;
}) {
  const { changes, onOpenTurnDiff, onFileContextMenu } = props;
  const { resolvedTheme } = useTheme();
  const [listOpen, setListOpen] = useState(false);
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(false);

  const files = useMemo<ReadonlyArray<TurnDiffFileChange>>(() => changes.files, [changes.files]);
  const hasDirectories = files.some((file) => /[/\\]/.test(file.path));
  const latestRunId = changes.latestRunId;

  // A goal spans many turns, so each file belongs to the turn that last
  // touched it rather than to the goal's newest turn.
  const resolveRunId = useCallback(
    (filePath: string): RunId | undefined =>
      changes.files.find((file) => file.path === filePath)?.runId,
    [changes.files],
  );

  if (!goalHasChangedFiles(changes) || latestRunId === null) return null;

  return (
    <div className="px-3.5 pb-1 pt-1" data-goal-changed-files="true">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-2xs font-medium text-muted-foreground">
          <FilesIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0">
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          <DiffStatLabel
            additions={changes.stat.additions}
            deletions={changes.stat.deletions}
            layout="inline"
            className="text-2xs leading-4"
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {hasDirectories && listOpen ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={
                      allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                    }
                    onClick={() => setAllDirectoriesExpanded((value) => !value)}
                  />
                }
              >
                <MorphIcon
                  className="size-3"
                  icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={listOpen ? "Hide the changed files" : "Show the changed files"}
                  aria-expanded={listOpen}
                  onClick={() => setListOpen((value) => !value)}
                />
              }
            >
              {listOpen ? (
                <ChevronDownIcon aria-hidden className="size-3" />
              ) : (
                <ChevronRightIcon aria-hidden className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {listOpen ? "Hide the changed files" : "Show the changed files"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Open the goal's diff"
                  onClick={() => onOpenTurnDiff(latestRunId, changes.files[0]?.path)}
                />
              }
            >
              <FileDiffIcon aria-hidden className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Open the full diff</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {listOpen ? (
        <div className="mt-1 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
          <ChangedFilesTree
            key={`${latestRunId}:${allDirectoriesExpanded}`}
            runId={latestRunId}
            files={files}
            allDirectoriesExpanded={allDirectoriesExpanded}
            resolvedTheme={resolvedTheme}
            onOpenTurnDiff={onOpenTurnDiff}
            onFileContextMenu={onFileContextMenu}
            runIdForFile={resolveRunId}
          />
        </div>
      ) : null}
    </div>
  );
}
