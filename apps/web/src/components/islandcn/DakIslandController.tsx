/**
 * Registers DAK's global Dynamic Island activities. Lives in the root route,
 * so it sees every environment and thread, not just the routed one:
 *
 * - "Approval needed" / "Input needed": one activity per thread blocked on an
 *   approval or a user question, anywhere in the workspace. Each names its thread
 *   and waits until that thread is answered, with no timeout and no queue.
 * - Desktop update news (Electron only): a transient notice when the update
 *   state gains something to act on. The sidebar's update control owns the
 *   whole flow; this only points at it.
 *
 * Composer-local activities (plan mode, goal composer) live in the chat view,
 * next to the state they reflect.
 */

import { MessageCircleQuestionIcon, ShieldQuestionIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { DesktopUpdateState } from "@dak/contracts";
import type { EnvironmentThreadShell } from "@dak/client-runtime/state/shell";

import { useNavigate, useParams } from "@tanstack/react-router";

import { useThreadShells } from "~/state/entities";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { isElectron } from "~/env";
import { useIslandActions } from "~/lib/island";
import { revealSidebarUpdateControl } from "../sidebar/sidebarUpdateControlBus";
import { IslandButton } from "./island-button";
import { ExpandedBottom } from "./island-layout";
import { GoalIslandActivities } from "./GoalIslandActivity";
import { showIslandNotification } from "./NotificationActivity";
import { CompactText, ExpandedSubtitle, ExpandedTitle, TitleStack } from "./island-text";
import { IslandCompactGlyph, IslandTile } from "./islandContent";
import { islandAccent } from "./theme";
import { islandActivityPriority } from "./activity-priority";

/** One activity per thread, so two blocked threads are two pills, not one queue. */
const needsInputId = (shell: EnvironmentThreadShell) =>
  `needs-input:${shell.environmentId}:${shell.id}`;

/** What the thread is waiting for, in the sidebar's own words; an approval outranks the question. */
const needsInputKind = (shell: EnvironmentThreadShell): "approval" | "input" | null =>
  shell.hasPendingApprovals ? "approval" : shell.hasPendingUserInput ? "input" : null;

const needsInputLabel = (kind: "approval" | "input", title: string): string =>
  `${kind === "approval" ? "Approval" : "Input"} needed: ${title}`;

const needsInputContent = (kind: "approval" | "input", title: string, onOpen: () => void) => {
  const accent = islandAccent.orange;
  const glyph = (size: number) =>
    kind === "approval" ? (
      <ShieldQuestionIcon size={size} strokeWidth={2} color={accent} aria-hidden />
    ) : (
      <MessageCircleQuestionIcon size={size} strokeWidth={2} color={accent} aria-hidden />
    );
  const heading = kind === "approval" ? "Approval needed" : "Input needed";

  return {
    compact: {
      leading: <IslandCompactGlyph>{glyph(21)}</IslandCompactGlyph>,
      trailing: (
        <CompactText color={accent}>{kind === "approval" ? "Approval" : "Input"}</CompactText>
      ),
    },
    minimal: <IslandCompactGlyph>{glyph(21)}</IslandCompactGlyph>,
    expanded: {
      leading: <IslandTile color={accent}>{glyph(26)}</IslandTile>,
      center: (
        <TitleStack
          title={<ExpandedTitle>{heading}</ExpandedTitle>}
          subtitle={<ExpandedSubtitle>{title}</ExpandedSubtitle>}
        />
      ),
      bottom: (
        <ExpandedBottom reach="action">
          <IslandButton
            tone={{ kind: "accent", color: accent }}
            onPress={onOpen}
            label={`Open ${title}`}
          >
            Open thread
          </IslandButton>
        </ExpandedBottom>
      ),
    },
  };
};

/**
 * One activity per thread waiting on a human, the way the pre-island "Input needed"
 * and "Approval needed" notices worked: it names the thread, offers to open it, and
 * stays for as long as the agent is waiting. Nothing times it out and nothing queues
 * behind it: a blocked agent has stopped, so the only ways out are answering it or
 * cancelling it. The thread already open in front of the user needs no pill, because
 * its approval UI is on screen.
 */
const NeedsInputActivities = () => {
  const island = useIslandActions();
  const navigate = useNavigate();
  const { environmentId: routedEnvironmentId, threadId: routedThreadId } = useParams({
    strict: false,
  });
  const shells = useThreadShells();
  // Per-activity content, so a shell emission that changes nothing the card shows
  // never reaches the island.
  const contentRef = useRef(new Map<string, string>());
  const registeredRef = useRef(new Set<string>());
  /**
   * Threads in the previous snapshot, and those blocked in it. A thread that starts
   * waiting is news; one that arrives already waiting is not, it predates this client.
   */
  const presentRef = useRef(new Set<string>());
  const blockedWasRef = useRef(new Set<string>());
  useEffect(() => {
    const registered = new Set<string>();
    const present = new Set<string>();
    const blockedNow = new Set<string>();

    for (const shell of shells) {
      const id = needsInputId(shell);
      present.add(id);
      const kind = needsInputKind(shell);
      if (kind === null) continue;
      blockedNow.add(id);

      // The thread open in front of the user needs no pill; the cleanup below
      // ends the one it was showing.
      if (shell.environmentId === routedEnvironmentId && shell.id === routedThreadId) continue;

      registered.add(id);
      const open = () => {
        island.collapse();
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: shell.environmentId, threadId: shell.id },
        });
      };
      const content = needsInputContent(kind, shell.title, open);
      const signature = `${kind}:${shell.title}`;
      const changed = contentRef.current.get(id) !== signature;

      if (!registeredRef.current.has(id)) {
        island.start({
          id,
          label: needsInputLabel(kind, shell.title),
          priority: islandActivityPriority.needsInput,
          // Only a thread this client watched start waiting asks for attention; work
          // that was already waiting when the page opened is stated, not announced.
          alert: presentRef.current.has(id) && !blockedWasRef.current.has(id),
          onPress: open,
          ...content,
        });
        contentRef.current.set(id, signature);
      } else if (changed) {
        island.update(id, {
          label: needsInputLabel(kind, shell.title),
          priority: islandActivityPriority.needsInput,
          onPress: open,
          ...content,
        });
        contentRef.current.set(id, signature);
      }
    }

    for (const id of registeredRef.current) {
      if (registered.has(id)) continue;
      island.end(id);
      contentRef.current.delete(id);
    }

    presentRef.current = present;
    blockedWasRef.current = blockedNow;
    registeredRef.current = registered;
  }, [island, navigate, routedEnvironmentId, routedThreadId, shells]);

  useEffect(
    () => () => {
      for (const id of registeredRef.current) island.end(id);
      registeredRef.current.clear();
      contentRef.current.clear();
    },
    [island],
  );

  return null;
};

/** Where the update control lives, so a notice can point at it. */
const UPDATE_CONTROL_LOCATION = "the update button in the sidebar";

/**
 * The states worth a notice: the update gained something the user can act on.
 * Checking and downloading are progress the sidebar control already shows.
 * The key collapses repeated renders of the same news into one announcement.
 */
const updateNewsKey = (state: DesktopUpdateState): string | null => {
  switch (state.status) {
    case "available":
      return `available:${state.availableVersion ?? ""}`;
    case "downloaded":
      return `downloaded:${state.downloadedVersion ?? state.availableVersion ?? ""}`;
    case "error":
      return `error:${state.errorContext ?? ""}:${state.message ?? ""}`;
    default:
      return null;
  }
};

const updateNotice = (state: DesktopUpdateState) => {
  switch (state.status) {
    case "available":
      return {
        tone: "warning",
        kind: "update",
        title: `DAK ${state.availableVersion ?? "update"} available`,
        body: `Download it from ${UPDATE_CONTROL_LOCATION}.`,
        action: { label: "Show update", open: revealSidebarUpdateControl },
      } as const;
    case "downloaded": {
      const version = state.downloadedVersion ?? state.availableVersion;
      return {
        tone: "success",
        kind: "completion",
        title: "Update ready to install",
        body: version
          ? `Restart from ${UPDATE_CONTROL_LOCATION} to install ${version}.`
          : `Restart from ${UPDATE_CONTROL_LOCATION} to install it.`,
        action: { label: "Show restart", open: revealSidebarUpdateControl },
      } as const;
    }
    case "error":
      return {
        tone: "error",
        kind: "update",
        title: "Could not update",
        body: state.message?.trim() || `Try again from ${UPDATE_CONTROL_LOCATION}.`,
        action: { label: "Show update", open: revealSidebarUpdateControl },
      } as const;
    default:
      return null;
  }
};

/**
 * Announces update transitions, once each. The state arrives after mount, so
 * the first snapshot is what was already true when the window opened — the
 * sidebar control shows it without interrupting.
 */
export const DesktopUpdateNotice = () => {
  const state = useDesktopUpdateState();
  const seenStateRef = useRef(false);
  const announcedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (state === null) return;
    const key = updateNewsKey(state);
    if (!seenStateRef.current) {
      seenStateRef.current = true;
      announcedKeyRef.current = key;
      return;
    }
    if (key === announcedKeyRef.current) return;
    announcedKeyRef.current = key;
    const notice = updateNotice(state);
    if (notice === null) return;
    showIslandNotification(notice);
  }, [state]);

  return null;
};

export const DakIslandController = () => (
  <>
    <NeedsInputActivities />
    {isElectron ? <DesktopUpdateNotice /> : null}
    <GoalIslandActivities />
  </>
);
