import { ChevronDownIcon, TargetIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useId, useState } from "react";

import { openGoalWork } from "../../goalModeBus";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  goalTurnPhaseLabel,
  goalTurnAnswer,
  goalTurnPhaseSummary,
  goalTurnProviderNotice,
  goalTurnTaskTitle,
  goalTurnTone,
  type GoalTurnRef,
} from "./GoalTurn.logic";
import { TONE_PILL } from "./goalVisuals";

/**
 * What Goal Mode asked of the agent, as it reads in the chat.
 *
 * Goal Mode sends each turn as a message whose text is the whole protocol prompt: the objective,
 * the rules, the report format. Shown as a user bubble that is a wall of instructions nobody wrote.
 * This keeps the same look as the goal card and the `/goal` hint (target glyph, tone pill, rounded
 * strip), leads with the one thing a person wants to know (the phase and the task), and keeps the
 * prompt one click away for anyone who wants to read it.
 */
export const GoalTurnCard = memo(function GoalTurnCard(props: {
  readonly turn: GoalTurnRef;
  readonly prompt: string;
}) {
  const { turn, prompt } = props;
  const [showPrompt, setShowPrompt] = useState(false);
  const promptId = useId();
  const label = goalTurnPhaseLabel(turn.phase);
  const task = goalTurnTaskTitle(prompt);
  const answer = turn.phase === "answer" ? goalTurnAnswer(prompt) : null;
  const interrupted = goalTurnProviderNotice(prompt);

  return (
    <section
      role="group"
      aria-label={`Goal Mode turn ${turn.cycle}: ${label}`}
      data-goal-turn-card="true"
      data-goal-turn-phase={turn.phase}
      className="rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <TargetIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">Goal</span>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-3xs font-medium leading-4",
            TONE_PILL[goalTurnTone(turn.phase)],
          )}
        >
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-2xs tabular-nums text-muted-foreground">
          Turn {turn.cycle}
        </span>
        <Button size="xs" variant="ghost-muted" onClick={() => openGoalWork(turn.goalId)}>
          View goal
        </Button>
      </div>

      <p className="mt-1.5 line-clamp-3 text-sm leading-5 text-foreground [text-wrap:pretty]">
        {answer ?? task ?? goalTurnPhaseSummary(turn.phase)}
      </p>

      {interrupted === null ? null : (
        <p className="mt-1.5 flex items-start gap-1.5 text-2xs leading-4 text-warning">
          <TriangleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
          <span className="min-w-0 [text-wrap:pretty]">
            The turn before this one was cut short by the provider: {interrupted.message}
          </span>
        </p>
      )}

      <button
        type="button"
        aria-expanded={showPrompt}
        aria-controls={promptId}
        className="mt-2 flex items-center gap-1 rounded-sm text-2xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setShowPrompt((open) => !open)}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 transition-transform", showPrompt && "rotate-180")}
        />
        {showPrompt ? "Hide instructions" : "Show instructions sent to the agent"}
      </button>
      {showPrompt ? (
        <pre
          id={promptId}
          className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-background/60 p-2.5 font-mono text-2xs leading-4 text-muted-foreground"
        >
          {prompt}
        </pre>
      ) : null}
    </section>
  );
});
