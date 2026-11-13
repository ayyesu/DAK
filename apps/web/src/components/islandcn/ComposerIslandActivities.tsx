/**
 * Registers the chat composer's two mode toggles as island activities, next
 * to the state they reflect (the composer's route). Registration is global;
 * mounting is per chat view, so the island offers plan mode and the goal
 * composer exactly where they make sense.
 *
 * Plan mode mirrors the thread's interaction mode (sky glyph, tap toggles).
 * Goal mode opens the goal composer through the shared bus, the same path the
 * `chat.goal` shortcut and the command palette take.
 */

import { BotIcon, PencilRulerIcon, TargetIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { ProviderInteractionMode } from "@dak/contracts";

import { useIslandActions } from "~/lib/island";
import { toggleGoalComposer } from "../../goalModeBus";
import { IslandButton } from "./island-button";
import { ExpandedBottom } from "./island-layout";
import { CompactText, ExpandedSubtitle, ExpandedTitle, TitleStack } from "./island-text";
import { IslandCompactGlyph, IslandTile } from "./islandContent";
import { islandAccent, islandInk } from "./theme";

const PLAN_ID = "composer-plan-mode";
const GOAL_ID = "composer-goal-mode";

interface ComposerIslandActivitiesProps {
  readonly interactionMode: ProviderInteractionMode;
  /** Plan mode is offered only when the provider supports it. */
  readonly interactionModeEnabled: boolean;
  readonly onToggleInteractionMode: () => void;
  /** Whether the goal form is currently open in this composer. */
  readonly goalComposerOpen: boolean;
  readonly canOperateGoal: boolean;
}

export const ComposerIslandActivities = (props: ComposerIslandActivitiesProps) => {
  const island = useIslandActions();

  const planToggleRef = useRef(props.onToggleInteractionMode);
  planToggleRef.current = props.onToggleInteractionMode;
  const planActive = props.interactionMode === "plan";
  const planToggle = () => planToggleRef.current();

  useEffect(() => {
    if (!props.interactionModeEnabled) {
      island.end(PLAN_ID);
      return;
    }
    const accent = planActive ? islandAccent.sky : islandInk.secondary;
    const content = {
      compact: {
        leading: (
          <IslandCompactGlyph>
            {planActive ? (
              <PencilRulerIcon size={20} strokeWidth={1.75} color={islandAccent.sky} aria-hidden />
            ) : (
              <BotIcon size={20} strokeWidth={1.75} color={accent} aria-hidden />
            )}
          </IslandCompactGlyph>
        ),
        trailing: (
          <CompactText color={planActive ? islandAccent.sky : islandInk.secondary}>
            {planActive ? "Plan" : "Build"}
          </CompactText>
        ),
      },
      minimal: (
        <IslandCompactGlyph>
          {planActive ? (
            <PencilRulerIcon size={20} strokeWidth={1.75} color={islandAccent.sky} aria-hidden />
          ) : (
            <BotIcon size={20} strokeWidth={1.75} color={islandInk.secondary} aria-hidden />
          )}
        </IslandCompactGlyph>
      ),
      expanded: {
        leading: (
          <IslandTile color={islandAccent.sky}>
            <PencilRulerIcon size={24} strokeWidth={1.75} color={islandAccent.sky} aria-hidden />
          </IslandTile>
        ),
        center: (
          <TitleStack
            title={<ExpandedTitle>{planActive ? "Plan mode" : "Build mode"}</ExpandedTitle>}
            subtitle={
              <ExpandedSubtitle>
                {planActive
                  ? "The agent proposes a plan before it touches anything"
                  : "The agent builds directly in this thread"}
              </ExpandedSubtitle>
            }
          />
        ),
        bottom: (
          <ExpandedBottom reach="action">
            <IslandButton
              tone={{ kind: "accent", color: islandAccent.sky }}
              onPress={() => {
                planToggleRef.current();
                island.collapse();
              }}
              label={planActive ? "Switch to build mode" : "Switch to plan mode"}
            >
              {planActive ? "Switch to Build" : "Switch to Plan"}
            </IslandButton>
          </ExpandedBottom>
        ),
      },
    };
    island.start({
      id: PLAN_ID,
      label: planActive ? "Plan mode on" : "Plan mode off",
      priority: 10,
      onPress: planToggle,
      ...content,
    });
  }, [island, props.interactionModeEnabled, planActive]);

  useEffect(() => () => island.end(PLAN_ID), [island]);

  const goalRef = useRef(props.goalComposerOpen);
  goalRef.current = props.goalComposerOpen;

  useEffect(() => {
    if (!props.canOperateGoal) {
      island.end(GOAL_ID);
      return;
    }
    const goalToggle = () => {
      toggleGoalComposer();
    };
    const accent = props.goalComposerOpen ? islandAccent.purple : islandInk.secondary;
    const content = {
      compact: {
        leading: (
          <IslandCompactGlyph>
            <TargetIcon size={20} strokeWidth={1.75} color={accent} aria-hidden />
          </IslandCompactGlyph>
        ),
        trailing: <CompactText color={accent}>Goal</CompactText>,
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
            title={<ExpandedTitle>Goal mode</ExpandedTitle>}
            subtitle={
              <ExpandedSubtitle>
                Give the agent an outcome to plan, execute and verify
              </ExpandedSubtitle>
            }
          />
        ),
        bottom: (
          <ExpandedBottom reach="action">
            <IslandButton
              tone={{ kind: "accent", color: islandAccent.purple }}
              onPress={() => {
                toggleGoalComposer();
                island.collapse();
              }}
              label={goalRef.current ? "Close the goal composer" : "Open the goal composer"}
            >
              {goalRef.current ? "Close goal composer" : "Open goal composer"}
            </IslandButton>
          </ExpandedBottom>
        ),
      },
    };
    island.start({
      id: GOAL_ID,
      label: "Goal mode",
      priority: 10,
      onPress: goalToggle,
      ...content,
    });
  }, [island, props.canOperateGoal, props.goalComposerOpen]);

  useEffect(() => () => island.end(GOAL_ID), [island]);

  return null;
};
