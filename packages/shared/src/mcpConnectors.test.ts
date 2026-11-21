import { assert, describe, it } from "@effect/vitest";

import {
  MCP_CONNECTOR_PRESETS,
  MCP_CONNECTOR_PROVIDER_LABELS,
  mcpConnectorServerName,
  mcpConnectorSlug,
  normalizeMcpConnectorUrl,
} from "./mcpConnectors.ts";

describe("MCP connector presets", () => {
  it("has unique ids, names, and https endpoints that normalize to themselves", () => {
    const ids = MCP_CONNECTOR_PRESETS.map((preset) => preset.presetId);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.strictEqual(new Set(MCP_CONNECTOR_PRESETS.map((preset) => preset.url)).size, ids.length);
    for (const preset of MCP_CONNECTOR_PRESETS) {
      const normalized = normalizeMcpConnectorUrl(preset.url);
      assert.isTrue(normalized.ok, preset.presetId);
      if (normalized.ok) assert.strictEqual(new URL(normalized.url).protocol, "https:");
    }
  });

  it("does not ship endpoints that are documentation pages or unverified", () => {
    const urls = MCP_CONNECTOR_PRESETS.map((preset) => preset.url);
    assert.notInclude(urls, "https://developers.cloudflare.com/mcp/server");
    assert.notInclude(urls, "https://mcp.clickhouse.com/mcp");
    assert.isFalse(MCP_CONNECTOR_PRESETS.some((preset) => preset.presetId === "stripe-developer"));
  });

  it("names the providers that receive connectors", () => {
    assert.deepEqual(Object.keys(MCP_CONNECTOR_PROVIDER_LABELS), [
      "claude",
      "codex",
      "cursor",
      "opencode",
      "muse",
    ]);
  });
});

describe("normalizeMcpConnectorUrl", () => {
  it("rejects credentials, non-loopback http, and other schemes", () => {
    assert.deepEqual(normalizeMcpConnectorUrl("https://user:pw@example.com/mcp"), {
      ok: false,
      error: "credentials-not-allowed",
    });
    assert.deepEqual(normalizeMcpConnectorUrl("http://example.com/mcp"), {
      ok: false,
      error: "unsupported-scheme",
    });
    assert.deepEqual(normalizeMcpConnectorUrl("ftp://example.com"), {
      ok: false,
      error: "unsupported-scheme",
    });
    assert.deepEqual(normalizeMcpConnectorUrl("   "), { ok: false, error: "empty" });
  });

  it("allows loopback http and drops the fragment", () => {
    const result = normalizeMcpConnectorUrl("http://127.0.0.1:8787/mcp#frag");
    assert.isTrue(result.ok);
    if (result.ok) assert.strictEqual(result.url, "http://127.0.0.1:8787/mcp");
  });
});

describe("mcpConnectorServerName", () => {
  it("keeps names provider-safe and within the tool-name budget", () => {
    const name = mcpConnectorServerName("My Server! With A Very Long Display Name Indeed");
    assert.match(name, /^[a-z0-9_]+_connector$/);
    assert.isAtMost(name.length, 30);
  });

  it("never truncates a collision suffix away", () => {
    const long = "A very long connector display name that keeps going";
    assert.notStrictEqual(mcpConnectorServerName(long), mcpConnectorServerName(long, "ab12"));
    assert.isTrue(mcpConnectorServerName(long, "ab12").endsWith("_ab12_connector"));
  });

  it("falls back for names with no usable characters", () => {
    assert.strictEqual(mcpConnectorSlug("!!!"), "connector");
  });
});
