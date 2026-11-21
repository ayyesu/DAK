import type { McpConnectorPreset } from "@dak/contracts";

/** Hard cap on saved connectors per environment. */
export const MCP_CONNECTOR_MAX_COUNT = 30;

/** Health probes are cheap but must not run on every keystroke of a settings page. */
export const MCP_CONNECTOR_REFRESH_LEEWAY_MS = 60_000;

/** Connect probes fail fast: a dead host should not hang the settings page. */
export const MCP_CONNECTOR_CONNECT_TIMEOUT_MS = 15_000;

/** A forwarded tool call may legitimately take minutes on a slow upstream. */
export const MCP_CONNECTOR_FORWARD_TIMEOUT_MS = 300_000;

/**
 * Everything but `tools/call` (initialize, tools/list, pings, notifications)
 * is a quick exchange. A dead host must fail a provider's startup handshake in
 * seconds rather than hold a proxy request open for the tool-call limit.
 */
export const MCP_CONNECTOR_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Curated catalog. Every entry is still probed before it saves: `auth` says
 * which sign-in model the server uses, not that it will answer. Entries are
 * the vendor's documented remote endpoint; do not add one without checking
 * the vendor's own docs for the URL and its authentication.
 */
export const MCP_CONNECTOR_PRESETS: ReadonlyArray<McpConnectorPreset> = [
  { presetId: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", auth: "none" },
  { presetId: "supabase", name: "Supabase", url: "https://mcp.supabase.com/mcp", auth: "oauth" },
  { presetId: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
  {
    presetId: "clickhouse",
    name: "ClickHouse",
    url: "https://mcp.clickhouse.cloud/mcp",
    auth: "oauth",
  },
  { presetId: "stripe", name: "Stripe", url: "https://mcp.stripe.com", auth: "oauth" },
  {
    presetId: "cloudflare",
    name: "Cloudflare",
    url: "https://mcp.cloudflare.com/mcp",
    auth: "oauth",
  },
  { presetId: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth" },
  {
    presetId: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "oauth",
  },
  { presetId: "vercel", name: "Vercel", url: "https://mcp.vercel.com", auth: "oauth" },
  {
    presetId: "atlassian",
    name: "Atlassian",
    url: "https://mcp.atlassian.com/v1/mcp",
    auth: "oauth",
  },
  { presetId: "neon", name: "Neon", url: "https://mcp.neon.tech/mcp", auth: "oauth" },
];

/**
 * Providers whose adapters inject connector servers into their sessions, with
 * the names people know them by. A provider is listed only once its adapter
 * calls `connectorMcpServers`: ACP agents, Pi, Grok, Antigravity, and
 * OpenCode 2 do not receive connectors yet.
 */
export const MCP_CONNECTOR_PROVIDER_LABELS = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  muse: "Muse",
} as const;

const MCP_CONNECTOR_URL_MAX_LENGTH = 2_048;

type McpConnectorUrlError =
  | "empty"
  | "too-long"
  | "not-a-url"
  | "unsupported-scheme"
  | "credentials-not-allowed"
  | "missing-hostname";

type NormalizeMcpConnectorUrlResult =
  | { readonly ok: true; readonly url: string; readonly origin: string }
  | { readonly ok: false; readonly error: McpConnectorUrlError };

/** Loopback is the only clear-network HTTP a connector may target; everything else needs TLS. */
export function mcpConnectorLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  const ipv4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ipv4 === null) return false;
  return host
    .split(".")
    .every((part) => Number.isInteger(Number(part)) && Number(part) >= 0 && Number(part) <= 255);
}

/**
 * Canonical stored form: scheme + host + path + query, no credentials and no
 * fragment. Two inputs that normalize alike are the same connector.
 */
export function normalizeMcpConnectorUrl(input: string): NormalizeMcpConnectorUrlResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty" };
  if (trimmed.length > MCP_CONNECTOR_URL_MAX_LENGTH) return { ok: false, error: "too-long" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "not-a-url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return { ok: false, error: "unsupported-scheme" };
  if (parsed.username.length > 0 || parsed.password.length > 0)
    return { ok: false, error: "credentials-not-allowed" };
  if (parsed.hostname.length === 0) return { ok: false, error: "missing-hostname" };
  if (parsed.protocol === "http:" && !mcpConnectorLoopbackHostname(parsed.hostname))
    return { ok: false, error: "unsupported-scheme" };
  parsed.hash = "";
  const url = parsed.toString();
  return { ok: true, url, origin: parsed.origin };
}

/**
 * Providers prefix every tool with `mcp__<server>__`, and Claude caps the whole
 * tool name at 64 characters. A short slug leaves room for real tool names.
 */
const SERVER_NAME_MAX_SLUG_LENGTH = 20;

/**
 * A provider-safe server-name fragment: lowercase ASCII letters, digits, and
 * underscores. Anything else collapses into `_`, so a display name like
 * "My Server!" still yields a name every provider accepts.
 */
export function mcpConnectorSlug(source: string): string {
  const slug = source
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/_+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, SERVER_NAME_MAX_SLUG_LENGTH)
    .replaceAll(/_+$/gu, "");
  return slug.length > 0 ? slug : "connector";
}

/**
 * The exact name providers register. `disambiguator` is appended after the
 * slug is truncated, so a collision suffix can never be cut off with it.
 */
export function mcpConnectorServerName(source: string, disambiguator?: string): string {
  const suffix = disambiguator === undefined ? "" : `_${mcpConnectorSlug(disambiguator)}`;
  return `${mcpConnectorSlug(source)}${suffix}_connector`;
}
