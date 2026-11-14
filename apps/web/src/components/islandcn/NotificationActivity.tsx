/**
 * The Dynamic Island delivery for the in-app notifications that used to show
 * as toasts: thread completions, failures, and approval or input requests
 * elsewhere in the workspace. One transient activity slot at a time; a new
 * notice replaces a stale one, alerts briefly, and dismisses itself.
 *
 * The native OS path is untouched — it still covers a hidden or unfocused
 * window. This module owns only what the toast used to own.
 */

import {
  CircleAlertIcon,
  CircleCheckIcon,
  DownloadIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import type { ReactNode } from "react";

import { useIsland } from "~/lib/island";
import { IslandButton } from "./island-button";
import { ExpandedBottom } from "./island-layout";
import { CompactText, ExpandedSubtitle, ExpandedTitle, TitleStack } from "./island-text";
import { IslandCompactGlyph, IslandTile } from "./islandContent";
import { islandAccent } from "./theme";
import { islandActivityPriority } from "./activity-priority";

const ISLAND_NOTIFICATION_EVENT = "dak:island-notification";
const NOTIFICATION_ID = "dak-notification";
/** How long a transient notice lingers before it dismisses itself. */
const NOTICE_TTL_MS = 6_500;

export type IslandNotificationTone = "success" | "warning" | "error";

export interface IslandNotificationPayload {
  readonly tone: IslandNotificationTone;
  /** What kind of thing happened: a finished run, a waiting one, or an update. */
  readonly kind: "completion" | "input" | "update";
  readonly title: string;
  readonly body: string;
  /** Null when the notice has nowhere to navigate to. */
  readonly action: { readonly label: string; readonly open: () => void } | null;
  /** An optional second action for compact two-choice notices, such as updates. */
  readonly secondaryAction?: { readonly label: string; readonly open: () => void } | null;
  /** `null` keeps a progress notice present until its producer replaces it. */
  readonly durationMs?: number | null;
}

/** Hand a notice to the island; the bus keeps the coordinator router-free. */
export function showIslandNotification(payload: IslandNotificationPayload): void {
  window.dispatchEvent(
    new CustomEvent<IslandNotificationPayload>(ISLAND_NOTIFICATION_EVENT, { detail: payload }),
  );
}

/** Convert and deliver, mirroring the old in-app toast delivery path. */
export function showIslandNotificationFromNotice(notice: {
  readonly kind: "completion" | "input";
  readonly toastType: "success" | "error" | "warning";
  readonly title: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly open: () => void } | null;
}): void {
  showIslandNotification({
    tone:
      notice.toastType === "success"
        ? "success"
        : notice.toastType === "error"
          ? "error"
          : "warning",
    kind: notice.kind,
    title: notice.title,
    body: notice.body,
    action: notice.action,
  });
}

const toneColor = (tone: IslandNotificationTone): string =>
  tone === "success"
    ? islandAccent.green
    : tone === "error"
      ? islandAccent.red
      : islandAccent.orange;

const toneIcon = (payload: IslandNotificationPayload, size: number): ReactNode => {
  const color = toneColor(payload.tone);
  if (payload.kind === "completion") {
    return <CircleCheckIcon size={size} strokeWidth={2.25} color={color} aria-hidden />;
  }
  // A failed update reads as a failure; the download glyph would not.
  if (payload.kind === "update" && payload.tone !== "error") {
    return <DownloadIcon size={size} strokeWidth={2.25} color={color} aria-hidden />;
  }
  return payload.tone === "error" ? (
    <CircleAlertIcon size={size} strokeWidth={2.25} color={color} aria-hidden />
  ) : payload.tone === "warning" ? (
    <ShieldQuestionIcon size={size} strokeWidth={2} color={color} aria-hidden />
  ) : (
    <MessageCircleQuestionIcon size={size} strokeWidth={2} color={color} aria-hidden />
  );
};

export const IslandNotificationActivity = () => {
  const island = useIsland();
  const dismissTimer = useRef<number | null>(null);
  const showingRef = useRef(false);
  /** Whether this notice's clock has started; it starts only once the notice is on screen. */
  const armedRef = useRef(false);
  const ttlRef = useRef<number | null>(null);
  const visible = island.activities[0]?.id === NOTIFICATION_ID;

  const clearDismissTimer = useCallback(() => {
    if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
  }, []);

  const endCurrent = useCallback(() => {
    clearDismissTimer();
    armedRef.current = false;
    showingRef.current = false;
    island.end(NOTIFICATION_ID);
  }, [clearDismissTimer, island]);

  const armDismissTimer = useCallback(
    (durationMs: number | null) => {
      clearDismissTimer();
      armedRef.current = true;
      if (durationMs === null) return;
      dismissTimer.current = window.setTimeout(endCurrent, durationMs);
    },
    [clearDismissTimer, endCurrent],
  );

  // A notice can wait behind higher-priority activities, such as a thread blocked on
  // approval. Its clock runs only while it is on screen: news the user never saw is
  // never spent, and a notice pushed aside gets its full time when it returns.
  useEffect(() => {
    if (!showingRef.current) return;
    if (visible) {
      if (!armedRef.current) armDismissTimer(ttlRef.current);
      return;
    }
    if (!armedRef.current) return;
    clearDismissTimer();
    armedRef.current = false;
  }, [armDismissTimer, clearDismissTimer, visible]);

  useEffect(() => {
    const makeOnPress = (open: () => void) => () => {
      open();
      endCurrent();
    };

    const listener = (event: Event) => {
      const payload = (event as CustomEvent<IslandNotificationPayload>).detail;
      if (!payload) return;

      const color = toneColor(payload.tone);
      const onPress = payload.action === null ? undefined : makeOnPress(payload.action.open);
      const content = {
        compact: {
          leading: <IslandCompactGlyph>{toneIcon(payload, 20)}</IslandCompactGlyph>,
          trailing: <CompactText color={color}>{payload.title}</CompactText>,
        },
        expanded: {
          leading: <IslandTile color={color}>{toneIcon(payload, 26)}</IslandTile>,
          center: (
            <TitleStack
              title={<ExpandedTitle>{payload.title}</ExpandedTitle>}
              subtitle={<ExpandedSubtitle>{payload.body}</ExpandedSubtitle>}
            />
          ),
          bottom:
            payload.action === null ? undefined : (
              <ExpandedBottom reach="action">
                {payload.secondaryAction === null || payload.secondaryAction === undefined ? (
                  <IslandButton
                    tone={{ kind: "accent", color }}
                    onPress={onPress!}
                    label={payload.action.label}
                  >
                    {payload.action.label}
                  </IslandButton>
                ) : (
                  <div className="flex min-w-0 gap-2">
                    <IslandButton
                      size="compact"
                      tone={{ kind: "neutral" }}
                      onPress={makeOnPress(payload.secondaryAction.open)}
                      label={payload.secondaryAction.label}
                    >
                      {payload.secondaryAction.label}
                    </IslandButton>
                    <IslandButton
                      size="compact"
                      tone={{ kind: "accent", color }}
                      onPress={onPress!}
                      label={payload.action.label}
                    >
                      {payload.action.label}
                    </IslandButton>
                  </div>
                )}
              </ExpandedBottom>
            ),
        },
      };

      if (showingRef.current) {
        island.update(NOTIFICATION_ID, {
          ...content,
          alert: true,
          ...(onPress === undefined ? {} : { onPress }),
        });
      } else {
        island.start({
          id: NOTIFICATION_ID,
          label: payload.title,
          priority: islandActivityPriority.notification,
          alert: true,
          ...(onPress === undefined ? {} : { onPress }),
          ...content,
        });
        showingRef.current = true;
      }
      const ttl = payload.durationMs === null ? null : (payload.durationMs ?? NOTICE_TTL_MS);
      ttlRef.current = ttl;
      // A notice already on screen has its clock running; a new one waits for its turn.
      if (armedRef.current) armDismissTimer(ttl);
    };

    window.addEventListener(ISLAND_NOTIFICATION_EVENT, listener);
    return () => {
      window.removeEventListener(ISLAND_NOTIFICATION_EVENT, listener);
      clearDismissTimer();
      if (showingRef.current) island.end(NOTIFICATION_ID);
    };
  }, [armDismissTimer, clearDismissTimer, endCurrent, island]);

  return null;
};
