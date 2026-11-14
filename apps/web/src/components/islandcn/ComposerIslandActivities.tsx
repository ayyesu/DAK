/**
 * Registers the chat composer's plan-mode toggle as an island activity, next
 * to the state it reflects (the thread's interaction mode). Registered per
 * chat view; the island hides the pill entirely when the provider does not
 * support plan mode.
 */

import { BotIcon, PencilRulerIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { ProviderInteractionMode } from "@dak/contracts";

import { useIslandActions } from "~/lib/island";
import { IslandButton } from "./island-button";
import { ExpandedBottom } from "./island-layout";
import { CompactText, ExpandedSubtitle, ExpandedTitle, TitleStack } from "./island-text";
import { IslandCompactGlyph, IslandTile } from "./islandContent";
import { islandAccent, islandInk } from "./theme";
import { islandActivityPriority } from "./activity-priority";

const PLAN_ID = "composer-plan-mode";

interface ComposerIslandActivitiesProps {
  readonly interactionMode: ProviderInteractionMode;
  /** Plan mode is offered only when the provider supports it. */
  readonly interactionModeEnabled: boolean;
  readonly onToggleInteractionMode: () => void;
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
                  ? "The agent proposes a plan before acting"
                  : "The agent builds directly"}
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
      priority: islandActivityPriority.plan,
      onPress: planToggle,
      ...content,
    });
  }, [island, props.interactionModeEnabled, planActive]);

  useEffect(() => () => island.end(PLAN_ID), [island]);

  return null;
};
