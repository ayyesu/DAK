import type { GoalActivity, GoalActivityKind } from "@dak/contracts";
import {
  ArrowLeftIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  ListChecksIcon,
  MessageCircleIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { formatGoalActivityTime } from "./GoalMode.logic";

/**
 * The goal's work, read as the run of turns it took.
 *
 * Goal Mode keeps its work out of the chat: the card carries the status, and
 * this is where the work is read when the user asks for it. The view lives
 * inside the card, so the chat above it keeps its own shape.
 */
export function GoalWorkView(props: {
  readonly title: string;
  readonly activities: ReadonlyArray<GoalActivity>;
  readonly now: number;
  /** The goal's detail is still on its way. */
  readonly loading?: boolean;
  /** The goal's detail could not be read. */
  readonly error?: string | null;
  readonly onBack: () => void;
  readonly onOpenThread?: (() => void) | undefined;
}) {
  const { activities, now, onBack } = props;
  return (
    <div className="flex min-h-0 flex-col" data-goal-work-view="true">
      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-border/60 bg-card/90 px-3 py-2 backdrop-blur-xl">
        <Button size="icon-xs" variant="ghost" aria-label="Back to the goal" onClick={onBack}>
          <ArrowLeftIcon aria-hidden className="size-3.5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">Goal work</p>
          <p className="truncate text-2xs text-muted-foreground">{props.title}</p>
        </div>
        {props.onOpenThread === undefined ? null : (
          <Button size="xs" variant="ghost" onClick={props.onOpenThread}>
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            Thread
          </Button>
        )}
      </div>

      {props.error != null ? (
        <p className="px-3.5 py-3 text-2xs text-destructive">{props.error}</p>
      ) : props.loading === true ? (
        <p className="px-3.5 py-3 text-2xs text-muted-foreground">Loading the goal's work…</p>
      ) : activities.length === 0 ? (
        <p className="px-3.5 py-3 text-2xs text-muted-foreground">
          The goal has not reported anything yet.
        </p>
      ) : (
        <ol className="list-none space-y-0 px-3.5 py-2">
          {activities.map((activity) => {
            const Icon = ACTIVITY_ICONS[activity.kind] ?? CircleDashedIcon;
            return (
              <li key={activity.id} className="flex gap-2.5 py-1.5">
                <span className="mt-0.5 flex w-4 shrink-0 justify-center">
                  <Icon
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0",
                      ACTIVITY_TONES[activity.kind] ?? "text-muted-foreground",
                    )}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs leading-5 text-foreground/90">{activity.summary}</p>
                  {activity.detail === null ? null : (
                    <p className="text-2xs leading-4 text-muted-foreground">{activity.detail}</p>
                  )}
                </div>
                <span className="shrink-0 pt-0.5 text-3xs tabular-nums text-muted-foreground/70">
                  {formatGoalActivityTime(activity.at, now)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

const ACTIVITY_ICONS: Partial<Record<GoalActivityKind, typeof CircleDashedIcon>> = {
  created: CircleCheckIcon,
  plan: ListChecksIcon,
  task_started: CircleDashedIcon,
  task_completed: CircleCheckIcon,
  task_failed: TriangleAlertIcon,
  task_recovering: RotateCcwIcon,
  task_waiting_input: MessageCircleIcon,
  task_blocked: TriangleAlertIcon,
  recovery: RotateCcwIcon,
  verification: ListChecksIcon,
  error: TriangleAlertIcon,
  user: MessageCircleIcon,
};

const ACTIVITY_TONES: Partial<Record<GoalActivityKind, string>> = {
  task_completed: "text-success",
  task_failed: "text-destructive",
  task_blocked: "text-destructive",
  error: "text-destructive",
  task_recovering: "text-warning",
  recovery: "text-warning",
};
