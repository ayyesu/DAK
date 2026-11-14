import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  AuthProvidersManageScope,
  type ServerProvider,
  type ProviderInstanceId,
} from "@dak/contracts";

import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironment } from "../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { showIslandNotification } from "./islandcn/NotificationActivity";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  collectUpdatedProviderSnapshots,
  firstFailedProviderUpdateMessage,
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateRejectedToastView,
  getProviderUpdateRunningToastView,
  providerUpdateNotificationKey,
  shouldShowPrimaryProviderUpdateToast,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { useAtomCommand } from "../state/use-atom-command";

const seenProviderUpdateNotificationKeys = new Set<string>();
/** The longest a running update's notice stays up with no final state: a provider install can be slow. */
const PROVIDER_UPDATE_BUSY_MAX_MS = 5 * 60_000;
type ActiveProviderUpdateNotice =
  | {
      readonly kind: "prompt";
      readonly key: string;
      readonly canManageProviders: boolean;
    }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly providerInstanceIds: ReadonlySet<ProviderInstanceId>;
      readonly providerCount: number;
    };

/** What the compact pill has room to say about each phase; the full title is for the expanded view. */
const COMPACT_LABEL: Record<ProviderUpdateToastView["phase"], string> = {
  initial: "Update",
  running: "Updating",
  succeeded: "Updated",
  failed: "Update failed",
  unchanged: "Still outdated",
};

function showProviderUpdateNotice(input: {
  readonly view: ProviderUpdateToastView;
  readonly openSettings: () => void;
  readonly update?: (() => void) | undefined;
}) {
  const { view } = input;
  const busy = view.type === "loading" || view.phase === "running";
  const tone = view.type === "success" ? "success" : view.type === "error" ? "error" : "warning";
  // A running update is capped, not endless: if the provider never reports a final state the
  // notice still goes away. Every other notice keeps the island's default time.
  showIslandNotification({
    tone,
    // Only a finished update is a completion. Everything else about an update is an update, so it
    // gets the download glyph, not the shield that means "approval needed".
    kind: view.type === "success" ? "completion" : "update",
    title: view.title,
    body: view.description,
    compactLabel: COMPACT_LABEL[view.phase],
    busy,
    action: busy
      ? null
      : input.update === undefined
        ? { label: "Settings", open: input.openSettings }
        : // Starting the update must not dismiss the island: the busy notice replaces this one.
          { label: "Update", open: input.update, keepOpen: true },
    ...(input.update === undefined || busy
      ? {}
      : { secondaryAction: { label: "Settings", open: input.openSettings } }),
    ...(busy ? { durationMs: PROVIDER_UPDATE_BUSY_MAX_MS } : {}),
  });
}

/**
 * The single-prompt provider update notification used when there is only one
 * local environment (no WSL backend). Non-WSL users see exactly this flow — the
 * per-environment split is gated behind WSL presence.
 */
export function ProviderUpdatePrimaryNotification() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const canManageProviders = useEnvironmentScope(
    primaryEnvironment?.environmentId ?? null,
    AuthProvidersManageScope,
  );
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const activeNoticeRef = useRef<ActiveProviderUpdateNotice | null>(null);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();

  useEffect(() => {
    return () => {
      activeNoticeRef.current = null;
    };
  }, []);

  const updateProviders = useMemo(() => collectProviderUpdateCandidates(providers), [providers]);
  const notificationKey = useMemo(
    () => providerUpdateNotificationKey(updateProviders),
    [updateProviders],
  );
  const oneClickProviders = useMemo(
    () =>
      updateProviders.filter((provider) => canOneClickUpdateProviderCandidate(provider, providers)),
    [providers, updateProviders],
  );

  const openProviderSettings = useCallback(() => {
    activeNoticeRef.current = null;
    void navigate({ to: "/settings/providers" });
  }, [navigate]);

  useEffect(() => {
    const activeNotice = activeNoticeRef.current;
    if (activeNotice?.kind !== "update") {
      return;
    }

    const activeProviders = providers.filter((provider) =>
      activeNotice.providerInstanceIds.has(provider.instanceId),
    );
    const view = getProviderUpdateProgressToastView({
      providers: activeProviders,
      providerCount: activeNotice.providerCount,
    });
    if (!shouldShowPrimaryProviderUpdateToast(view)) {
      return;
    }

    showProviderUpdateNotice({ view, openSettings: openProviderSettings });
    activeNoticeRef.current = null;
  }, [providers, openProviderSettings]);

  useEffect(() => {
    const activeNotice = activeNoticeRef.current;
    if (activeNotice?.kind === "prompt" && activeNotice.key !== notificationKey) {
      activeNoticeRef.current = null;
    }

    const updateExistingPrompt =
      activeNotice?.kind === "prompt" &&
      activeNotice.key === notificationKey &&
      activeNotice.canManageProviders !== canManageProviders;
    if (
      !notificationKey ||
      dismissedNotificationKeys.has(notificationKey) ||
      (seenProviderUpdateNotificationKeys.has(notificationKey) && !updateExistingPrompt) ||
      (activeNoticeRef.current && !updateExistingPrompt)
    ) {
      return;
    }

    seenProviderUpdateNotificationKeys.add(notificationKey);

    const initialView = getProviderUpdateInitialToastView({ updateProviders, oneClickProviders });

    let updateStarted = false;
    const dismissPrompt = () => {
      dismissNotificationKey(notificationKey);
    };

    const runUpdates = () => {
      if (
        updateStarted ||
        oneClickProviders.length === 0 ||
        !primaryEnvironment ||
        !readEnvironmentScope(primaryEnvironment.environmentId, AuthProvidersManageScope)
      ) {
        return;
      }
      updateStarted = true;

      const providerCount = oneClickProviders.length;
      const providerInstanceIds = new Set(oneClickProviders.map((provider) => provider.instanceId));
      const activeUpdate: ActiveProviderUpdateNotice = {
        kind: "update",
        key: notificationKey,
        providerInstanceIds,
        providerCount,
      };
      activeNoticeRef.current = activeUpdate;
      // Answer the press at once: the island turns into a spinner instead of vanishing.
      showProviderUpdateNotice({
        view: getProviderUpdateRunningToastView(providerCount),
        openSettings: openProviderSettings,
      });

      void (async () => {
        const results = [];
        for (const provider of oneClickProviders) {
          if (!readEnvironmentScope(primaryEnvironment.environmentId, AuthProvidersManageScope)) {
            if (activeNoticeRef.current === activeUpdate) {
              showProviderUpdateNotice({
                view: getProviderUpdateRejectedToastView(
                  providerCount,
                  "This connection cannot manage provider accounts.",
                ),
                openSettings: openProviderSettings,
              });
              activeNoticeRef.current = null;
            }
            return;
          }
          results.push(
            await updateProvider({
              environmentId: primaryEnvironment.environmentId,
              input: {
                provider: provider.driver,
                instanceId: provider.instanceId,
              },
            }),
          );
        }

        const activeUpdateNotice = activeNoticeRef.current;
        if (activeUpdateNotice !== activeUpdate) {
          return;
        }

        const failedMessage = firstFailedProviderUpdateMessage(results);
        if (failedMessage) {
          showProviderUpdateNotice({
            view: getProviderUpdateRejectedToastView(providerCount, failedMessage),
            openSettings: openProviderSettings,
          });
          activeNoticeRef.current = null;
          return;
        }

        const updatedProviderSnapshots = collectUpdatedProviderSnapshots({
          results,
          providerInstanceIds,
        });
        const view = getProviderUpdateProgressToastView({
          providers: updatedProviderSnapshots,
          providerCount,
        });
        if (shouldShowPrimaryProviderUpdateToast(view)) {
          showProviderUpdateNotice({ view, openSettings: openProviderSettings });
          activeNoticeRef.current = null;
        }
      })();
    };

    showProviderUpdateNotice({
      view: {
        ...initialView,
        description: canManageProviders
          ? initialView.description
          : "This connection cannot manage provider accounts. View provider settings for update details.",
      },
      openSettings: () => {
        dismissPrompt();
        openProviderSettings();
      },
      ...(oneClickProviders.length > 0 && canManageProviders ? { update: runUpdates } : {}),
    });
    activeNoticeRef.current = { kind: "prompt", key: notificationKey, canManageProviders };
  }, [
    canManageProviders,
    updateProvider,
    dismissNotificationKey,
    dismissedNotificationKeys,
    notificationKey,
    oneClickProviders,
    openProviderSettings,
    primaryEnvironment,
    updateProviders,
  ]);

  return null;
}
