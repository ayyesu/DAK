import type { ConnectionTarget } from "@dak/client-runtime/connection";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";

/**
 * Local is either the same-origin primary backend or a desktop-local secondary
 * (the parallel WSL backend) which loops back with a bearer token. Relay, SSH,
 * and saved remote targets are remote.
 */
export function resolveSidebarConnectionMode(target: ConnectionTarget): "local" | "remote" {
  return target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target)
    ? "local"
    : "remote";
}
