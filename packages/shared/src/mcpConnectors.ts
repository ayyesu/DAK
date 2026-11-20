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
 * Curated catalog. Every entry is still probed before it saves: the marks say
 * which sign-in model the server uses, not that it will answer.
 */
export const MCP_CONNECTOR_PRESETS: ReadonlyArray<McpConnectorPreset> = [
  { presetId: "supabase", name: "Supabase", url: "https://mcp.supabase.com/mcp", auth: "oauth" },
  { presetId: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", auth: "none" },
  { presetId: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
  {
    presetId: "clickhouse",
    name: "ClickHouse",
    url: "https://mcp.clickhouse.com/mcp",
    auth: "none",
  },
  { presetId: "stripe", name: "Stripe", url: "https://mcp.stripe.com", auth: "oauth" },
  {
    presetId: "cloudflare",
    name: "Cloudflare",
    url: "https://developers.cloudflare.com/mcp/server",
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
    presetId: "sentry-developer",
    name: "Sentry Developer",
    url: "https://mcp.sentry.dev/mcp/developer",
    auth: "oauth",
  },
  {
    presetId: "atlassian",
    name: "Atlassian",
    url: "https://mcp.atlassian.com/v1/mcp",
    auth: "oauth",
  },
  { presetId: "neon", name: "Neon", url: "https://mcp.neon.tech/mcp", auth: "oauth" },
  {
    presetId: "firebase-studio",
    name: "Firebase Studio",
    url: "https://studio-mcp-server.firebaseapp.com/mcp",
    auth: "oauth",
  },
  { presetId: "n8n", name: "n8n", url: "https://mcp.n8n.io/mcp", auth: "oauth" },
  {
    presetId: "stripe-developer",
    name: "Stripe Developer",
    url: "https://mcp.stripe.com/developer",
    auth: "none",
  },
];

/** Providers whose adapters inject connector servers into their sessions. */
export const MCP_CONNECTOR_PROVIDERS = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "opencode2",
  "muse",
  "acp",
] as const;
export type McpConnectorProvider = (typeof MCP_CONNECTOR_PROVIDERS)[number];

export const mcpConnectorProviderSupports = (
  provider: string,
): provider is McpConnectorProvider =>
  (MCP_CONNECTOR_PROVIDERS as readonly string[]).includes(provider);

export const MCP_CONNECTOR_URL_MAX_LENGTH = 2_048;

export type McpConnectorUrlError =
  | "empty"
  | "too-long"
  | "not-a-url"
  | "unsupported-scheme"
  | "credentials-not-allowed"
  | "missing-hostname";

export type NormalizeMcpConnectorUrlResult =
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
  if (trimmed.length > MCP_CONNECTOR_URL_MAX_LENGTH)
    return { ok: false, error: "too-long" };
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

const SERVER_NAME_MAX_SLUG_LENGTH = 52;

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

/** The exact name providers register, unique across connectors by construction. */
export function mcpConnectorServerName(slug: string): string {
  return `${mcpConnectorSlug(slug)}_connector`;
}

/** Slug source for a URL: host without the TLD noise, falling back to the path. */
export function mcpConnectorSlugFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replaceAll(/^www\./u, "");
    return mcpConnectorSlug(host.split(".")[0] ?? host);
  } catch {
    return "connector";
  }
}
