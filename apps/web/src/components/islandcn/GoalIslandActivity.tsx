/**
 * The Dynamic Island live activity for a goal running in the workspace.
 * Idle otherwise: no goal, no pill. Registered globally (one activity per
 * environment, id-suffixed), so it tracks goals across threads and projects,
 * and tapping it opens the goal's thread.
 */

import { TargetIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { EnvironmentId, GoalSummary } from "@dak/contracts";

import { useNavigate } from "@tanstack/react-router";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentIds } from "../../state/environments";
import { isGoalDriven, goalStatusLabel } from "../chat/GoalMode.logic";
import { IslandButton } from "./island-button";
import { ExpandedBottom } from "./island-layout";
import { CompactText, ExpandedSubtitle, ExpandedTitle, TitleStack } from "./island-text";
import { IslandCompactGlyph, IslandTile } from "./islandContent";
import { useIslandActions } from "~/lib/island";
import { islandAccent } from "./theme";

/** Goals that keep the pill on screen: a goal is running only when it is actively driving. */
const isLiveGoal = (status: GoalSummary["status"]) => isGoalDriven(status);

const pickGoal = (goals: ReadonlyArray<GoalSummary>): GoalSummary | null => {
  let best: GoalSummary | null = null;
  for (const goal of goals) {
    if (!isLiveGoal(goal.status)) continue;
    if (best === null || goal.lastActivityAt > best.lastActivityAt) best = goal;
  }
  return best;
};

const statusLine = (goal: GoalSummary): string => {
  if (goal.question !== null) return "Needs your answer";
  if (goal.totalTaskCount > 0) {
    const tasks = `${goal.completedTaskCount} of ${goal.totalTaskCount} tasks`;
    return goal.progressLabel ?? `${tasks}`;
  }
  return goal.progressLabel ?? goalStatusLabel(goal.status);
};

const GoalActivity = ({ environmentId }: { readonly environmentId: EnvironmentId }) => {
  const island = useIslandActions();
  const navigate = useNavigate();
  const goalsQuery = useEnvironmentQuery(serverEnvironment.goalsLive({ environmentId, input: {} }));
  const goals = goalsQuery.data?.goals ?? null;
  const showingRef = useRef(false);

  const active = pickGoal(goals ?? []);
  const activeKey = active
    ? `${active.id}:${active.status}:${active.progress ?? "x"}:${active.completedTaskCount}:${active.question !== null ? "q" : ""}`
    : null;

  useEffect(() => {
    const activityId = `running-goal:${environmentId}`;
    const openGoal = () => {
      if (!active?.threadId) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: active.threadId },
      });
    };

    if (!active) {
      if (showingRef.current) {
        island.end(activityId);
        showingRef.current = false;
      }
      return;
    }

    const canOpen = active.threadId !== null;
    const content = {
      compact: {
        leading: (
          <IslandCompactGlyph>
            <TargetIcon size={20} strokeWidth={1.75} color={islandAccent.purple} aria-hidden />
          </IslandCompactGlyph>
        ),
        trailing: (
          <CompactText color={islandAccent.purple}>
            {active.progress !== null ? `${active.progress}%` : "Goal"}
          </CompactText>
        ),
      },
      minimal: (
        <IslandCompactGlyph>
          <TargetIcon size={20} strokeWidth={1.75} color={islandAccent.purple} aria-hidden />
        </IslandCompactGlyph>
      ),
      expanded: {
        leading: (
          <IslandTile color={islandAccent.purple}>
            <TargetIcon size={24} strokeWidth={1.75} color={islandAccent.purple} aria-hidden />
          </IslandTile>
        ),
        center: (
          <TitleStack
            title={<ExpandedTitle>{active.title}</ExpandedTitle>}
            subtitle={<ExpandedSubtitle>{statusLine(active)}</ExpandedSubtitle>}
          />
        ),
        bottom: canOpen ? (
          <ExpandedBottom reach="action">
            <IslandButton
              tone={{ kind: "accent", color: islandAccent.purple }}
              onPress={openGoal}
              label="Open the goal's thread"
            >
              Open goal
            </IslandButton>
          </ExpandedBottom>
        ) : undefined,
      },
    };

    if (!showingRef.current) {
      island.start({ id: activityId, label: `Goal: ${active.title}`, priority: 70, onPress: openGoal, ...content });
      showingRef.current = true;
      return;
    }
    island.update(activityId, { ...content, onPress: openGoal });
  }, [island, navigate, activeKey, environmentId]);

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
