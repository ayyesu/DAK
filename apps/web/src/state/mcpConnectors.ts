import { createMcpConnectorEnvironmentAtoms } from "@dak/client-runtime/state/mcp-connectors";

import { connectionAtomRuntime } from "../connection/runtime";

export const mcpConnectorEnvironment = createMcpConnectorEnvironmentAtoms(connectionAtomRuntime);
