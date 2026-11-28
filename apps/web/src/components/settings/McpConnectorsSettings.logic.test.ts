import { McpConnectorError, type McpConnector, type McpConnectorPreset } from "@dak/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkCustomUrl,
  connectFailureMessage,
  connectorDisplayUrl,
  connectorStatusPresentation,
  describeConnectorProviders,
  groupPresets,
  shouldPollConnectors,
} from "./McpConnectorsSettings.logic";

const preset = (presetId: string, auth: "none" | "oauth", url = `https://${presetId}.test/mcp`) =>
  ({ presetId, name: presetId, url, auth }) as McpConnectorPreset;

const connector = (overrides: Partial<McpConnector>): McpConnector => ({
  connectorId: "c-1",
  presetId: null,
  name: "C",
  serverName: "c_connector",
  transport: "remote-http",
  url: "https://c.test/mcp",
  origin: "https://c.test",
  auth: "none",
  status: "connected",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("groupPresets", () => {
  const presets = [preset("a", "none"), preset("b", "oauth"), preset("c", "oauth")];

  it("separates connectable presets from those that need sign-in", () => {
    const groups = groupPresets(presets, []);
    expect(groups.available.map((p) => p.presetId)).toEqual(["a"]);
    expect(groups.needsSignIn.map((p) => p.presetId)).toEqual(["b", "c"]);
  });

  it("hides a preset that is already connected, by id or by URL", () => {
    const byId = groupPresets(presets, [connector({ presetId: "a" })]);
    expect(byId.available).toEqual([]);
    const byUrl = groupPresets(presets, [connector({ url: "https://b.test/mcp" })]);
    expect(byUrl.needsSignIn.map((p) => p.presetId)).toEqual(["c"]);
  });
});

describe("checkCustomUrl", () => {
  it("stays quiet while the field is empty", () => {
    expect(checkCustomUrl("  ")).toEqual({ kind: "empty" });
  });

  it("explains each rejection in plain language", () => {
    expect(checkCustomUrl("mcp.example.com")).toMatchObject({ kind: "invalid" });
    expect(checkCustomUrl("http://example.com/mcp")).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("https://"),
    });
    expect(checkCustomUrl("https://u:p@example.com")).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("username"),
    });
  });

  it("accepts https and loopback http", () => {
    expect(checkCustomUrl("https://mcp.example.com/mcp")).toMatchObject({ kind: "valid" });
    expect(checkCustomUrl("http://localhost:8787/mcp")).toMatchObject({ kind: "valid" });
  });
});

describe("presentation helpers", () => {
  it("labels every status and explains the ones that need action", () => {
    expect(connectorStatusPresentation("connected").hint).toBeNull();
    expect(connectorStatusPresentation("unreachable").variant).toBe("warning");
    expect(connectorStatusPresentation("needs-sign-in").hint).toContain("not supported yet");
  });

  it("shows host and path without scheme", () => {
    expect(connectorDisplayUrl("https://mcp.example.com/")).toBe("mcp.example.com");
    expect(connectorDisplayUrl("https://mcp.example.com/v1/mcp")).toBe("mcp.example.com/v1/mcp");
  });

  it("prefers the server's own message for a failed connect", () => {
    expect(connectFailureMessage(new McpConnectorError({ reason: "limit" }))).toContain("maximum");
    expect(connectFailureMessage("boom")).toBe("Could not connect. Try again.");
  });

  it("names providers in a sentence", () => {
    expect(describeConnectorProviders({ a: "Claude", b: "Codex", c: "Muse" })).toBe(
      "Claude, Codex and Muse",
    );
    expect(describeConnectorProviders({ a: "Claude" })).toBe("Claude");
  });

  it("polls only while the server reports a health pass in flight", () => {
    expect(shouldPollConnectors(null)).toBe(false);
    expect(
      shouldPollConnectors({ connectors: [], presets: [], remaining: 30, checking: true }),
    ).toBe(true);
    expect(
      shouldPollConnectors({ connectors: [], presets: [], remaining: 30, checking: false }),
    ).toBe(false);
  });
});
