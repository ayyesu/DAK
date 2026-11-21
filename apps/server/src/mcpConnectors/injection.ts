import type { ThreadId } from "@dak/contracts";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";

/**
 * A connector as adapters need it: the server name providers register under
 * plus the id its proxy route is addressed by.
 */
export interface ConnectedConnector {
  readonly connectorId: string;
  readonly serverName: string;
}

let connected: readonly ConnectedConnector[] = [];

/**
 * Replaces the process-wide snapshot of connectors that are safe to inject.
 * The connectors service calls this after every load and every mutation;
 * adapters read it synchronously when they assemble a session's MCP config.
 */
export function setConnectedConnectors(connectors: readonly ConnectedConnector[]): void {
  connected = connectors;
}

export interface ConnectorMcpServer {
  readonly serverName: string;
  readonly url: string;
  readonly authorization: string;
}

/**
 * Connector servers for one thread's provider session: same bearer and origin
 * as the thread's own `dak` endpoint, addressed through the proxy route so the
 * credential never travels onward to the connector's server.
 *
 * Returns an empty list when the thread has no session or nothing connects,
 * which is the common case — adapters then skip connector wiring entirely.
 */
export function connectorMcpServers(threadId: ThreadId): readonly ConnectorMcpServer[] {
  if (connected.length === 0) return [];
  const session = McpProviderSession.readMcpProviderSession(threadId);
  if (session === undefined) return [];
  let origin: string;
  try {
    origin = new URL(session.endpoint).origin;
  } catch {
    return [];
  }
  return connected.map((connector) => ({
    serverName: connector.serverName,
    url: `${origin}/mcp/connectors/${connector.connectorId}`,
    authorization: session.authorizationHeader,
  }));
}
