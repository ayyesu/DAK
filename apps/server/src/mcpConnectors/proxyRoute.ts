import type { McpConnectorError } from "@dak/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpConnectors from "./McpConnectors.ts";
import { MCP_CONNECTOR_MAX_REQUEST_BYTES, providerForwardHeaders } from "./proxy.ts";

/** Providers address connectors through this route; see injection.connectorMcpServers. */
const MCP_CONNECTORS_ROUTE_PREFIX = "/mcp/connectors";

const textResponse = (status: number, body: string, headers?: Readonly<Record<string, string>>) =>
  HttpServerResponse.text(body, { status, ...(headers === undefined ? {} : { headers }) });

/** Accepts one connector segment and nothing else; ids are `[a-z0-9_]+-[0-9a-f]{12}`. */
const connectorIdFromPathname = (pathname: string): string | undefined => {
  const rest = pathname.slice(MCP_CONNECTORS_ROUTE_PREFIX.length);
  if (!rest.startsWith("/") || rest.includes("/", 1)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest.slice(1));
  } catch {
    return undefined;
  }
  return /^[a-z0-9_-]+$/u.test(decoded) ? decoded : undefined;
};

/** Streamable HTTP wants 202 for a bare 200 with no body (notifications). */
const emptyToAccepted = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0);
  return bodyIsEmpty && response.status === 200
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

/**
 * Thread-scoped bearer auth only, exactly like `/mcp`: DAK's credential opens
 * the proxy while the connector's own credential stays in the environment.
 * The provider's original Authorization header never reaches upstream.
 */
export const layer = HttpRouter.add("*", `${MCP_CONNECTORS_ROUTE_PREFIX}/*`, (request) =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const mcpConnectors = yield* McpConnectors.McpConnectors;

    const authorization = request.headers.authorization;
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length).trim()
        : "";
    if ((yield* registry.resolve(token)) === undefined) {
      return textResponse(401, "Unauthorized");
    }

    const method = request.method;
    if (method !== "POST" && method !== "DELETE") {
      return textResponse(405, "Method Not Allowed", { allow: "POST, DELETE" });
    }

    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return textResponse(400, "Bad Request");
    const connectorId = connectorIdFromPathname(url.value.pathname);
    if (connectorId === undefined) return textResponse(404, "Not Found");

    const body =
      method === "POST"
        ? yield* request.arrayBuffer.pipe(
            Effect.map((buffer) => new Uint8Array(buffer)),
            Effect.provideService(
              HttpIncomingMessage.MaxBodySize,
              ByteSize.bytes(MCP_CONNECTOR_MAX_REQUEST_BYTES),
            ),
            Effect.option,
          )
        : Option.none<Uint8Array>();
    if (Option.isNone(body)) {
      return textResponse(413, "Request body too large or unreadable");
    }

    const outcome = yield* mcpConnectors
      .forward({
        connectorId,
        method,
        headers: providerForwardHeaders(request.headers),
        ...(body.value.byteLength > 0 ? { body: body.value } : {}),
      })
      .pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catch((error: McpConnectorError) => Effect.succeed({ ok: false as const, error })),
      );

    if (!outcome.ok) {
      // Only failure is an unknown connector; a server fault dies loudly above.
      return textResponse(404, "Not Found");
    }
    switch (outcome.result.kind) {
      case "pass":
        return emptyToAccepted(
          HttpServerResponse.uint8Array(outcome.result.body, {
            status: outcome.result.status,
            headers: outcome.result.headers,
          }),
        );
      case "json-error": {
        // A notification has no id and expects no reply; a JSON-RPC error body
        // for it would be an answer to nothing.
        if (outcome.result.id === undefined) return textResponse(202, "");
        return HttpServerResponse.jsonUnsafe(
          {
            jsonrpc: "2.0",
            id: outcome.result.id ?? null,
            error: { code: outcome.result.code, message: outcome.result.message },
          },
          { status: 200 },
        );
      }
    }
  }),
);
