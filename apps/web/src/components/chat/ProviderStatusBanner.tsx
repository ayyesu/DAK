import { type ProviderInstanceId, type ServerProvider } from "@dak/contracts";
import { memo, useEffect, useRef } from "react";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { showIslandNotification } from "../islandcn/NotificationActivity";

/** Unsupported and broken versions fail mid-turn, so they warn even when ready. */
function getIncompatibleVersion(status: ServerProvider) {
  const compatibility = status.compatibilityAdvisory;
  if (status.status === "error" && status.auth.status === "unauthenticated") return null;
  return compatibility?.status === "broken" ||
    (status.status === "ready" && compatibility?.status === "unsupported")
    ? compatibility
    : null;
}

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  if (!status || status.status === "disabled") return null;
  const incompatible = getIncompatibleVersion(status);
  if (incompatible) {
    return [
      status.instanceId,
      incompatible.status,
      status.version ?? "",
      incompatible.message ?? "",
    ].join("\u0000");
  }
  if (status.status === "ready") return null;
  // Antigravity checks saved credentials when a session starts. Its local
  // health check leaves auth unknown after a restart, which is not a failure.
  if (
    status.driver === "antigravity" &&
    status.installed &&
    status.status === "warning" &&
    status.auth.status === "unknown"
  ) {
    return null;
  }
  return [status.instanceId, status.status, status.auth.status, status.message ?? ""].join(
    "\u0000",
  );
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
): boolean {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}

/** Broken-version guidance takes precedence over startup failures it can cause. */
export function getProviderStatusMessage(status: ServerProvider): string {
  if (
    status.auth.status !== "unauthenticated" &&
    status.compatibilityAdvisory?.status === "broken" &&
    status.compatibilityAdvisory.message
  ) {
    return status.compatibilityAdvisory.message;
  }
  if (status.message) return status.message;
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (!status.installed && hasProviderSetup(status)) {
    return `Open provider setup to install ${formatProviderDriverKindLabel(status.driver)} on this environment.`;
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? "Open provider setup to sign in with Google."
        : "Open provider setup to sign in.";
    }
    return "Sign in via the CLI to authenticate again.";
  }
  return status.status === "ready"
    ? "No models are available for this provider."
    : status.status === "error"
      ? `${providerName} provider is unavailable.`
      : `${providerName} provider has limited availability.`;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  onOpenProviderSetup,
  status,
}: {
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  status: ServerProvider | null;
}) {
  const emittedKey = useRef<string | null>(null);
  const bannerKey = getProviderStatusBannerKey(status);

  useEffect(() => {
    if (!status || bannerKey === null || emittedKey.current === bannerKey) return;
    emittedKey.current = bannerKey;

    const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
    const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
    const incompatible = getIncompatibleVersion(status);
    const title = isUnauthenticated
      ? `${providerName} is unauthenticated`
      : incompatible
        ? `${providerName} ${status.version ?? ""} is ${incompatible.status === "broken" ? "known to be broken" : "unsupported"}`
        : `${providerName} provider status`;
    const isWarning =
      incompatible?.status !== "broken" && (status.status === "warning" || incompatible !== null);
    const canOpenSetup = onOpenProviderSetup !== undefined && hasProviderSetup(status);

    showIslandNotification({
      tone: isWarning ? "warning" : "error",
      kind: "input",
      title,
      body: incompatible?.message ?? getProviderStatusMessage(status),
      action: canOpenSetup
        ? {
            label: "Open setup",
            open: () => onOpenProviderSetup(status.instanceId),
          }
        : null,
    });
    // The island owns the transient presentation. Mark the snapshot handled
    // so an ordinary chat render can never recreate the disruptive banner.
    onDismiss();
  }, [bannerKey, onDismiss, onOpenProviderSetup, status]);

  return null;
});
