import type { GoalBlocker } from "@dak/contracts";
import { CircleAlertIcon } from "lucide-react";

import { cn } from "../../lib/utils";

/**
 * The agent's assessment of what stopped the work.
 *
 * A goal only blocks on an assessment like this, so the evidence behind the
 * verdict is what the user needs: the reason, what was checked, what was
 * tried, and what would actually unblock it.
 */
export function GoalBlockerPanel(props: {
  readonly blocker: GoalBlocker;
  /** The blocker belongs to one task rather than to the whole goal. */
  readonly scope?: "goal" | "task";
  className?: string;
}) {
  const { blocker, scope = "goal", className } = props;
  return (
    <div
      data-goal-blocker={scope}
      className={cn("rounded-xl border border-warning/30 bg-warning/5 p-2", className)}
    >
      <div className="flex items-start gap-2">
        <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium leading-4 text-foreground">{blocker.reason}</p>
          {blocker.rootCause.trim() === "" ? null : (
            <BlockerRow label="Why" value={blocker.rootCause} />
          )}
          {blocker.investigation.trim() === "" ? null : (
            <BlockerRow label="Checked" value={blocker.investigation} />
          )}
          {blocker.attempts.length === 0 ? null : (
            <BlockerList label="Tried" values={blocker.attempts} />
          )}
          {blocker.alternatives.length === 0 ? null : (
            <BlockerList label="Considered" values={blocker.alternatives} />
          )}
          {blocker.intervention.trim() === "" ? null : (
            <BlockerRow label="Needs" value={blocker.intervention} />
          )}
          {blocker.otherTasksCanContinue ? (
            <p className="mt-1 text-2xs text-muted-foreground">
              The rest of the plan keeps running while this is open.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BlockerRow(props: { readonly label: string; readonly value: string }) {
  return (
    <p className="mt-1 text-2xs leading-4 text-muted-foreground">
      <span className="font-medium text-foreground/80">{props.label}: </span>
      {props.value}
    </p>
  );
}

function BlockerList(props: { readonly label: string; readonly values: ReadonlyArray<string> }) {
  return (
    <div className="mt-1">
      <p className="text-2xs font-medium text-foreground/80">{props.label}:</p>
      <ul className="mt-0.5 list-none space-y-0.5">
        {props.values.map((value) => (
          <li key={value} className="text-2xs leading-4 text-muted-foreground">
            {value}
          </li>
        ))}
      </ul>
    </div>
  );
}
