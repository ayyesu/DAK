/**
 * The Dynamic Island live activity for a goal running in the workspace.
 * Idle otherwise: no goal, no pill. Registered globally (one activity per
 * environment, id-suffixed), so it tracks goals across threads and projects,
 * and tapping it opens the goal's thread.
 */

import { TargetIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import type { EnvironmentId, GoalSummary } from "@dak/contracts";

import { useNavigate, useParams } from "@tanstack/react-router";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentIds } from "../../state/environments";
import { openGoalWork } from "../../goalModeBus";
import {
  goalIslandActionLabel,
  goalIslandHeadline,
  goalNeedsIslandAttention,
  isGoalIslandVisible,
} from "../chat/GoalMode.logic";
import { IslandButton } from "./island-button";
import { ExpandedBottom } from "./island-layout";
import { CompactText, ExpandedSubtitle, ExpandedTitle, TitleStack } from "./island-text";
import { IslandCompactGlyph, IslandTile } from "./islandContent";
import { useIslandActions } from "~/lib/island";
import { islandAccent, islandThemeAccent } from "./theme";
import { islandActivityPriority } from "./activity-priority";

/** The goal most worthy of the ambient surface: intervention before background work. */
const pickGoal = (goals: ReadonlyArray<GoalSummary>): GoalSummary | null => {
  let best: GoalSummary | null = null;
  for (const goal of goals) {
    if (!isGoalIslandVisible(goal)) continue;
    if (best === null) {
      best = goal;
      continue;
    }
    const goalNeedsAttention = goalNeedsIslandAttention(goal);
    const bestNeedsAttention = goalNeedsIslandAttention(best);
    if (
      goalNeedsAttention !== bestNeedsAttention
        ? goalNeedsAttention
        : goal.lastActivityAt > best.lastActivityAt
    )
      best = goal;
  }
  return best;
};

const goalColor = (goal: GoalSummary) =>
  goal.status === "failed"
    ? islandAccent.red
    : goalNeedsIslandAttention(goal)
      ? islandAccent.orange
      : islandThemeAccent;

const compactLabel = (goal: GoalSummary): string => {
  if (goal.question !== null || goal.status === "needs_input") return "Reply";
  if (goal.status === "waiting_provider") return "Waiting";
  if (goal.status === "failed") return "Review";
  return goal.progress !== null ? `${goal.progress}%` : "Goal";
};

const GoalActivity = ({ environmentId }: { readonly environmentId: EnvironmentId }) => {
  const island = useIslandActions();
  const navigate = useNavigate();
  const { environmentId: routedEnvironmentId, threadId: routedThreadId } = useParams({
    strict: false,
  });
  const goalsQuery = useEnvironmentQuery(serverEnvironment.goalsLive({ environmentId, input: {} }));
  const goals = goalsQuery.data?.goals ?? null;
  const showingRef = useRef(false);
  const wasAttentionRef = useRef(false);

  // An island activity belongs to the thread currently in view. Leaving that
  // thread restores the island to the state of the destination, rather than
  // keeping a background goal pinned over unrelated work.
  const active =
    routedEnvironmentId === environmentId && routedThreadId !== undefined
      ? pickGoal((goals ?? []).filter((goal) => goal.threadId === routedThreadId))
      : null;
  const activeRef = useRef(active);
  activeRef.current = active;
  // The query can retain the same goal while its presentation copy changes. Keep every
  // displayed field in the key so the island updates without reacting to a fresh query object.
  const activeKey = active
    ? JSON.stringify([
        active.id,
        active.status,
        active.title,
        active.progress,
        active.progressLabel,
        active.completedTaskCount,
        active.totalTaskCount,
        active.question,
        active.waitingReason,
        active.currentTaskTitle,
        active.threadId,
      ])
    : null;
  const openGoal = useCallback(() => {
    const goal = activeRef.current;
    if (!goal?.threadId) return;
    island.collapse();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: goal.threadId },
    }).then(() => openGoalWork(goal.id));
  }, [environmentId, island, navigate]);

  useEffect(() => {
    const activityId = `running-goal:${environmentId}`;

    if (!active) {
      if (showingRef.current) {
        island.end(activityId);
        showingRef.current = false;
      }
      wasAttentionRef.current = false;
      return;
    }

    const canOpen = active.threadId !== null;
    const attention = goalNeedsIslandAttention(active);
    const color = goalColor(active);
    const actionLabel = goalIslandActionLabel(active);
    const content = {
      compact: {
        leading: (
          <IslandCompactGlyph>
            <TargetIcon size={20} strokeWidth={1.75} color={color} aria-hidden />
          </IslandCompactGlyph>
        ),
        trailing: <CompactText color={color}>{compactLabel(active)}</CompactText>,
      },
      minimal: (
        <IslandCompactGlyph>
          <TargetIcon size={20} strokeWidth={1.75} color={color} aria-hidden />
        </IslandCompactGlyph>
      ),
      expanded: {
        leading: (
          <IslandTile color={color}>
            <TargetIcon size={24} strokeWidth={1.75} color={color} aria-hidden />
          </IslandTile>
        ),
        center: (
          <TitleStack
            title={<ExpandedTitle>{active.title}</ExpandedTitle>}
            subtitle={<ExpandedSubtitle>{goalIslandHeadline(active)}</ExpandedSubtitle>}
          />
        ),
        bottom: canOpen ? (
          <ExpandedBottom reach="action">
            <IslandButton tone={{ kind: "accent", color }} onPress={openGoal} label={actionLabel}>
              {actionLabel}
            </IslandButton>
          </ExpandedBottom>
        ) : undefined,
      },
    };

    if (!showingRef.current) {
      island.start({
        id: activityId,
        label: `Goal: ${active.title}`,
        priority: attention ? islandActivityPriority.goalAttention : islandActivityPriority.goal,
        onPress: openGoal,
        ...content,
      });
      showingRef.current = true;
      wasAttentionRef.current = attention;
      return;
    }
    const alert = !wasAttentionRef.current && attention;
    wasAttentionRef.current = attention;
    island.update(activityId, {
      ...content,
      priority: attention ? islandActivityPriority.goalAttention : islandActivityPriority.goal,
      onPress: openGoal,
      ...(alert ? { alert, transition: "crossfade" as const } : {}),
    });
  }, [activeKey, environmentId, island, openGoal]);

  useEffect(
    () => () => {
      if (showingRef.current) island.end(`running-goal:${environmentId}`);
    },
    [island, environmentId],
  );

  return null;
};

/** One activity per environment; the island shows at most two at once. */
export const GoalIslandActivities = () => {
  const environmentIds = useEnvironmentIds();
  return (
    <>
      {environmentIds.map((id) => (
        <GoalActivity key={id} environmentId={id} />
      ))}
    </>
  );
};
