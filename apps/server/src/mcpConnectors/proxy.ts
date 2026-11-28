import {
  MCP_CONNECTOR_CONNECT_TIMEOUT_MS,
  MCP_CONNECTOR_FORWARD_TIMEOUT_MS,
  MCP_CONNECTOR_HANDSHAKE_TIMEOUT_MS,
} from "@dak/shared/mcpConnectors";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import { outboundFetch, OutboundBlockedError, type OutboundBlockedReason } from "./outbound.ts";

/** Largest provider request this proxy will read before refusing it. */
export const MCP_CONNECTOR_MAX_REQUEST_BYTES = 1024 * 1024;
/** Largest upstream response this proxy will buffer; SSE included. */
const MCP_CONNECTOR_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Request headers a provider may send through to the connector's server. */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
] as const;

/** Response headers returned to the provider; everything else stays ours. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
] as const;

const MCP_ACCEPT = "application/json, text/event-stream";

const PROBE_PROTOCOL_VERSION = "2025-06-18";

const textDecoder = new TextDecoder();
const utf8 = (bytes: Uint8Array): string => textDecoder.decode(bytes);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type ForwardOutcome =
  | {
      readonly kind: "pass";
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    }
  /** The upstream demands credentials this environment does not hold yet. */
  | { readonly kind: "auth-required" }
  /** The request never produced an answer worth passing through. */
  | { readonly kind: "blocked"; readonly error: OutboundBlockedError };

export interface ForwardRequest {
  /** Normalized connector URL. */
  readonly url: string;
  readonly method: "POST" | "DELETE";
  /** Already-whitelisted provider headers; DAK's own credential is never among them. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

const pickHeaders = (
  source: Readonly<Record<string, string>>,
  names: readonly string[],
): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
};

const isToolCall = (message: unknown): boolean =>
  isRecord(message) && message.method === "tools/call";

/**
 * Only a tool call may run for minutes. Every other exchange is a handshake or
 * a listing, so a dead host fails a provider's startup in seconds.
 */
const forwardTimeoutMs = (body: Uint8Array | undefined): number => {
  if (body === undefined) return MCP_CONNECTOR_HANDSHAKE_TIMEOUT_MS;
  try {
    const parsed: unknown = JSON.parse(utf8(body));
    const longRunning = Array.isArray(parsed) ? parsed.some(isToolCall) : isToolCall(parsed);
    return longRunning ? MCP_CONNECTOR_FORWARD_TIMEOUT_MS : MCP_CONNECTOR_HANDSHAKE_TIMEOUT_MS;
  } catch {
    return MCP_CONNECTOR_HANDSHAKE_TIMEOUT_MS;
  }
};

/**
 * Forwards one provider JSON-RPC exchange. Response bodies pass through with
 * their original content type, so a provider that speaks SSE still speaks SSE;
 * only auth and transport failures are rewritten.
 */
export const forward: (
  request: ForwardRequest,
) => Effect.Effect<ForwardOutcome, never, HttpClient.HttpClient> = Effect.fn(
  "mcpConnectors.forward",
)(function* (request: ForwardRequest) {
  const outcome = yield* outboundFetch({
    url: request.url,
    method: request.method,
    headers: { accept: MCP_ACCEPT, ...pickHeaders(request.headers, FORWARDED_REQUEST_HEADERS) },
    ...(request.body === undefined ? {} : { body: request.body }),
    timeoutMs: forwardTimeoutMs(request.body),
    maxResponseBytes: MCP_CONNECTOR_MAX_RESPONSE_BYTES,
  }).pipe(
    Effect.map((response) => ({ ok: true as const, response })),
    Effect.catch((error) =>
      Effect.succeed({
        ok: false as const,
        error:
          error instanceof OutboundBlockedError
            ? error
            : new OutboundBlockedError({ reason: "network" }),
      }),
    ),
  );
  if (!outcome.ok) return { kind: "blocked", error: outcome.error } as const;
  const response = outcome.response;
  // Only 401 means the credential is missing or expired. A 403 on a forwarded
  // call is usually that one tool being off limits; it passes through to the
  // provider instead of marking the whole connector signed out.
  if (response.status === 401) return { kind: "auth-required" } as const;
  return {
    kind: "pass",
    status: response.status,
    headers: pickHeaders(response.headers, FORWARDED_RESPONSE_HEADERS),
    body: response.body,
  } as const;
});

/** Whitelists the provider's headers for a forward; the bearer stays behind. */
export const providerForwardHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const source: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) source[name.toLowerCase()] = value;
  }
  return pickHeaders(source, FORWARDED_REQUEST_HEADERS);
};

export type ProbeOutcome =
  | { readonly kind: "open" }
  | { readonly kind: "needs-sign-in" }
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "invalid"; readonly detail: string };

const probeErrorDetail = (error: OutboundBlockedError): string => {
  switch (error.reason) {
    case "timeout":
      return "timed out";
    case "local-address":
      return "the address is on a local network";
    case "redirect":
      return "the server redirected the request";
    case "invalid-url":
      return error.detail ?? "the URL is not usable";
    case "response-too-large":
      return "the response was too large";
    case "network":
      return error.detail ?? "could not connect";
  }
};

/** Every JSON-RPC message an SSE body carried, in arrival order. */
const parseSseData = (body: Uint8Array): unknown[] => {
  const messages: unknown[] = [];
  for (const rawEvent of utf8(body).split(/\r?\n\r?\n/u)) {
    const data = rawEvent
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data.length === 0) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // A keep-alive or comment frame; not an answer.
    }
  }
  return messages;
};

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROBE_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "dak", version: "1.0.0" },
  },
});

const initializeSucceeded = (status: number, contentType: string, body: Uint8Array): boolean => {
  if (status < 200 || status >= 300) return false;
  if (contentType.includes("text/event-stream")) {
    return parseSseData(body).some(
      (message) => isRecord(message) && message.id === 1 && isRecord(message.result),
    );
  }
  try {
    const parsed: unknown = JSON.parse(utf8(body));
    return isRecord(parsed) && parsed.id === 1 && isRecord(parsed.result);
  } catch {
    return false;
  }
};

/**
 * One `initialize` round trip: does this URL speak MCP, does it demand a
 * sign-in this environment cannot perform yet, or is it simply not there.
 */
export const probe: (url: string) => Effect.Effect<ProbeOutcome, never, HttpClient.HttpClient> =
  Effect.fn("mcpConnectors.probe")(function* (url: string) {
    const outcome = yield* outboundFetch({
      url,
      method: "POST",
      headers: { accept: MCP_ACCEPT, "content-type": "application/json" },
      body: new TextEncoder().encode(initializeBody),
      timeoutMs: MCP_CONNECTOR_CONNECT_TIMEOUT_MS,
      maxResponseBytes: MCP_CONNECTOR_MAX_RESPONSE_BYTES,
    }).pipe(
      Effect.map((response) => ({ ok: true as const, response })),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false as const,
          error:
            error instanceof OutboundBlockedError
              ? error
              : new OutboundBlockedError({ reason: "network" }),
        }),
      ),
    );
    if (!outcome.ok) {
      return { kind: "unreachable", detail: probeErrorDetail(outcome.error) } as const;
    }
    const response = outcome.response;
    if (response.status === 401 || response.status === 403)
      return { kind: "needs-sign-in" } as const;
    const contentType = response.headers["content-type"] ?? "";
    if (response.status < 200 || response.status >= 300) {
      return { kind: "unreachable", detail: `HTTP ${response.status}` } as const;
    }
    if (!initializeSucceeded(response.status, contentType, response.body)) {
      if (contentType.includes("text/event-stream") || contentType.includes("application/json")) {
        const detail = initializeErrorDetail(response.body, contentType);
        return detail === undefined
          ? ({ kind: "invalid", detail: "the answer was not an initialize result" } as const)
          : ({ kind: "invalid", detail } as const);
      }
      return {
        kind: "invalid",
        detail: `unexpected content type (${contentType || "none"})`,
      } as const;
    }
    // Ending the probe session keeps a well-behaved server from holding one open
    // per health check; a server that never assigned a session ignores this.
    const sessionId = response.headers["mcp-session-id"];
    if (sessionId !== undefined) {
      yield* outboundFetch({
        url,
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
        timeoutMs: MCP_CONNECTOR_CONNECT_TIMEOUT_MS,
        maxResponseBytes: MCP_CONNECTOR_MAX_RESPONSE_BYTES,
      }).pipe(Effect.ignore);
    }
    return { kind: "open" } as const;
  });

const initializeErrorDetail = (body: Uint8Array, contentType: string): string | undefined => {
  const message = (value: unknown): string | undefined =>
    isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
      ? value.error.message
      : undefined;
  if (contentType.includes("text/event-stream")) {
    for (const candidate of parseSseData(body)) {
      const detail = message(candidate);
      if (detail !== undefined) return detail;
    }
    return undefined;
  }
  try {
    return message(JSON.parse(utf8(body)));
  } catch {
    return undefined;
  }
};

/** JSON-RPC error code families this proxy invents; providers surface the message. */
export const connectorProxyErrorCode = (reason: OutboundBlockedReason | "sign-in"): number => {
  switch (reason) {
    case "sign-in":
      return -32001;
    case "timeout":
    case "network":
      return -32002;
    case "invalid-url":
    case "local-address":
    case "redirect":
      return -32003;
    case "response-too-large":
      return -32004;
  }
};

/** The `id` of a provider JSON-RPC request, or undefined when none applies. */
export const jsonRpcRequestId = (body: Uint8Array | undefined): unknown => {
  if (body === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(utf8(body));
    return isRecord(parsed) && "id" in parsed ? parsed.id : undefined;
  } catch {
    return undefined;
  }
};
