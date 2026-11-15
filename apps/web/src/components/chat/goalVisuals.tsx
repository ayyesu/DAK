import type { GoalTaskStatus } from "@dak/contracts";
import { CheckIcon, CircleIcon, RotateCcwIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { Spinner } from "../ui/spinner";
import type { GoalTone } from "./GoalMode.logic";

/*
 * The look of Goal Mode, in one place. The goal card above the composer and the cards Goal Mode
 * leaves in the chat both read from here, so a status looks the same wherever it appears.
 */

export const TONE_PILL: Record<GoalTone, string> = {
  active: "bg-info/10 text-info",
  attention: "bg-warning/10 text-warning",
  success: "bg-success/10 text-success",
  danger: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

export const TONE_BAR: Record<GoalTone, string> = {
  active: "bg-info",
  attention: "bg-warning",
  success: "bg-success",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

export function GoalTaskStatusIcon({ status }: { readonly status: GoalTaskStatus }) {
  if (status === "completed") {
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
        <CheckIcon aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (status === "in_progress") {
    return <Spinner aria-hidden size="xs" />;
  }
  if (status === "recovering") {
    return <RotateCcwIcon aria-hidden className="size-4 text-info" />;
  }
  if (status === "waiting_input" || status === "failed") {
    return <TriangleAlertIcon aria-hidden className="size-4 text-warning" />;
  }
  return <CircleIcon aria-hidden className="size-4 text-muted-foreground/40" />;
}

export function GoalTaskIcon({ task }: { readonly task: { readonly status: GoalTaskStatus } }) {
  return <GoalTaskStatusIcon status={task.status} />;
}

export function GoalCriterionIcon({ met }: { readonly met: boolean | null }) {
  if (met === true) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <CheckIcon aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (met === false) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <XIcon aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    );
  }
  return <CircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/40" />;
}
