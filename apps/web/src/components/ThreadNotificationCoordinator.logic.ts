import type { GoalSummary } from "@dak/contracts";

/** What a goal's latest change deserves from the notification system. */
export type GoalNoticeKind = "attention" | "completion";

/** One goal's last-seen notice state; the coordinator keeps these across scans. */
export interface GoalNoticeState {
  readonly attention: string | null;
  readonly completion: number | null;
}

/** Statuses where the goal is asking the user for something. */
const GOAL_ATTENTION_STATUSES: ReadonlySet<GoalSummary["status"]> = new Set<GoalSummary["status"]>([
  "needs_input",
  "failed",
  "waiting_provider",
]);

/**
 * The current ask, keyed so each distinct question pings once.
 *
 * A question counts as attention on its own: the goal keeps working whatever
 * else it can, so the status alone does not say the user is needed.
 */
function goalAttentionKey(goal: Pick<GoalSummary, "id" | "status" | "question">): string | null {
  if (goal.question !== null) return `${goal.id}:question:${goal.question}`;
  return GOAL_ATTENTION_STATUSES.has(goal.status) ? `${goal.id}:${goal.status}` : null;
}

/** The state to store after scanning this goal; callers decide what fires. */
export function advanceGoalNotice(
  goal: Pick<GoalSummary, "id" | "status" | "completedAt" | "updatedAt" | "question">,
): GoalNoticeState {
  const at = Date.parse(goal.completedAt ?? goal.updatedAt);
  return {
    attention: goalAttentionKey(goal),
    completion: goal.status === "completed" && Number.isFinite(at) ? at : null,
  };
}

/**
 * Which notice the move from prior to next deserves, or null. Callers record a
 * goal's first sighting without asking, so goals that already exist when the
 * page loads never ping.
 */
export function goalNotification(
  prior: GoalNoticeState,
  next: GoalNoticeState,
): GoalNoticeKind | null {
  if (next.attention !== null && next.attention !== prior.attention) return "attention";
  if (next.completion !== null && (prior.completion === null || next.completion > prior.completion))
    return "completion";
  return null;
}
