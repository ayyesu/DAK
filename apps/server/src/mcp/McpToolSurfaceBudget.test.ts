import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import * as DeviceService from "../device/DeviceService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import budget from "./mcpToolSurfaceBudget.json" with { type: "json" };

// Registration stores tool definitions; handlers' services are never called.
const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed("environment-scratch" as never),
  }),
  ServerSettings.layerTest({}),
);

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const layerTest = McpHttpServer.layerTools.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(layerStubServices),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(PreviewBrowser.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "dak-mcp-surface-budget-" })),
  Layer.provide(NodeServices.layer),
  Layer.provide(FetchHttpClient.layer),
);

/**
 * What every MCP client is told this server can do. Descriptions and input schemas are the
 * model's entire discovery surface, so growth here is agent context growth. Lower the numbers
 * when the text shrinks; raising them is a deliberate change that needs the tool-use eval first.
 */
it.effect("the advertised tool surface matches the committed budget", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = server.tools.map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const measured = {
      toolCount: tools.length,
      descriptionBytes: utf8Bytes(tools.map((tool) => tool.description ?? "").join("")),
      inputSchemaBytes: utf8Bytes(
        JSON.stringify(tools.map(({ name, inputSchema }) => ({ name, inputSchema }))),
      ),
      modelVisibleBytes: utf8Bytes(JSON.stringify(tools)),
    };
    expect(measured).toEqual(budget);
  }).pipe(Effect.provide(layerTest)),
);
