import type { GoalReport } from "@dak/shared/goalReport";
import { CircleCheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { memo, useState } from "react";

import { openGoalWork } from "../../goalModeBus";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { GOAL_REPORT_VISIBLE_ITEMS, goalReportStatusLabel, goalReportTone } from "./GoalTurn.logic";
import { GoalCriterionIcon, GoalTaskStatusIcon, TONE_BAR, TONE_PILL } from "./goalVisuals";

/**
 * The agent's progress report, as the card it is meant to be.
 *
 * Goal Mode reads one fenced JSON block at the end of each turn. In the chat that block is the
 * thing nobody should have to parse by eye, so it is replaced by the same pieces the goal card
 * uses: a status pill, the summary, the progress bar, the tasks and the criteria, with the
 * question the agent needs answered pulled up where it cannot be missed.
 */
export const GoalReportCard = memo(function GoalReportCard(props: {
  readonly report: GoalReport;
  /** The goal this turn belongs to, for "View goal"/"Answer". Null when it can't be told. */
  readonly goalId: string | null;
}) {
  const { report, goalId } = props;
  const tone = goalReportTone(report);
  const [expanded, setExpanded] = useState(false);

  const tasks = report.tasks;
  const criteria = report.acceptance;
  const hidden =
    Math.max(0, tasks.length - GOAL_REPORT_VISIBLE_ITEMS) +
    Math.max(0, criteria.length - GOAL_REPORT_VISIBLE_ITEMS);
  const shownTasks = expanded ? tasks : tasks.slice(0, GOAL_REPORT_VISIBLE_ITEMS);
  const shownCriteria = expanded ? criteria : criteria.slice(0, GOAL_REPORT_VISIBLE_ITEMS);

  const ask = report.input?.question ?? report.question;
  const progress = report.progress === null ? null : Math.min(100, Math.max(0, report.progress));

  return (
    <section
      role="group"
      aria-label={`Goal report: ${goalReportStatusLabel(report.status)}`}
      data-goal-report-card="true"
      data-goal-report-status={report.status}
      className="mt-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium leading-4",
            TONE_PILL[tone],
          )}
        >
          {goalReportStatusLabel(report.status)}
        </span>
        {report.verified === true ? (
          <span className="flex shrink-0 items-center gap-1 text-2xs text-success">
            <CircleCheckIcon aria-hidden className="size-3" />
            Verified
          </span>
        ) : null}
        <span className="flex-1" />
        {goalId === null ? null : (
          <Button size="xs" variant="ghost-muted" onClick={() => openGoalWork(goalId)}>
            View goal
          </Button>
        )}
      </div>

      {report.summary === null ? null : (
        <p className="mt-1.5 text-sm leading-5 text-foreground [text-wrap:pretty]">
          {report.summary}
        </p>
      )}

      {progress === null ? null : (
        <div className="mt-2 flex items-center gap-2">
          <div
            role="progressbar"
            aria-label={report.progressLabel ?? "Goal progress"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-border/60"
          >
            <div
              className={cn("h-full rounded-full transition-[width] duration-300", TONE_BAR[tone])}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {report.progressLabel ?? `${Math.round(progress)}%`}
          </span>
        </div>
      )}

      {ask === null ? null : (
        <div
          role="note"
          className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2"
        >
          <p className="flex items-start gap-1.5 text-xs font-medium leading-4 text-warning">
            <MessageCircleQuestionIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 [text-wrap:pretty]">{ask}</span>
          </p>
          {report.input?.reason ? (
            <p className="mt-1 text-2xs leading-4 text-muted-foreground [text-wrap:pretty]">
              {report.input.reason}
            </p>
          ) : null}
          {report.input?.recommendation ? (
            <p className="mt-1 text-2xs leading-4 text-foreground [text-wrap:pretty]">
              Suggested: {report.input.recommendation}
            </p>
          ) : null}
          {goalId === null ? null : (
            <Button
              size="xs"
              variant="outline"
              className="mt-2"
              onClick={() => openGoalWork(goalId)}
            >
              Answer
            </Button>
          )}
        </div>
      )}

      {shownTasks.length === 0 ? null : (
        <ul className="mt-2.5 flex flex-col gap-1.5" aria-label="Tasks reported this turn">
          {shownTasks.map((task, index) => (
            <li key={`${index}:${task.title}`} className="flex items-start gap-2">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                <GoalTaskStatusIcon status={task.status} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-4 [text-wrap:pretty]">{task.title}</p>
                {task.evidence === null ? null : (
                  <p
                    className={cn(
                      "text-2xs leading-4 text-muted-foreground [text-wrap:pretty]",
                      !expanded && "line-clamp-2",
                    )}
                  >
                    {task.evidence}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {shownCriteria.length === 0 ? null : (
        <ul className="mt-2.5 flex flex-col gap-1.5" aria-label="Done when">
          {shownCriteria.map((criterion, index) => (
            <li key={`${index}:${criterion.criterion}`} className="flex items-start gap-2">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                <GoalCriterionIcon met={criterion.met} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-4 [text-wrap:pretty]">{criterion.criterion}</p>
                {criterion.evidence === null ? null : (
                  <p
                    className={cn(
                      "text-2xs leading-4 text-muted-foreground [text-wrap:pretty]",
                      !expanded && "line-clamp-2",
                    )}
                  >
                    {criterion.evidence}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {hidden === 0 && !expanded ? null : (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-2 rounded-sm text-2xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </section>
  );
});
