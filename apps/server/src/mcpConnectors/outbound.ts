// @effect-diagnostics nodeBuiltinImport:off - Effect has no address block list for outbound fetch.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  MCP_CONNECTOR_CONNECT_TIMEOUT_MS,
  mcpConnectorLoopbackHostname,
  normalizeMcpConnectorUrl,
} from "@dak/shared/mcpConnectors";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export type OutboundBlockedReason =
  | "invalid-url"
  | "local-address"
  | "redirect"
  | "timeout"
  | "response-too-large"
  | "network";

/**
 * Why a connector request never reached its server, or never came back with
 * an answer this environment will pass through.
 */
export class OutboundBlockedError extends Data.TaggedError("OutboundBlockedError")<{
  readonly reason: OutboundBlockedReason;
  readonly detail?: string;
}> {}

/**
 * The local networks an outbound connector must never reach, mirroring the
 * preview browser's SOCKS policy: private, link-local, CGNAT, benchmark,
 * multicast, and the IPv6 ranges that embed an IPv4 address a translator
 * may route to without checking it.
 */
const LOCAL_ADDRESSES = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const NAT64 = new NodeNet.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new NodeNet.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

const ipv6Groups = (address: string) => {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

const embeddedIPv4 = (address: string) => {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

const ownAddresses = () => {
  const own = new NodeNet.BlockList();
  for (const entry of Object.values(NodeOS.networkInterfaces()).flat()) {
    if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
};

const isLocalAddress = (address: string, family: number): boolean => {
  const type = family === 6 ? "ipv6" : "ipv4";
  if (LOCAL_ADDRESSES.check(address, type) || ownAddresses().check(address, type)) return true;
  const embedded = family === 6 ? embeddedIPv4(address) : undefined;
  return embedded !== undefined && isLocalAddress(embedded, 4);
};

/**
 * Resolutions are remembered briefly: a settings refresh probes every saved
 * connector, and per-request lookups would multiply on a large list. The
 * window also bounds how long a name that flips its answers stays trusted.
 */
const DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map<string, { readonly at: number; readonly blocked: boolean }>();

// DNS cache entries expire after DNS_CACHE_TTL_MS.
const errorDetail = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { readonly message: unknown }).message === "string"
      ? (error as { readonly message: string }).message
      : String(error);

const blocked = (reason: OutboundBlockedReason, detail?: string) =>
  new OutboundBlockedError({ reason, ...(detail === undefined ? {} : { detail }) });

/** Fails when `url`'s host is, or resolves to, this machine or a local network. */
const assertReachable = Effect.fn("mcpConnectors.assertReachable")(function* (url: URL) {
  if (url.protocol === "http:" && mcpConnectorLoopbackHostname(url.hostname)) return;
  const literalFamily = NodeNet.isIP(url.hostname);
  if (literalFamily !== 0) {
    if (isLocalAddress(url.hostname, literalFamily)) {
      return yield* Effect.fail(blocked("local-address"));
    }
    return;
  }
  const cached = dnsCache.get(url.hostname);
  const now = yield* Clock.currentTimeMillis;
  if (cached !== undefined && now - cached.at <= DNS_CACHE_TTL_MS) {
    if (cached.blocked) return yield* Effect.fail(blocked("local-address"));
    return;
  }
  const addresses = yield* Effect.tryPromise({
    try: () => NodeDnsPromises.lookup(url.hostname, { all: true, verbatim: true }),
    catch: (error) => blocked("network", errorDetail(error)),
  });
  if (addresses.length === 0) return yield* Effect.fail(blocked("network", "no addresses"));
  const isLocal = addresses.some(({ address, family }) =>
    isLocalAddress(address, family === 6 ? 6 : 4),
  );
  dnsCache.set(url.hostname, { at: now, blocked: isLocal });
  if (isLocal) return yield* Effect.fail(blocked("local-address"));
});

const readBounded = (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
): Effect.Effect<Uint8Array, OutboundBlockedError> =>
  Effect.gen(function* () {
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return yield* Effect.fail(blocked("response-too-large"));
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    yield* response.stream.pipe(
      Stream.mapError((error) => blocked("network", errorDetail(error))),
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          total += chunk.byteLength;
          if (total > maxBytes) return Effect.fail(blocked("response-too-large"));
          chunks.push(chunk);
          return Effect.void;
        }),
      ),
    );
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  });

export interface OutboundHttpRequest {
  /** Already-normalized connector URL; re-checked here as defense in depth. */
  readonly url: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs?: number;
  /** Largest response body this call will buffer. */
  readonly maxResponseBytes: number;
}

export interface OutboundHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * One connector-bound HTTP request: normalized URL rules, a DNS check against
 * local addresses, redirects refused rather than followed, a wall-clock
 * timeout over the whole exchange, and a hard cap on the response body.
 */
export const outboundFetch = Effect.fn("mcpConnectors.outboundFetch")(function* (
  request: OutboundHttpRequest,
) {
  const normalized = normalizeMcpConnectorUrl(request.url);
  if (!normalized.ok) return yield* Effect.fail(blocked("invalid-url", normalized.error));
  const url = new URL(normalized.url);
  yield* assertReachable(url);

  const execute = (yield* HttpClient.HttpClient).execute(
    request.body === undefined
      ? HttpClientRequest.make(request.method)(normalized.url).pipe(
          HttpClientRequest.setHeaders(request.headers ?? {}),
        )
      : HttpClientRequest.make(request.method)(normalized.url).pipe(
          HttpClientRequest.setHeaders(request.headers ?? {}),
          HttpClientRequest.bodyUint8Array(request.body),
        ),
  ).pipe(
    // A redirect is never followed: the destination has not passed the checks above.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.catch((error) => Effect.fail(blocked("network", errorDetail(error)))),
  );

  const response = yield* Effect.gen(function* () {
    const upstream = yield* execute;
    if (upstream.status >= 300 && upstream.status < 400) {
      return yield* Effect.fail(blocked("redirect"));
    }
    const body = yield* readBounded(upstream, request.maxResponseBytes).pipe(
      Effect.catch((error) =>
        error instanceof OutboundBlockedError
          ? Effect.fail(error)
          : Effect.fail(blocked("network", errorDetail(error))),
      ),
    );
    return {
      status: upstream.status,
      headers: upstream.headers,
      body,
    } satisfies OutboundHttpResponse;
  }).pipe(
    Effect.raceFirst(
      Effect.sleep(request.timeoutMs ?? MCP_CONNECTOR_CONNECT_TIMEOUT_MS).pipe(
        Effect.andThen(Effect.fail(blocked("timeout"))),
      ),
    ),
  );
  return response;
});
