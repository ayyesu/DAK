import { EnvironmentId, ProviderInstanceId, ThreadId } from "@dak/contracts";
import { assert, describe, it } from "@effect/vitest";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { cursorMcpServers } from "../orchestration-v2/Adapters/CursorAdapterV2.ts";
import * as injection from "./injection.ts";

const CONNECTOR = { connectorId: "context7-0123456789ab", serverName: "context7_connector" };
const CONNECTOR_URL = "http://127.0.0.1:43123/mcp/connectors/context7-0123456789ab";

const withSessionAndConnector = (threadId: ThreadId, run: () => void) => {
  McpProviderSession.setMcpProviderSession({
    environmentId: EnvironmentId.make(`environment-${threadId}`),
    threadId,
    providerSessionId: `mcp-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("test"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer session-token",
    browserToolsAvailable: true,
  });
  injection.setConnectedConnectors([CONNECTOR]);
  try {
    run();
  } finally {
    injection.setConnectedConnectors([]);
    McpProviderSession.clearMcpProviderSession(threadId);
  }
};

describe("connector injection", () => {
  it("addresses connectors through the proxy route with the session bearer", () => {
    const threadId = ThreadId.make("thread-connector-url");
    withSessionAndConnector(threadId, () => {
      assert.deepEqual(injection.connectorMcpServers(threadId), [
        {
          serverName: "context7_connector",
          url: CONNECTOR_URL,
          authorization: "Bearer session-token",
        },
      ]);
    });
  });

  it("injects nothing for a thread with no MCP session", () => {
    injection.setConnectedConnectors([CONNECTOR]);
    try {
      assert.deepEqual(injection.connectorMcpServers(ThreadId.make("thread-no-session")), []);
    } finally {
      injection.setConnectedConnectors([]);
    }
  });

  it("adds connectors to Claude without pre-approving their tools", () => {
    const threadId = ThreadId.make("thread-connector-claude");
    withSessionAndConnector(threadId, () => {
      const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
        threadId,
        readOnlySandbox: false,
      });
      assert.deepEqual(overrides.allowedTools, [ClaudeAdapterV2.CLAUDE_DAK_MCP_TOOL_WILDCARD]);
      assert.deepEqual(Object.keys(overrides.mcpServers ?? {}), ["dak", "context7_connector"]);
      assert.strictEqual(
        (overrides.mcpServers as Record<string, { url: string }>).context7_connector?.url,
        CONNECTOR_URL,
      );
    });
  });

  it("adds connectors to Codex thread config", () => {
    const threadId = ThreadId.make("thread-connector-codex");
    withSessionAndConnector(threadId, () => {
      const params = CodexAdapterV2.codexThreadRuntimeParams({ threadId });
      const servers = params.config.mcp_servers as Record<string, unknown>;
      assert.deepEqual(Object.keys(servers), ["dak", "context7_connector"]);
      assert.deepEqual(servers.context7_connector, {
        url: CONNECTOR_URL,
        http_headers: { Authorization: "Bearer session-token" },
      });
    });
  });

  it("adds connectors to Cursor", () => {
    const threadId = ThreadId.make("thread-connector-cursor");
    withSessionAndConnector(threadId, () => {
      assert.deepEqual(Object.keys(cursorMcpServers(threadId) ?? {}), [
        "dak",
        "context7_connector",
      ]);
    });
  });
});
