/**
 * Keeps an in-flight Codex feedback submission visible while the user navigates
 * away from the composer. Completed and failed feedback keep their existing
 * composer notices; only the active transfer deserves a live activity.
 */

import { MessageSquareIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useIslandActions } from "~/lib/island";

import { islandActivityPriority } from "./activity-priority";
import { IslandCompactGlyph, IslandTile } from "./islandContent";
import { CompactText, ExpandedSubtitle, ExpandedTitle, TitleStack } from "./island-text";
import { Spinner } from "./spinner";
import { islandAccent } from "./theme";

const FEEDBACK_ID = "composer-feedback";

export const ComposerFeedbackIslandActivity = ({ uploading }: { readonly uploading: boolean }) => {
  const island = useIslandActions();
  const showingRef = useRef(false);

  useEffect(() => {
    if (!uploading) {
      if (showingRef.current) {
        island.end(FEEDBACK_ID);
        showingRef.current = false;
      }
      return;
    }

    const content = {
      compact: {
        leading: (
          <IslandCompactGlyph>
            <Spinner size={15} color={islandAccent.sky} thickness={2} />
          </IslandCompactGlyph>
        ),
        trailing: <CompactText color={islandAccent.sky}>Feedback</CompactText>,
      },
      minimal: (
        <IslandCompactGlyph>
          <MessageSquareIcon size={20} strokeWidth={1.75} color={islandAccent.sky} aria-hidden />
        </IslandCompactGlyph>
      ),
      expanded: {
        leading: (
          <IslandTile color={islandAccent.sky}>
            <MessageSquareIcon size={24} strokeWidth={1.75} color={islandAccent.sky} aria-hidden />
          </IslandTile>
        ),
        center: (
          <TitleStack
            title={<ExpandedTitle>Sending feedback</ExpandedTitle>}
            subtitle={<ExpandedSubtitle>Sending your feedback to OpenAI</ExpandedSubtitle>}
          />
        ),
      },
    };

    if (!showingRef.current) {
      island.start({
        id: FEEDBACK_ID,
        label: "Sending feedback to OpenAI",
        priority: islandActivityPriority.feedback,
        ...content,
      });
      showingRef.current = true;
      return;
    }
    island.update(FEEDBACK_ID, content);
  }, [island, uploading]);

  useEffect(
    () => () => {
      if (showingRef.current) island.end(FEEDBACK_ID);
    },
    [island],
  );

  return null;
};
