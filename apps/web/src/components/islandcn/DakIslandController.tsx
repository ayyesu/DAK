/**
 * Registers DAK's global Dynamic Island activities. Lives in the root route,
 * so it sees every environment and thread, not just the routed one:
 *
 * - "Check for updates" (Electron only): mirrors the desktop update state,
 *   expands to an action button. The idle case stays invisible at the bottom
 *   of the stack; it surfaces on its own when there is news.
 * - "Needs your input": any thread blocked on an approval or a user question
 *   anywhere in the workspace. Alerts once on the transition into blocked.
 *
 * Composer-local activities (plan mode, goal composer) live in the chat view,
 * next to the state they reflect.
 */

import {
  RefreshCwIcon,
  CheckIcon,
  DownloadIcon,
  MessageCircleQuestionIcon,
  PowerIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import type { DesktopUpdateState } from "@dak/contracts";

import { useNavigate } from "@tanstack/react-router";

import { useThreadShells } from "~/state/entities";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { isElectron } from "~/env";
import { ensureLocalApi } from "~/localApi";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import {
  canCheckForUpdate,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateActionError,
  getDesktopUpdateReleaseUrl,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { useIslandActions } from "~/lib/island";
import { IslandButton } from "./island-button";
import { ExpandedBottom } from "./island-layout";
import { Spinner } from "./spinner";
import { CaptionButton } from "./island-layout";
import { CompactText, ExpandedSubtitle, ExpandedTitle, TitleStack } from "./island-text";
import { IslandCompactGlyph, IslandTile } from "./islandContent";
import { LinearProgress } from "./linear-progress";
import { islandAccent, islandInk } from "./theme";

const NEEDS_INPUT_ID = "needs-input";
const DESKTOP_UPDATE_ID = "desktop-update";

/** Blocked means the agent stopped and is waiting on a human. */
const useBlockedThreads = () => {
  const shells = useThreadShells();
  return shells.filter((shell) => shell.hasPendingApprovals || shell.hasPendingUserInput);
};

const needsInputContent = (count: number, firstTitle: string | null, onOpen: () => void) => ({
  compact: {
    leading: (
      <IslandCompactGlyph>
        <MessageCircleQuestionIcon
          size={21}
          strokeWidth={2}
          color={islandAccent.orange}
          aria-hidden
        />
      </IslandCompactGlyph>
    ),
    trailing: (
      <CompactText color={islandAccent.orange} style={{ fontVariantNumeric: "tabular-nums" }}>
        {count === 1 ? "1 thread" : `${count} threads`}
      </CompactText>
    ),
  },
  minimal: (
    <IslandCompactGlyph>
      <MessageCircleQuestionIcon
        size={21}
        strokeWidth={2}
        color={islandAccent.orange}
        aria-hidden
      />
    </IslandCompactGlyph>
  ),
  expanded: {
    leading: (
      <IslandTile color={islandAccent.orange}>
        <MessageCircleQuestionIcon
          size={26}
          strokeWidth={2}
          color={islandAccent.orange}
          aria-hidden
        />
      </IslandTile>
    ),
    center: (
      <TitleStack
        title={<ExpandedTitle>Needs your input</ExpandedTitle>}
        subtitle={
          <ExpandedSubtitle>
            {firstTitle === null
              ? count === 1
                ? "A thread is blocked on you"
                : `${count} threads are blocked on you`
              : count > 1
                ? `${firstTitle} · +${count - 1} more`
                : firstTitle}
          </ExpandedSubtitle>
        }
      />
    ),
    bottom: (
      <ExpandedBottom reach="action">
        <IslandButton
          tone={{ kind: "accent", color: islandAccent.orange }}
          onPress={onOpen}
          label="Open the blocked thread"
        >
          Open thread
        </IslandButton>
      </ExpandedBottom>
    ),
  },
});

const NeedsInputActivity = () => {
  const island = useIslandActions();
  const navigate = useNavigate();
  const blocked = useBlockedThreads();
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const prevCountRef = useRef<number | null>(null);
  const showingRef = useRef(false);
  const openFirst = () => {
    const first = blockedRef.current[0];
    if (!first) return;
    island.collapse();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: first.environmentId, threadId: first.id },
    });
  };

  useEffect(() => {
    const count = blocked.length;
    const rising = prevCountRef.current !== null && prevCountRef.current === 0 && count > 0;
    prevCountRef.current = count;

    if (count === 0) {
      if (showingRef.current) {
        island.end(NEEDS_INPUT_ID);
        showingRef.current = false;
      }
      return;
    }

    const content = needsInputContent(count, blocked[0]?.title ?? null, openFirst);
    if (!showingRef.current) {
      island.start({
        id: NEEDS_INPUT_ID,
        label: "Needs your input",
        priority: 100,
        alert: rising,
        onPress: openFirst,
        ...content,
      });
      showingRef.current = true;
      return;
    }
    island.update(NEEDS_INPUT_ID, { ...content, onPress: openFirst, transition: "update" });
  }, [island, blocked]);

  useEffect(
    () => () => {
      if (showingRef.current) island.end(NEEDS_INPUT_ID);
    },
    [island],
  );

  return null;
};

interface DesktopUpdateView {
  readonly action: "download" | "install" | "none";
  readonly actionable: boolean;
}

const updateView = (state: DesktopUpdateState): DesktopUpdateView => {
  const action = resolveDesktopUpdateButtonAction(state);
  const actionable =
    state.status === "checking" ||
    state.status === "downloading" ||
    state.status === "error" ||
    action !== "none";
  return { action, actionable };
};

const updateCopy = (state: DesktopUpdateState) => {
  const { action } = updateView(state);
  const version = state.downloadedVersion ?? state.availableVersion;
  switch (state.status) {
    case "checking":
      return { title: "Checking for updates…", subtitle: "Looking for a new build of DAK" };
    case "downloading": {
      const percent =
        typeof state.downloadPercent === "number" ? Math.floor(state.downloadPercent) : null;
      return {
        title: "Downloading update",
        subtitle: `DAK ${version ?? ""}${percent === null ? "" : ` · ${percent}%`}`.trim(),
      };
    }
    case "downloaded":
      return {
        title: "Update ready",
        subtitle: `Restart to install ${version ?? ""}`.trim(),
      };
    case "error":
      return {
        title: "Could not update",
        subtitle:
          state.message?.trim() ||
          (state.canRetry ? "Something went wrong. Try again." : "Update failed"),
      };
    case "available":
      return {
        title: `DAK ${version ?? "update"} available`,
        subtitle: state.releaseNotes[0]?.items[0]?.trim() || "Update ready to download",
      };
    default:
      return action === "install"
        ? { title: "Update ready", subtitle: `Restart to install ${version ?? ""}`.trim() }
        : { title: "You're up to date", subtitle: `DAK ${state.currentVersion}` };
  }
};

const updateAccent = (state: DesktopUpdateState) => {
  switch (state.status) {
    case "checking":
      return islandAccent.sky;
    case "available":
    case "downloading":
      return islandAccent.blue;
    case "downloaded":
      return islandAccent.green;
    case "error":
      return islandAccent.orange;
    default:
      return islandAccent.sky;
  }
};

const updateGlyph = (state: DesktopUpdateState, size: number) => {
  const color = updateAccent(state);
  const strokeWidth = 2;
  if (state.status === "checking")
    return <RefreshCwIcon size={size} strokeWidth={strokeWidth} color={color} aria-hidden />;
  if (state.status === "available")
    return <DownloadIcon size={size} strokeWidth={strokeWidth} color={color} aria-hidden />;
  if (state.status === "downloading")
    return <DownloadIcon size={size} strokeWidth={strokeWidth} color={color} aria-hidden />;
  if (state.status === "downloaded" || updateView(state).action === "install")
    return <CheckIcon size={size} strokeWidth={strokeWidth} color={color} aria-hidden />;
  if (state.status === "error")
    return <TriangleAlertIcon size={size} strokeWidth={strokeWidth} color={color} aria-hidden />;
  return (
    <RefreshCwIcon size={size} strokeWidth={strokeWidth} color={islandInk.tertiary} aria-hidden />
  );
};

const updateTail = (state: DesktopUpdateState): string => {
  switch (state.status) {
    case "checking":
      return "Checking…";
    case "downloading":
      return typeof state.downloadPercent === "number"
        ? `${Math.floor(state.downloadPercent)}%`
        : "…";
    case "downloaded":
      return "Ready";
    case "error":
      return "Retry";
    case "available": {
      const v = state.availableVersion;
      return v ? `v${v}` : "Update";
    }
    default:
      return "Check";
  }
};

interface UpdateActionHandlers {
  readonly onCheck: () => void;
  readonly onDownload: () => void;
  readonly onInstall: () => void;
  readonly onReleaseNotes: () => void;
}

const releaseNotesFor = (state: DesktopUpdateState): boolean =>
  state.channel === "nightly" && state.releaseNotes.length > 0;

const withReleaseNotes = (
  state: DesktopUpdateState,
  node: ReactNode,
  handlers: UpdateActionHandlers,
) => (
  <ExpandedBottom reach="action" gap={2}>
    {node}
    {releaseNotesFor(state) ? (
      <div style={{ display: "flex", justifyContent: "center" }}>
        <CaptionButton
          color={islandAccent.sky}
          label="What changed in this nightly build"
          onPress={handlers.onReleaseNotes}
        >
          What&apos;s new
        </CaptionButton>
      </div>
    ) : null}
  </ExpandedBottom>
);

const updateButton = (
  state: DesktopUpdateState,
  action: DesktopUpdateView,
  busy: boolean,
  handlers: UpdateActionHandlers,
) => {
  switch (state.status) {
    case "checking":
      return (
        <IslandButton disabled size="regular" fill onPress={() => undefined}>
          Checking…
        </IslandButton>
      );
    case "downloading":
      return (
        <ExpandedBottom reach="action" gap={6}>
          <LinearProgress
            value={typeof state.downloadPercent === "number" ? state.downloadPercent / 100 : 0}
            label="Downloading update"
            height={6}
          />
        </ExpandedBottom>
      );
    case "downloaded":
      return withReleaseNotes(
        state,
        <IslandButton
          tone={{ kind: "accent", color: islandAccent.green }}
          onPress={handlers.onInstall}
          disabled={busy}
          label="Restart to update"
        >
          <PowerIcon size={17} strokeWidth={2.25} aria-hidden /> Restart to update
        </IslandButton>,
        handlers,
      );
    case "available":
      return withReleaseNotes(
        state,
        <IslandButton
          tone={{ kind: "accent", color: islandAccent.blue, text: "#fff" }}
          onPress={handlers.onDownload}
          disabled={busy}
          label="Download update"
        >
          <DownloadIcon size={17} strokeWidth={2.25} aria-hidden /> Download
        </IslandButton>,
        handlers,
      );
    case "error":
      return action.action === "install"
        ? withReleaseNotes(
            state,
            <IslandButton
              tone={{ kind: "accent", color: islandAccent.orange }}
              onPress={handlers.onInstall}
              disabled={busy}
              label="Retry install"
            >
              <PowerIcon size={17} strokeWidth={2.25} aria-hidden /> Retry install
            </IslandButton>,
            handlers,
          )
        : withReleaseNotes(
            state,
            <IslandButton
              tone={{ kind: "accent", color: islandAccent.orange }}
              onPress={handlers.onDownload}
              disabled={busy}
              label="Retry download"
            >
              <DownloadIcon size={17} strokeWidth={2.25} aria-hidden /> Retry download
            </IslandButton>,
            handlers,
          );
    default:
      return withReleaseNotes(
        state,
        <IslandButton
          onPress={handlers.onCheck}
          disabled={busy || !canCheckForUpdate(state)}
          label="Check for updates"
        >
          <RefreshCwIcon size={17} strokeWidth={2.25} aria-hidden /> Check for updates
        </IslandButton>,
        handlers,
      );
  }
};

const DesktopUpdateActivity = () => {
  const island = useIslandActions();
  const state = useDesktopUpdateState();
  const [isPending, setIsPending] = useState(false);
  const showingRef = useRef(false);
  const bridge = isElectron ? window.desktopBridge : undefined;

  const checkForUpdate = () => {
    if (!bridge || !state || isPending || !canCheckForUpdate(state)) return;
    setIsPending(true);
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          }),
        );
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      })
      .finally(() => setIsPending(false));
  };

  const downloadUpdate = () => {
    if (!bridge || !state || isPending || isDesktopUpdateButtonDisabled(state)) return;
    setIsPending(true);
    void bridge
      .downloadUpdate()
      .then((result) => {
        if (result.completed) showDesktopUpdateDownloadedToast(bridge, result.state);
        if (!shouldToastDesktopUpdateActionResult(result)) return;
        const actionError = getDesktopUpdateActionError(result);
        if (!actionError) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download update",
            description: actionError,
          }),
        );
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      })
      .finally(() => setIsPending(false));
  };

  const installUpdate = () => {
    if (!bridge || !state || isPending) return;
    let confirmed = false;
    setIsPending(true);
    void ensureLocalApi()
      .dialogs.confirm(getDesktopUpdateInstallConfirmationMessage(state))
      .then((ok) => {
        confirmed = ok;
        if (!confirmed) {
          setIsPending(false);
          return;
        }
        void bridge
          .installUpdate()
          .then((result) => {
            if (!shouldToastDesktopUpdateActionResult(result)) return;
            const actionError = getDesktopUpdateActionError(result);
            if (!actionError) return;
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not install update",
                description: actionError,
              }),
            );
          })
          .catch((error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not install update",
                description:
                  error instanceof Error ? error.message : "An unexpected error occurred.",
              }),
            );
          })
          .finally(() => setIsPending(false));
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        setIsPending(false);
      });
  };

  const openReleaseNotes = () => {
    if (!state) return;
    const url = getDesktopUpdateReleaseUrl(state.downloadedVersion ?? state.availableVersion);
    if (!url) return;
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => undefined);
  };

  const releaseNotesHandlers: UpdateActionHandlers = {
    onCheck: checkForUpdate,
    onDownload: downloadUpdate,
    onInstall: installUpdate,
    onReleaseNotes: openReleaseNotes,
  };

  useEffect(() => {
    if (!state) {
      if (showingRef.current) {
        island.end(DESKTOP_UPDATE_ID);
        showingRef.current = false;
      }
      return;
    }
    const { action, actionable } = updateView(state);
    const accent = updateAccent(state);
    const copy = updateCopy(state);
    const version = getDesktopUpdateDownloadedVersion(state);

    const content = {
      compact: {
        leading: (
          <IslandCompactGlyph>
            {state.status === "checking" ? (
              <Spinner size={15} color={accent} thickness={2} />
            ) : (
              updateGlyph(state, 19)
            )}
          </IslandCompactGlyph>
        ),
        trailing: (
          <CompactText
            style={{ fontVariantNumeric: "tabular-nums" }}
            color={actionable ? accent : islandInk.secondary}
          >
            {updateTail(state)}
          </CompactText>
        ),
      },
      expanded: {
        leading: <IslandTile color={accent}>{updateGlyph(state, 26)}</IslandTile>,
        center: (
          <TitleStack
            title={<ExpandedTitle>{copy.title}</ExpandedTitle>}
            subtitle={<ExpandedSubtitle>{copy.subtitle}</ExpandedSubtitle>}
          />
        ),
        bottom: updateButton(state, { action, actionable }, isPending, releaseNotesHandlers),
      },
    };

    if (!showingRef.current) {
      island.start({
        id: DESKTOP_UPDATE_ID,
        label: "Desktop update",
        // Present only when there is news; an idle pill never crowds the island.
        priority: actionable ? 50 : -1,
        onPress: () => island.expand(DESKTOP_UPDATE_ID),
        ...content,
      });
      showingRef.current = true;
      return;
    }
    island.update(DESKTOP_UPDATE_ID, {
      ...content,
      priority: actionable ? 50 : -1,
      onPress: () => island.expand(DESKTOP_UPDATE_ID),
    });
  }, [island, state, isPending]);

  useEffect(
    () => () => {
      if (showingRef.current) island.end(DESKTOP_UPDATE_ID);
    },
    [island],
  );

  return null;
};

export const DakIslandController = () => (
  <>
    <NeedsInputActivity />
    {isElectron ? <DesktopUpdateActivity /> : null}
  </>
);
