import { WS_METHODS } from "@dak/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createMcpConnectorEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  // Connect, retry, and remove share one queue so a double click cannot race
  // two writes against the same environment's connector list.
  const commandScheduler = createAtomCommandScheduler();
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-connectors:list",
      tag: WS_METHODS.mcpConnectorsList,
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-connectors:connect",
      tag: WS_METHODS.mcpConnectorsConnect,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-connectors:disconnect",
      tag: WS_METHODS.mcpConnectorsDisconnect,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
  };
}
