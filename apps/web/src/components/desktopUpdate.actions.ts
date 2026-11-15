import type { DesktopUpdateActionResult, DesktopUpdateState } from "@dak/contracts";
import { useCallback, useMemo, useState } from "react";

import { ensureLocalApi } from "~/localApi";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * The desktop update flows every control offers — check, download, install —
 * with one pending flag and one set of failure toasts, so the sidebar pill and
 * the legacy sidebar report the same error the same way.
 *
 * A completed download is deliberately not announced here: whether it deserves
 * a second interruption on top of the island's notice is the caller's decision.
 */
export interface DesktopUpdateActions {
  /** True from the moment a flow starts until its promise settles. */
  readonly isPending: boolean;
  /** Downloads the update. Null when the bridge is missing or the call failed. */
  download(): Promise<DesktopUpdateActionResult | null>;
  /** Confirms with the user, then installs. False when unavailable or declined. */
  install(state: DesktopUpdateState): Promise<boolean>;
  /** Checks for a newer build. */
  check(): Promise<void>;
}

export function useDesktopUpdateActions(): DesktopUpdateActions {
  const [isPending, setIsPending] = useState(false);

  const download = useCallback(async (): Promise<DesktopUpdateActionResult | null> => {
    const bridge = window.desktopBridge;
    if (!bridge) return null;
    setIsPending(true);
    try {
      const result = await bridge.downloadUpdate();
      if (shouldToastDesktopUpdateActionResult(result)) {
        const actionError = getDesktopUpdateActionError(result);
        if (actionError) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        }
      }
      return result;
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start update download",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
      return null;
    } finally {
      setIsPending(false);
    }
  }, []);

  const install = useCallback(async (state: DesktopUpdateState): Promise<boolean> => {
    const bridge = window.desktopBridge;
    if (!bridge) return false;
    // Pending spans the confirmation too: the dialog is modal, but the button
    // should not read as idle while it is up.
    setIsPending(true);
    try {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(state),
        );
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return false;
      }
      if (!confirmed) return false;

      try {
        const result = await bridge.installUpdate();
        if (shouldToastDesktopUpdateActionResult(result)) {
          const actionError = getDesktopUpdateActionError(result);
          if (actionError) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not install update",
                description: actionError,
              }),
            );
          }
        }
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
      return true;
    } finally {
      setIsPending(false);
    }
  }, []);

  const check = useCallback(async (): Promise<void> => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setIsPending(true);
    try {
      const result = await bridge.checkForUpdate();
      if (result.checked) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not check for updates",
          description: result.state.message ?? "Automatic updates are not available in this build.",
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not check for updates",
          description: error instanceof Error ? error.message : "Update check failed.",
        }),
      );
    } finally {
      setIsPending(false);
    }
  }, []);

  return useMemo(
    () => ({ isPending, download, install, check }),
    [isPending, download, install, check],
  );
}
