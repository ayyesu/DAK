import { presentThreadShell } from "@dak/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, GoalId, OrchestrationV2ThreadShell, ThreadId } from "@dak/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import {
  advanceGoalNotice,
  goalNotification,
  type GoalNoticeState,
} from "./ThreadNotificationCoordinator.logic";
import { goalNoticeTitle } from "./chat/GoalMode.logic";
import { showIslandNotificationFromNotice } from "./islandcn/NotificationActivity";

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = useCallback((environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  }, []);

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
    />
  ));
}

interface NotificationState {
  readonly raw: OrchestrationV2ThreadShell;
  readonly attention: string | null;
  readonly completion: number | null;
}

interface NoticeDelivery {
  readonly kind: "input" | "completion";
  readonly toastType: "success" | "error" | "warning";
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  /** Null when the notice has nowhere to navigate to. */
  readonly action: { readonly label: string; readonly open: () => void } | null;
  /** The user is already looking at the target; the notification would only nag. */
  readonly active: boolean;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  // The shell reducer keeps the thread list and unchanged thread objects
  // stable, so this only rescans when a thread actually changed.
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const goalsQuery = useEnvironmentQuery(serverEnvironment.goalsLive({ environmentId, input: {} }));
  const goals = goalsQuery.data?.goals ?? null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(new Map<ThreadId, NotificationState>());
  const previousGoals = useRef(new Map<GoalId, GoalNoticeState>());

  // Sound always plays; then the island alerts for a visible, focused window
  // looking somewhere else, otherwise a desktop notification.
  const deliverNotice = useCallback(
    (notice: NoticeDelivery) => {
      if (hasNotificationSound(mode)) {
        void playNotificationSound(notice.kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      if (
        inAppNotificationsEnabled &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        !notice.active
      ) {
        showIslandNotificationFromNotice(notice);
        return;
      }
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus()) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        return;
      try {
        const notification = new Notification(notice.title, {
          body: notice.body,
          tag: notice.tag,
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          notice.action?.open();
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    },
    [environmentId, inAppNotificationsEnabled, mode, onNotification],
  );

  useEffect(() => {
    if (threads === null) {
      previous.current.clear();
      previousGoals.current.clear();
      return;
    }
    // A goal owns its thread's completion notices; without this, every turn
    // the goal dispatches would read as a fresh "Thread completed".
    const goalThreadIds = new Set<ThreadId>();
    for (const goal of goals ?? []) {
      if (goal.threadId !== null) goalThreadIds.add(goal.threadId);
    }
    const next = new Map<ThreadId, NotificationState>();
    // A thread attention notice and the goal transition behind it describe
    // one event; that round the thread's notice speaks for the goal.
    const attentionThreads = new Set<ThreadId>();
    for (const rawThread of threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const prior = previous.current.get(rawThread.id);
      // The same object cannot produce a new notification.
      if (prior?.raw === rawThread) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      // Commands left running (a dev server) read as ready; subagents and monitors wait.
      const completion =
        status === "ready" &&
        thread.latestRun?.status === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { raw: rawThread, attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      if (kind === "input") attentionThreads.add(thread.id);
      if (kind === "completion" && goalThreadIds.has(thread.id)) continue;
      const title =
        kind === "completion"
          ? "Thread completed"
          : status === "approval"
            ? "Approval needed"
            : status === "limited"
              ? "Usage limit reached"
              : status === "failed"
                ? "Thread failed"
                : "Input needed";
      deliverNotice({
        kind,
        toastType: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        title,
        body: thread.title,
        tag: `${environmentId}:${thread.id}`,
        action: {
          label: "Open thread",
          open: () =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            }),
        },
        active: activeEnvironmentId === environmentId && activeThreadId === thread.id,
      });
    }
    previous.current = next;

    const nextGoals = new Map<GoalId, GoalNoticeState>();
    for (const goal of goals ?? []) {
      const prior = previousGoals.current.get(goal.id) ?? null;
      const state = advanceGoalNotice(goal);
      nextGoals.set(goal.id, state);
      // First sighting records only; loading a page must not ping old goals.
      if (prior === null) continue;
      const kind = goalNotification(prior, state);
      if (kind === null) continue;
      const threadId = goal.threadId;
      if (kind === "attention" && threadId !== null && attentionThreads.has(threadId)) continue;
      deliverNotice({
        // The sound knows two cues; a goal's ask plays the input one.
        kind: kind === "completion" ? "completion" : "input",
        toastType:
          kind === "completion" ? "success" : goal.status === "failed" ? "error" : "warning",
        title: goalNoticeTitle(goal.status),
        body: goal.title,
        tag: `${environmentId}:goal:${goal.id}`,
        action:
          threadId === null
            ? null
            : {
                label: "Open goal",
                open: () =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId },
                  }),
              },
        active:
          threadId !== null && activeEnvironmentId === environmentId && activeThreadId === threadId,
      });
    }
    previousGoals.current = nextGoals;
  }, [activeEnvironmentId, activeThreadId, deliverNotice, environmentId, goals, navigate, threads]);

  return null;
}
