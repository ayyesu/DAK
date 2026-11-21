import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpConnectors from "./McpConnectors.ts";
import * as injection from "./injection.ts";

const makeSecretStore = () => {
  const values = new Map<string, Uint8Array>();
  return Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
};

/** Answers every MCP handshake with a plain JSON-RPC result, or the given status. */
const makeHttpClient = (status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          status === 200
            ? Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } })
            : new Response("", { status }),
        ),
      ),
    ),
  );

const layerFor = (status = 200) =>
  McpConnectors.make.pipe(
    Effect.map((service) => service),
    Layer.effect(McpConnectors.McpConnectors),
    Layer.provide(makeSecretStore()),
    Layer.provide(makeHttpClient(status)),
    Layer.provide(NodeCrypto.layer),
  );

// Loopback http skips the DNS guard, so these tests never touch the network.
const LOCAL = "http://127.0.0.1:9/mcp";

describe("McpConnectors", () => {
  it.effect("connects a server and lists it", () =>
    Effect.gen(function* () {
      const connectors = yield* McpConnectors.McpConnectors;
      const { connector } = yield* connectors.connect({ url: LOCAL, name: "Local" });
      assert.strictEqual(connector.status, "connected");
      assert.strictEqual(connector.transport, "local-http");
      const listed = yield* connectors.list;
      assert.strictEqual(listed.connectors.length, 1);
      assert.strictEqual(listed.checking, false);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("returns one row when the same URL is connected concurrently", () =>
    Effect.gen(function* () {
      const connectors = yield* McpConnectors.McpConnectors;
      const results = yield* Effect.all(
        [connectors.connect({ url: LOCAL }), connectors.connect({ url: LOCAL })],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results[0].connector.connectorId, results[1].connector.connectorId);
      assert.strictEqual((yield* connectors.list).connectors.length, 1);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("keeps server names unique and short for long identical display names", () =>
    Effect.gen(function* () {
      const connectors = yield* McpConnectors.McpConnectors;
      const name = "A very long connector display name that keeps going";
      const a = yield* connectors.connect({ url: "http://127.0.0.1:9/a", name });
      const b = yield* connectors.connect({ url: "http://127.0.0.1:9/b", name });
      assert.notStrictEqual(a.connector.serverName, b.connector.serverName);
      assert.isAtMost(a.connector.serverName.length, 37);
      assert.isAtMost(b.connector.serverName.length, 37);
      assert.match(a.connector.connectorId, /^[a-z0-9_]+-[0-9a-f]{12}$/);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("rejects a server that needs a sign-in and does not save it", () =>
    Effect.gen(function* () {
      const connectors = yield* McpConnectors.McpConnectors;
      const failure = yield* connectors.connect({ url: LOCAL }).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "sign-in-required");
      assert.strictEqual((yield* connectors.list).connectors.length, 0);
    }).pipe(Effect.provide(layerFor(401))),
  );

  it.effect("disconnect removes the connector from the injection snapshot", () =>
    Effect.gen(function* () {
      const connectors = yield* McpConnectors.McpConnectors;
      const { connector } = yield* connectors.connect({ url: LOCAL });
      yield* connectors.disconnect({ connectorId: connector.connectorId });
      assert.strictEqual((yield* connectors.list).connectors.length, 0);
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("connector injection snapshot", () => {
  it("is empty without a provider session", () => {
    injection.setConnectedConnectors([{ connectorId: "x-1", serverName: "x_connector" }]);
    try {
      assert.deepEqual(injection.connectorMcpServers("thread-without-session" as never), []);
    } finally {
      injection.setConnectedConnectors([]);
    }
  });
});
