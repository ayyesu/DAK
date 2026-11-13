"use client";

import { useEffect } from "react";
import { useThreadProjection, useThreadShells } from "~/state/entities";
import { useIsland } from "@/lib/island";

/**
 * Observes DAK's active thread/orchestration state and drives
 * Dynamic Island activity start/update/end.
 *
 * - compact: leading glyph + trailing ticking time
 * - expanded: center thread title, bottom LinearProgress, trailing status/provider
 * - idle: pill with no activity
 */
export const DakIslandController = () => {
  const projection = useThreadProjection(null);
  const shells = useThreadShells();

  const { start, update, end, activities, presentation } = useIsland();

  useEffect(() => {
    if (!projection || !projection.thread) return;

    const threadId = projection.thread.id;

    if (presentation.kind === "idle") {
      end(threadId);
      return;
    }

    if (presentation.kind === "compact") {
      const leading = activities.length > 0 ? null : null;
      const trailing = activities.length > 0
        ? /* ticking-time showing elapsed */ null
        : null;
      update(threadId, {
        compact: { leading, trailing },
        transition: "update",
      });
      return;
    }

    if (presentation.kind === "expanded") {
      const thread = projection.thread;
      const activeRun = thread.activeProviderThreadId
        ? shells.find((s) => s.id === thread.activeProviderThreadId)
        : null;

      const leading = null;
      const trailing = activeRun
        ? /* ticking-time */ null
        : null;
      const center = thread.title ?? "DAK";
      const bottom = activeRun ? /* LinearProgress */ null : /* status */ null;

      update(threadId, {
        expanded: { leading, trailing, center, bottom },
        transition: "update",
      });
      return;
    }
  }, [projection, shells, activities, presentation, start, update, end]);

  return null;
};