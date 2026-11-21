import { McpConnectorError } from "@dak/contracts";
import type {
  McpConnector,
  McpConnectorConnectInput,
  McpConnectorConnectResult,
  McpConnectorDisconnectInput,
  McpConnectorDisconnectResult,
  McpConnectorStatus,
  McpConnectorsListResult,
} from "@dak/contracts";
import {
  MCP_CONNECTOR_MAX_COUNT,
  MCP_CONNECTOR_PRESETS,
  MCP_CONNECTOR_REFRESH_LEEWAY_MS,
  mcpConnectorLoopbackHostname,
  mcpConnectorServerName,
  mcpConnectorSlug,
  normalizeMcpConnectorUrl,
} from "@dak/shared/mcpConnectors";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { OutboundBlockedReason } from "./outbound.ts";
import * as injection from "./injection.ts";
import * as proxy from "./proxy.ts";

/** Secret-store slot holding the whole connector document. */
const STORE_NAME = "mcp-connectors";

/**
 * Longest `list` waits for a health pass. A dead host can take the full probe
 * timeout, and a settings page must not hang on it: slower probes finish in the
 * background and the result says `checking` until they do.
 */
const LIST_REFRESH_WAIT = "3 seconds";

interface ConnectorsState {
  readonly connectors: readonly McpConnector[];
  /** When statuses were last probed; 0 forces one probe on first read. */
  readonly lastProbeAt: number;
}

export interface ConnectorForwardInput {
  readonly connectorId: string;
  readonly method: "POST" | "DELETE";
  /** Whitelisted provider headers; the route strips everything else. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export type ConnectorForwardResult =
  | {
      readonly kind: "pass";
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    }
  /** A JSON-RPC error the provider should see instead of an HTTP failure. */
  | {
      readonly kind: "json-error";
      readonly id: unknown;
      readonly code: number;
      readonly message: string;
    };

export interface McpConnectorsShape {
  readonly list: Effect.Effect<McpConnectorsListResult>;
  readonly connect: (
    input: McpConnectorConnectInput,
  ) => Effect.Effect<McpConnectorConnectResult, McpConnectorError>;
  readonly disconnect: (
    input: McpConnectorDisconnectInput,
  ) => Effect.Effect<McpConnectorDisconnectResult, McpConnectorError>;
  readonly forward: (
    input: ConnectorForwardInput,
  ) => Effect.Effect<ConnectorForwardResult, McpConnectorError>;
}

export class McpConnectors extends Context.Service<McpConnectors, McpConnectorsShape>()(
  "dak/mcpConnectors/McpConnectors",
) {}

const isStoredConnector = (value: unknown): value is McpConnector => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.connectorId === "string" &&
    candidate.connectorId.length > 0 &&
    (candidate.presetId === null || typeof candidate.presetId === "string") &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.serverName === "string" &&
    candidate.serverName.length > 0 &&
    (candidate.transport === "remote-http" || candidate.transport === "local-http") &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0 &&
    typeof candidate.origin === "string" &&
    candidate.origin.length > 0 &&
    (candidate.auth === "none" || candidate.auth === "oauth") &&
    (candidate.status === "connected" ||
      candidate.status === "unreachable" ||
      candidate.status === "needs-sign-in") &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
};

/**
 * Reads only what this build understands. An entry written by a newer server
 * that fails validation is dropped rather than persisted back malformed; a
 * wholly unreadable document starts empty instead of failing startup.
 */
const decodeDocument = (bytes: Uint8Array): readonly McpConnector[] => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return [];
    const connectors = (parsed as { connectors?: unknown }).connectors;
    if (!Array.isArray(connectors)) return [];
    return connectors.filter(isStoredConnector);
  } catch {
    return [];
  }
};

const encodeDocument = (connectors: readonly McpConnector[]): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ version: 1, connectors }));

const probeStatus = (outcome: proxy.ProbeOutcome): McpConnectorStatus =>
  outcome.kind === "open"
    ? "connected"
    : outcome.kind === "needs-sign-in"
      ? "needs-sign-in"
      : "unreachable";

const displayNameFor = (
  input: McpConnectorConnectInput,
  presetName: string | undefined,
  url: string,
): string => {
  const trimmed = input.name?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  if (presetName !== undefined && presetName.length > 0) return presetName;
  try {
    return new URL(url).hostname;
  } catch {
    return "MCP server";
  }
};

/**
 * Connectors a provider session should be wired to. An unreachable server stays
 * in: the outage may be brief, and the next proxied call that succeeds marks it
 * connected again, whereas dropping it would hold it out of every new session
 * until someone opened settings. Only a connector that needs a sign-in is held
 * back, because nothing the provider does can fix that.
 */
function injectionEntries(connectors: readonly McpConnector[]): injection.ConnectedConnector[] {
  return connectors
    .filter((connector) => connector.status !== "needs-sign-in")
    .map((connector) => ({
      connectorId: connector.connectorId,
      serverName: connector.serverName,
    }));
}

function blockedMessage(
  name: string,
  reason: OutboundBlockedReason,
  detail: string | undefined,
): string {
  switch (reason) {
    case "timeout":
      return `${name} did not answer within the time limit.`;
    case "network":
      return detail === undefined
        ? `${name} could not be reached.`
        : `${name} could not be reached: ${detail}.`;
    case "local-address":
    case "redirect":
    case "invalid-url":
      return `${name}'s server address was refused.`;
    case "response-too-large":
      return `${name}'s response was too large.`;
  }
}
export const make: Effect.Effect<
  McpConnectorsShape,
  never,
  ServerSecretStore.ServerSecretStore | HttpClient.HttpClient | Crypto.Crypto | Scope.Scope
> = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  // All service methods are pure bookkeeping; probes run on the shared client.
  const probe = (url: string) =>
    proxy.probe(url).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  const forwardViaClient = (input: proxy.ForwardRequest) =>
    proxy.forward(input).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const stored = yield* secrets.get(STORE_NAME).pipe(
    Effect.map(
      Option.match({ onSome: decodeDocument, onNone: () => [] as readonly McpConnector[] }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to read stored MCP connectors; starting empty", { cause }).pipe(
        Effect.as([] as readonly McpConnector[]),
      ),
    ),
  );

  const stateRef = yield* SynchronizedRef.make<ConnectorsState>({
    connectors: stored,
    lastProbeAt: 0,
  });
  const refreshInFlight = yield* Ref.make(false);
  injection.setConnectedConnectors(injectionEntries(stored));

  /** Persists under the ref's semaphore; a disk failure keeps memory authoritative. */
  const persist = (connectors: readonly McpConnector[]) =>
    secrets
      .set(STORE_NAME, encodeDocument(connectors))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to persist MCP connectors", { cause }),
        ),
      );

  /**
   * Runs a pure list transition under the ref's semaphore, persisting and
   * re-syncing injection only when the list actually changed.
   */
  const commit = <A>(
    transition: (connectors: readonly McpConnector[]) => readonly [A, readonly McpConnector[]],
  ): Effect.Effect<A> =>
    SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.gen(function* () {
        const [result, connectors] = transition(state.connectors);
        if (connectors !== state.connectors) {
          yield* persist(connectors);
          injection.setConnectedConnectors(injectionEntries(connectors));
        }
        return [result, { ...state, connectors }] as const;
      }),
    );

  const updateStatus = (connectorId: string, status: McpConnectorStatus): Effect.Effect<void> =>
    Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* commit((connectors) => {
        const index = connectors.findIndex((connector) => connector.connectorId === connectorId);
        const previous = connectors[index];
        if (index === -1 || previous === undefined || previous.status === status) {
          return [undefined, connectors] as const;
        }
        const next = [...connectors];
        next[index] = { ...previous, status, updatedAt };
        return [undefined, next as readonly McpConnector[]] as const;
      });
    });

  /**
   * One health pass over every saved connector, at most once per caller. Probe
   * results apply by id so a connect that lands mid-refresh is never lost.
   */
  const refreshIfStale = Effect.gen(function* () {
    const before = yield* SynchronizedRef.get(stateRef);
    if (before.connectors.length === 0) return;
    const nowMillis = DateTime.toEpochMillis(DateTime.toUtc(yield* DateTime.now));
    if (nowMillis - before.lastProbeAt < MCP_CONNECTOR_REFRESH_LEEWAY_MS) return;
    const claimed = yield* Ref.modify(refreshInFlight, (running): readonly [boolean, boolean] =>
      running ? [false, true] : [true, true],
    );
    if (!claimed) return;
    const applyResults = Effect.gen(function* () {
      const snapshot = (yield* SynchronizedRef.get(stateRef)).connectors;
      const statuses = new Map(
        yield* Effect.forEach(
          snapshot,
          (connector) =>
            probe(connector.url).pipe(
              Effect.map((outcome) => [connector.connectorId, probeStatus(outcome)] as const),
            ),
          { concurrency: 4 },
        ),
      );
      const probed = yield* DateTime.now;
      yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          const connectors = state.connectors.map((connector) => {
            const status = statuses.get(connector.connectorId);
            return status !== undefined && status !== connector.status
              ? { ...connector, status, updatedAt: DateTime.formatIso(probed) }
              : connector;
          });
          const changed = connectors.some(
            (connector, index) => connector !== state.connectors[index],
          );
          if (changed) {
            yield* persist(connectors);
            injection.setConnectedConnectors(injectionEntries(connectors));
          }
          return [undefined, { connectors, lastProbeAt: DateTime.toEpochMillis(probed) }] as const;
        }),
      );
    });
    yield* applyResults.pipe(
      Effect.catchCause((cause) => Effect.logWarning("MCP connector refresh failed", { cause })),
      Effect.ensuring(Ref.set(refreshInFlight, false)),
    );
  });

  const list: McpConnectorsShape["list"] = Effect.gen(function* () {
    const pass = yield* Effect.forkIn(refreshIfStale, scope);
    yield* Fiber.join(pass).pipe(Effect.timeoutOption(LIST_REFRESH_WAIT));
    const state = yield* SynchronizedRef.get(stateRef);
    return {
      connectors: [...state.connectors],
      presets: [...MCP_CONNECTOR_PRESETS],
      remaining: Math.max(0, MCP_CONNECTOR_MAX_COUNT - state.connectors.length),
      checking: yield* Ref.get(refreshInFlight),
    };
  });

  const connect: McpConnectorsShape["connect"] = (input) =>
    Effect.gen(function* () {
      const preset =
        input.presetId === undefined
          ? undefined
          : MCP_CONNECTOR_PRESETS.find((entry) => entry.presetId === input.presetId);
      if (input.presetId !== undefined && preset === undefined) {
        return yield* Effect.fail(
          new McpConnectorError({
            reason: "invalid-input",
            detail: `Unknown preset "${input.presetId}".`,
          }),
        );
      }
      const rawUrl = input.url ?? preset?.url;
      if (rawUrl === undefined || rawUrl.trim().length === 0) {
        return yield* Effect.fail(new McpConnectorError({ reason: "invalid-input" }));
      }
      const normalized = normalizeMcpConnectorUrl(rawUrl);
      if (!normalized.ok) {
        return yield* Effect.fail(
          new McpConnectorError({ reason: "invalid-url", detail: normalized.error }),
        );
      }
      const displayName = displayNameFor(input, preset?.name, normalized.url);

      // Reconnecting an existing row retries its probe rather than duplicating it.
      const existing = (yield* SynchronizedRef.get(stateRef)).connectors.find(
        (connector) => connector.url === normalized.url,
      );
      if (existing !== undefined) {
        const status = probeStatus(yield* probe(existing.url));
        yield* updateStatus(existing.connectorId, status);
        const current = (yield* SynchronizedRef.get(stateRef)).connectors.find(
          (connector) => connector.connectorId === existing.connectorId,
        );
        return { connector: current ?? { ...existing, status } };
      }

      const outcome = yield* probe(normalized.url);
      if (outcome.kind === "needs-sign-in") {
        return yield* Effect.fail(
          new McpConnectorError({
            reason: "sign-in-required",
            detail: `${displayName} requires a sign-in that this build cannot complete yet.`,
          }),
        );
      }
      if (outcome.kind === "unreachable") {
        return yield* Effect.fail(
          new McpConnectorError({ reason: "unreachable", detail: outcome.detail }),
        );
      }
      if (outcome.kind === "invalid") {
        return yield* Effect.fail(new McpConnectorError({ reason: "probe-failed" }));
      }

      const uuid = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "");
      const now = yield* DateTime.now;
      type Landed =
        | { readonly kind: "created" | "existing"; readonly connector: McpConnector }
        | { readonly kind: "limit" };
      // The duplicate and limit checks run here, under the ref's semaphore: two
      // connects of one URL can both pass the pre-check above while probing.
      const landed = yield* commit<Landed>((connectors) => {
        const duplicate = connectors.find((connector) => connector.url === normalized.url);
        if (duplicate !== undefined) {
          return [{ kind: "existing", connector: duplicate }, connectors] as const;
        }
        if (connectors.length >= MCP_CONNECTOR_MAX_COUNT) {
          return [{ kind: "limit" }, connectors] as const;
        }
        const taken = new Set(connectors.map((connector) => connector.serverName));
        const serverName =
          [
            mcpConnectorServerName(displayName),
            mcpConnectorServerName(displayName, uuid.slice(0, 4)),
            mcpConnectorServerName(displayName, uuid.slice(0, 6)),
          ].find((candidate) => !taken.has(candidate)) ?? mcpConnectorServerName(displayName, uuid);
        const connector: McpConnector = {
          connectorId: `${mcpConnectorSlug(displayName)}-${uuid.slice(0, 12)}`,
          presetId: preset?.presetId ?? null,
          name: displayName,
          serverName,
          transport: mcpConnectorLoopbackHostname(new URL(normalized.url).hostname)
            ? "local-http"
            : "remote-http",
          url: normalized.url,
          origin: normalized.origin,
          auth: preset?.auth ?? "none",
          status: "connected",
          createdAt: DateTime.formatIso(now),
          updatedAt: DateTime.formatIso(now),
        };
        return [
          { kind: "created", connector } satisfies Landed,
          [...connectors, connector] as const,
        ] as const;
      });
      if (landed.kind === "limit") {
        return yield* Effect.fail(new McpConnectorError({ reason: "limit" }));
      }
      return { connector: landed.connector };
    });

  const disconnect: McpConnectorsShape["disconnect"] = (input) =>
    commit((connectors) => {
      const next = connectors.filter((connector) => connector.connectorId !== input.connectorId);
      return [{ removed: next.length !== connectors.length }, next] as const;
    }).pipe(Effect.map((result) => ({ removed: result.removed })));

  const forward: McpConnectorsShape["forward"] = (input) =>
    Effect.gen(function* () {
      const connector = (yield* SynchronizedRef.get(stateRef)).connectors.find(
        (entry) => entry.connectorId === input.connectorId,
      );
      if (connector === undefined) {
        return yield* Effect.fail(new McpConnectorError({ reason: "not-found" }));
      }
      const outcome = yield* forwardViaClient({
        url: connector.url,
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      switch (outcome.kind) {
        case "pass": {
          // A pass proves the server is alive again after a failed attempt.
          if (connector.status !== "connected")
            yield* updateStatus(connector.connectorId, "connected");
          return outcome;
        }
        case "auth-required": {
          yield* updateStatus(connector.connectorId, "needs-sign-in");
          return {
            kind: "json-error",
            id: proxy.jsonRpcRequestId(input.body),
            code: proxy.connectorProxyErrorCode("sign-in"),
            message: `${connector.name} requires a sign-in that has not been set up yet.`,
          };
        }
        case "blocked": {
          const reason = outcome.error.reason;
          // Connection-level refusals downgrade the row; a stalled or oversized
          // answer may be the tool, not the server, so the status stands.
          if (
            reason === "network" ||
            reason === "local-address" ||
            reason === "redirect" ||
            reason === "invalid-url"
          ) {
            yield* updateStatus(connector.connectorId, "unreachable");
          }
          return {
            kind: "json-error",
            id: proxy.jsonRpcRequestId(input.body),
            code: proxy.connectorProxyErrorCode(reason),
            message: blockedMessage(connector.name, reason, outcome.error.detail),
          };
        }
      }
    });

  return { list, connect, disconnect, forward } satisfies McpConnectorsShape;
});

/**
 * The service itself is pure bookkeeping; probes run on the shared fetch
 * client, so it is provided inside the layer.
 */
export const layer: Layer.Layer<
  McpConnectors,
  never,
  ServerSecretStore.ServerSecretStore | Crypto.Crypto
> = Layer.effect(McpConnectors, make).pipe(Layer.provide(FetchHttpClient.layer));
