import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** How a connector authenticates to its server. `oauth` sign-in arrives with the OAuth phase. */
export const McpConnectorAuthKind = Schema.Literals(["none", "oauth"]);
export type McpConnectorAuthKind = typeof McpConnectorAuthKind.Type;

/** A curated catalog entry the settings UI offers alongside a custom URL. */
export const McpConnectorPreset = Schema.Struct({
  presetId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Default endpoint URL; still probed before anything is saved. */
  url: TrimmedNonEmptyString,
  auth: McpConnectorAuthKind,
});
export type McpConnectorPreset = typeof McpConnectorPreset.Type;

/**
 * Outbound connectors always speak streamable HTTP through the environment's
 * own proxy route; `local-http` is reserved for loopback servers.
 */
export const McpConnectorTransport = Schema.Literals(["remote-http", "local-http"]);
export type McpConnectorTransport = typeof McpConnectorTransport.Type;

export const McpConnectorStatus = Schema.Literals(["connected", "unreachable", "needs-sign-in"]);
export type McpConnectorStatus = typeof McpConnectorStatus.Type;

/** A saved connector as clients see it. Credentials never cross this boundary. */
export const McpConnector = Schema.Struct({
  connectorId: TrimmedNonEmptyString,
  presetId: Schema.NullOr(TrimmedNonEmptyString),
  /** Display name; may differ from the preset it was created from. */
  name: TrimmedNonEmptyString,
  /**
   * The server name providers register it under, suffixed with `_connector`
   * so a config deep-merge cannot collide it with a provider's own server.
   */
  serverName: TrimmedNonEmptyString,
  transport: McpConnectorTransport,
  /** Full stored URL. Credentials are rejected at save time, so this is safe to show. */
  url: TrimmedNonEmptyString,
  /** URL origin only, for logs and UI grouping. */
  origin: TrimmedNonEmptyString,
  auth: McpConnectorAuthKind,
  status: McpConnectorStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type McpConnector = typeof McpConnector.Type;

export const McpConnectorsListInput = Schema.Struct({});

export const McpConnectorsListResult = Schema.Struct({
  connectors: Schema.Array(McpConnector),
  presets: Schema.Array(McpConnectorPreset),
  /** How many more connectors may be added before the limit. */
  remaining: Schema.Number,
});
export type McpConnectorsListResult = typeof McpConnectorsListResult.Type;

/** Connect by catalog preset, by explicit URL, or both (preset id for provenance). */
export const McpConnectorConnectInput = Schema.Struct({
  presetId: Schema.optional(TrimmedNonEmptyString),
  url: Schema.optional(TrimmedNonEmptyString),
  name: Schema.optional(TrimmedNonEmptyString),
});
export type McpConnectorConnectInput = typeof McpConnectorConnectInput.Type;

export const McpConnectorConnectResult = Schema.Struct({
  connector: McpConnector,
  /** Set once sign-in exists: the browser URL the user must visit before the connector can save. */
  authorizationUrl: Schema.optional(TrimmedNonEmptyString),
});
export type McpConnectorConnectResult = typeof McpConnectorConnectResult.Type;

export const McpConnectorDisconnectInput = Schema.Struct({
  connectorId: TrimmedNonEmptyString,
});
export type McpConnectorDisconnectInput = typeof McpConnectorDisconnectInput.Type;

export const McpConnectorDisconnectResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type McpConnectorDisconnectResult = typeof McpConnectorDisconnectResult.Type;

export const McpConnectorErrorReason = Schema.Literals([
  "invalid-input",
  "invalid-url",
  "duplicate",
  "limit",
  "unreachable",
  "sign-in-required",
  "not-found",
  "probe-failed",
]);
export type McpConnectorErrorReason = typeof McpConnectorErrorReason.Type;

export class McpConnectorError extends Schema.TaggedError<McpConnectorError>()(
  "McpConnectorError",
  {
    reason: McpConnectorErrorReason,
    /** Extra detail beyond the reason's default sentence, e.g. a URL error code. */
    detail: Schema.optional(Schema.String),
    connectorId: Schema.optional(TrimmedNonEmptyString),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-input":
        return "A preset id or URL is required.";
      case "invalid-url":
        return this.detail === undefined
          ? "That URL cannot be used as an MCP server."
          : `That URL cannot be used as an MCP server: ${this.detail}.`;
      case "duplicate":
        return "That server is already connected.";
      case "limit":
        return "This environment already has the maximum number of connectors.";
      case "unreachable":
        return this.detail === undefined
          ? "The MCP server could not be reached."
          : `The MCP server could not be reached: ${this.detail}.`;
      case "sign-in-required":
        return this.detail === undefined
          ? "This MCP server requires a sign-in that is not available yet."
          : `${this.detail}`;
      case "not-found":
        return "That connector no longer exists.";
      case "probe-failed":
        return "The MCP server answered in a way this environment could not understand.";
    }
  }
}
