import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@dak/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  PI_DAK_MCP_EXTENSION_FILENAME,
  DAK_MCP_BEARER_ENV,
  DAK_MCP_URL_ENV,
  DAK_PI_RUNTIME_MODE_ENV,
} from "./piDakMcpExtensionSource.ts";
import {
  buildPiRpcLaunch,
  materializePiDakMcpExtension,
  resolvePiLaunchArgs,
} from "./piDakMcpInjection.ts";

const threadId = ThreadId.make("thread-pi-dak-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-dak-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

describe("pi DAK MCP injection", () => {
  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-dak-mcp-extension.ts",
      runtimeMode: "approval-required",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-dak-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[DAK_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[DAK_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[DAK_PI_RUNTIME_MODE_ENV], "approval-required");

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [DAK_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [DAK_MCP_BEARER_ENV]: "stale-token",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-dak-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-dak-mcp-extension.ts",
    ]);
    assert.isFalse(permissionOnly.hasDakMcp);
    assert.isUndefined(permissionOnly.env[DAK_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[DAK_MCP_BEARER_ENV]);
    assert.equal(permissionOnly.env[DAK_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
  });

  it("falls back to Pi's first supported mode for legacy auto threads", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-dak-mcp-extension.ts",
      runtimeMode: "auto",
    });

    assert.equal(launch.env[DAK_PI_RUNTIME_MODE_ENV], "approval-required");
  });

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-dak-mcp-extension.ts",
      ephemeral: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--no-extensions",
      "--no-tools",
    ]);
    assert.isFalse(launch.hasDakMcp);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by DAK and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it("rejects --provider without --model, which Pi 1.0 refuses at startup", () => {
    const rejection = {
      ok: false,
      message: "Pi launch argument '--provider' requires '--model'.",
    };
    assert.deepInclude(resolvePiLaunchArgs("--provider openrouter"), rejection);
    assert.deepInclude(resolvePiLaunchArgs("--provider=openrouter --models gpt-6"), rejection);
    assert.isTrue(resolvePiLaunchArgs("--provider openrouter --model=deepseek/v4").ok);
    assert.isTrue(resolvePiLaunchArgs("--model deepseek/v4").ok);
  });

  it.effect("materializes the MCP bridge with namespaced tool registration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "dak-pi-extensions-" });
      const mcpDest = yield* materializePiDakMcpExtension(cacheDir);
      assert.isTrue(mcpDest.endsWith(PI_DAK_MCP_EXTENSION_FILENAME));
      const mcpSource = yield* fs.readFileString(mcpDest);
      assert.include(mcpSource, "export default async function dakMcpExtension");
      assert.include(mcpSource, "before_agent_start");
      assert.include(mcpSource, 'pi.on("tool_call"');
      assert.include(mcpSource, "Allow ${event.toolName}?");
      assert.include(mcpSource, '"mcp-protocol-version"');
      assert.include(mcpSource, '"tools/call"');
      assert.include(mcpSource, "mcp__dak__");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
