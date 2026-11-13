import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { IslandProvider, Island } from "@/lib/island";
import { DakIslandController } from "./components/islandcn/DakIslandController";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 * The IslandProvider surfaces DAK's live activity as a Dynamic Island
 * positioned below the topbar (60px > 52px topbar height).
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
      <IslandProvider metrics={{ top: 60 }}>
        <Island placement="viewport" />
        <DakIslandController />
      </IslandProvider>
    </AppAtomRegistryProvider>
  );
}
