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
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

import type { ReactNode } from "react";

import { useIslandActions } from "~/lib/island";
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
  /** What kind of thing happened: a finished run, or a waiting one. */
  readonly kind: "completion" | "input";
  readonly title: string;
  readonly body: string;
  /** Null when the notice has nowhere to navigate to. */
  readonly action: { readonly label: string; readonly open: () => void } | null;
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
  return payload.tone === "error" ? (
    <CircleAlertIcon size={size} strokeWidth={2.25} color={color} aria-hidden />
  ) : payload.tone === "warning" ? (
    <ShieldQuestionIcon size={size} strokeWidth={2} color={color} aria-hidden />
  ) : (
    <MessageCircleQuestionIcon size={size} strokeWidth={2} color={color} aria-hidden />
  );
};

export const IslandNotificationActivity = () => {
  const island = useIslandActions();
  const dismissTimer = useRef<number | null>(null);
  const showingRef = useRef(false);

  useEffect(() => {
    const clearDismissTimer = () => {
      if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    };
    const armDismissTimer = () => {
      clearDismissTimer();
      dismissTimer.current = window.setTimeout(() => {
        island.end(NOTIFICATION_ID);
        showingRef.current = false;
        dismissTimer.current = null;
      }, NOTICE_TTL_MS);
    };
    const makeOnPress = (payload: IslandNotificationPayload) => () => {
      payload.action?.open();
      clearDismissTimer();
      island.end(NOTIFICATION_ID);
      showingRef.current = false;
    };

    const listener = (event: Event) => {
      const payload = (event as CustomEvent<IslandNotificationPayload>).detail;
      if (!payload) return;

      const color = toneColor(payload.tone);
      const onPress = makeOnPress(payload);
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
                <IslandButton
                  tone={{ kind: "accent", color }}
                  onPress={onPress}
                  label={payload.action.label}
                >
                  {payload.action.label}
                </IslandButton>
              </ExpandedBottom>
            ),
        },
      };

      if (showingRef.current) {
        island.update(NOTIFICATION_ID, { ...content, alert: true, onPress });
      } else {
        island.start({
          id: NOTIFICATION_ID,
          label: payload.title,
          priority: islandActivityPriority.notification,
          alert: true,
          onPress,
          ...content,
        });
        showingRef.current = true;
      }
      armDismissTimer();
    };

    window.addEventListener(ISLAND_NOTIFICATION_EVENT, listener);
    return () => {
      window.removeEventListener(ISLAND_NOTIFICATION_EVENT, listener);
      clearDismissTimer();
      if (showingRef.current) island.end(NOTIFICATION_ID);
    };
  }, [island]);

  return null;
};
