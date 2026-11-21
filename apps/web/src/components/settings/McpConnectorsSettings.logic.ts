import * as Schema from "effect/Schema";
import type {
  McpConnector,
  McpConnectorPreset,
  McpConnectorStatus,
  McpConnectorsListResult,
} from "@dak/contracts";
import { McpConnectorError } from "@dak/contracts";

const isMcpConnectorError = Schema.is(McpConnectorError);
import { MCP_CONNECTOR_PROVIDER_LABELS, normalizeMcpConnectorUrl } from "@dak/shared/mcpConnectors";

export interface ConnectorStatusPresentation {
  readonly label: string;
  readonly variant: "success" | "warning" | "error";
  /** One sentence on what the person can do about it, or null when nothing. */
  readonly hint: string | null;
}

export function connectorStatusPresentation(
  status: McpConnectorStatus,
): ConnectorStatusPresentation {
  switch (status) {
    case "connected":
      return { label: "Connected", variant: "success", hint: null };
    case "unreachable":
      return {
        label: "Unreachable",
        variant: "warning",
        hint: "The server did not answer. Agents still try it, and it recovers on its own once it responds.",
      };
    case "needs-sign-in":
      return {
        label: "Needs sign-in",
        variant: "error",
        hint: "This server wants a sign-in, which is not supported yet. Agents do not receive it.",
      };
  }
}

export interface PresetGroups {
  /** Presets that can connect today. */
  readonly available: ReadonlyArray<McpConnectorPreset>;
  /** Presets that need a sign-in this build cannot complete. */
  readonly needsSignIn: ReadonlyArray<McpConnectorPreset>;
}

const comparableUrl = (url: string): string => {
  const normalized = normalizeMcpConnectorUrl(url);
  return normalized.ok ? normalized.url : url;
};

/**
 * Splits the catalog into what works now and what waits on sign-in, hiding
 * whatever is already connected so a row never appears twice.
 */
export function groupPresets(
  presets: ReadonlyArray<McpConnectorPreset>,
  connectors: ReadonlyArray<McpConnector>,
): PresetGroups {
  const connectedPresetIds = new Set(connectors.flatMap((c) => (c.presetId ? [c.presetId] : [])));
  const connectedUrls = new Set(connectors.map((c) => comparableUrl(c.url)));
  const open = presets.filter(
    (preset) =>
      !connectedPresetIds.has(preset.presetId) && !connectedUrls.has(comparableUrl(preset.url)),
  );
  return {
    available: open.filter((preset) => preset.auth === "none"),
    needsSignIn: open.filter((preset) => preset.auth !== "none"),
  };
}

/** Host plus path, without scheme or a lone trailing slash. */
export function connectorDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

const URL_DRAFT_MESSAGES = {
  empty: null,
  "too-long": "That URL is too long.",
  "not-a-url": "Enter a full URL, like https://mcp.example.com/mcp.",
  "unsupported-scheme":
    "Use an https:// URL. Plain http:// works only for servers on this machine.",
  "credentials-not-allowed": "Remove the username and password from the URL.",
  "missing-hostname": "That URL has no host.",
} as const;

export type CustomUrlCheck =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "valid"; readonly url: string };

/** Instant feedback before a round trip; the server re-validates everything. */
export function checkCustomUrl(draft: string): CustomUrlCheck {
  const normalized = normalizeMcpConnectorUrl(draft);
  if (normalized.ok) return { kind: "valid", url: normalized.url };
  const message = URL_DRAFT_MESSAGES[normalized.error];
  return message === null ? { kind: "empty" } : { kind: "invalid", message };
}

/** The sentence to show for a failed connect, whatever the failure's shape. */
export function connectFailureMessage(failure: unknown): string {
  if (isMcpConnectorError(failure)) return failure.message;
  if (failure instanceof Error && failure.message.trim().length > 0) return failure.message;
  return "Could not connect. Try again.";
}

/** Names the providers that receive connectors, e.g. "Claude, Codex and Muse". */
export function describeConnectorProviders(
  labels: Readonly<Record<string, string>> = MCP_CONNECTOR_PROVIDER_LABELS,
): string {
  const names = Object.values(labels);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Re-read while the server is still checking statuses; stop once it settles. */
export function shouldPollConnectors(data: McpConnectorsListResult | null): boolean {
  return data?.checking === true;
}

export const CONNECTOR_POLL_INTERVAL_MS = 2_000;
