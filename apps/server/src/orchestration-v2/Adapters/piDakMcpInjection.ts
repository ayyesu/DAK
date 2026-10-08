import { tokenizeCliArgs } from "@dak/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import {
  PI_DAK_MCP_EXTENSION_FILENAME,
  PI_DAK_MCP_EXTENSION_SOURCE,
  DAK_MCP_BEARER_ENV,
  DAK_MCP_URL_ENV,
  DAK_PI_RUNTIME_MODE_ENV,
} from "./piDakMcpExtensionSource.ts";

const RESERVED_PI_LAUNCH_ARGUMENTS = new Set([
  "--continue",
  "-c",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--list-models",
  "--mode",
  "--no-session",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--version",
  "-v",
]);

const PI_ARGUMENTS_WITH_VALUES = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--model",
  "--models",
  "--name",
  "-n",
  "--prompt-template",
  "--provider",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--tui-mode",
  "--use-theme",
]);

const PI_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-extensions",
  "-ne",
  "--no-prompt-templates",
  "-np",
  "--no-skills",
  "-ns",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--offline",
  "--verbose",
]);

export type PiLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedPiArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_PI_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function normalizePiBuiltInEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return PI_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

/**
 * Pi launch arguments may configure resources, models, tools, trust, and
 * storage. DAK owns RPC mode and session identity, so arguments that select a
 * different execution mode or native session are rejected before spawn.
 */
export function resolvePiLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
  // Pi parses equals-form tokens only as extension flags, even when their name
  // matches a built-in option. Split known built-ins while leaving arbitrary
  // extension flags in their native form.
  const args = normalizePiBuiltInEqualsArguments(tokenizeCliArgs(launchArgs));
  let hasProvider = false;
  let hasModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedPiArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `Pi launch argument '${reserved}' is controlled by DAK and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "Pi launch arguments cannot include positional prompts.",
      };
    }
    if (PI_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `Pi launch argument '${arg}' requires a value.` };
      }
      if (arg === "--provider") hasProvider = true;
      if (arg === "--model") hasModel = true;
      index += 1;
      continue;
    }
    if (PI_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      // Pi extensions may register arbitrary long flags. Treat one following
      // non-flag token as that extension flag's value.
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Pi launch argument '${arg}' is not supported by DAK.` };
    }
    return {
      ok: false,
      message: `Pi launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  // Pi 1.0 exits at startup on `--provider` without `--model`; older versions
  // silently ran another provider's default model. Rejecting it here makes
  // every spawn site report the reason instead of a bare exit code.
  if (hasProvider && !hasModel) {
    return { ok: false, message: "Pi launch argument '--provider' requires '--model'." };
  }
  return { ok: true, args };
}

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

function normalizedPiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasExplicitExtension(args: ReadonlyArray<string>, extensionPath: string): boolean {
  const wanted = normalizedPiPath(extensionPath);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--extension" && arg !== "-e") continue;
    const configured = args[index + 1];
    if (configured !== undefined && normalizedPiPath(configured) === wanted) return true;
    index += 1;
  }
  return false;
}

function withoutExplicitExtensions(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--extension" || arg === "-e") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--extension=") || arg.startsWith("-e=")) continue;
    filtered.push(arg);
  }
  return filtered;
}

function withoutToolSelectionArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--tools" || arg === "-t" || arg === "--exclude-tools" || arg === "-xt") {
      index += 1;
      continue;
    }
    if (
      arg === "--no-tools" ||
      arg === "-nt" ||
      arg === "--no-builtin-tools" ||
      arg === "-nbt" ||
      arg.startsWith("--tools=") ||
      arg.startsWith("-t=") ||
      arg.startsWith("--exclude-tools=") ||
      arg.startsWith("-xt=")
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function piDakMcpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_DAK_MCP_EXTENSION_FILENAME}`;
}

export const materializePiDakMcpExtension = Effect.fn("materializePiDakMcpExtension")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = piDakMcpExtensionDestPath(cacheDir);
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== PI_DAK_MCP_EXTENSION_SOURCE) {
    yield* fs.writeFileString(dest, PI_DAK_MCP_EXTENSION_SOURCE);
  }
  return dest;
});

export function buildPiRpcLaunch(input: {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly ephemeral?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly hasDakMcp: boolean;
} {
  const hasDakExtension = input.disableExtensions !== true && input.extensionPath !== undefined;
  const hasDakMcp = hasDakExtension && input.mcpSession !== undefined;
  const extensionSafeArgs =
    input.disableExtensions === true
      ? withoutExplicitExtensions(input.launchArgs)
      : input.launchArgs;
  const launchArgs =
    input.disableTools === true ? withoutToolSelectionArgs(extensionSafeArgs) : extensionSafeArgs;
  const args = [
    "--mode",
    "rpc",
    ...(input.ephemeral === true ? ["--no-session"] : []),
    ...launchArgs,
    // Restrictions follow user launch args so a configured --tools or
    // --extension cannot silently re-enable unattended text-generation code.
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
  ];
  if (
    hasDakExtension &&
    input.extensionPath !== undefined &&
    !hasExplicitExtension(args, input.extensionPath)
  ) {
    args.push("--extension", input.extensionPath);
  }
  const environment = { ...input.environment };
  // These values belong to the current DAK session. Never let a Pi child reuse
  // credentials inherited from the server or a parent provider process.
  delete environment[DAK_MCP_URL_ENV];
  delete environment[DAK_MCP_BEARER_ENV];

  return {
    args,
    env: {
      ...environment,
      ...(hasDakExtension && input.runtimeMode !== undefined
        ? {
            [DAK_PI_RUNTIME_MODE_ENV]:
              input.runtimeMode === "auto" ? "approval-required" : input.runtimeMode,
          }
        : {}),
      ...(hasDakMcp && input.mcpSession !== undefined
        ? {
            [DAK_MCP_URL_ENV]: input.mcpSession.endpoint,
            [DAK_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(
              input.mcpSession.authorizationHeader,
            ),
          }
        : {}),
    },
    hasDakMcp,
  };
}
