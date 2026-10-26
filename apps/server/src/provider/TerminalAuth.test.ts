import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@dak/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { makeTerminalAuth, type TerminalAuthOptions } from "./TerminalAuth.ts";

const instanceId = ProviderInstanceId.make("terminal-auth-test");

const makeHarness = (overrides?: Partial<TerminalAuthOptions>, withPty = true, autoExit?: number) =>
  Effect.gen(function* () {
    const changed: boolean[] = [];
    const spawned = yield* Deferred.make<void>();
    let terminalSpawn: PtyAdapter.PtySpawnInput | undefined;
    let _data: ((value: string) => void) | undefined;
    let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    let killed = false;
    const written: string[] = [];
    const sizes: number[][] = [];
    const options = {
      instanceId,
      displayName: "OpenCode",
      enabled: true,
      credentialBinding: { owner: "provider", key: `opencode:${instanceId}` },
      command: "/managed/opencode",
      environment: { PATH: "/tools" },
      cwd: "/workspace",
      methods: [
        {
          id: "terminal",
          name: "Terminal",
          description: "Run the OpenCode login.",
          args: ["auth", "login"],
        },
      ],
      onChanged: (value: boolean) =>
        Effect.sync(() => {
          changed.push(value);
        }),
      ...overrides,
    } satisfies TerminalAuthOptions;
    const pty: PtyAdapter.PtyAdapter["Service"] = {
      spawn: (input) =>
        Effect.gen(function* () {
          terminalSpawn = input;
          yield* Deferred.succeed(spawned, void 0);
          return {
            pid: 123,
            write: (value: string) => {
              written.push(value);
            },
            resize: (cols: number, rows: number) => {
              sizes.push([cols, rows]);
            },
            kill: () => {
              killed = true;
            },
            onData: (callback: (value: string) => void) => {
              _data = callback;
              return () => {
                _data = undefined;
              };
            },
            onExit: (callback: (event: PtyAdapter.PtyExitEvent) => void) => {
              exit = callback;
              if (autoExit !== undefined) {
                callback({ exitCode: autoExit, signal: null });
              }
              return () => {
                exit = undefined;
              };
            },
          };
        }),
    };
    const controller = withPty
      ? yield* Effect.provideService(makeTerminalAuth(options), PtyAdapter.PtyAdapter, pty)
      : yield* makeTerminalAuth(options);
    const state = (predicate: (state: ProviderAuthState) => boolean) =>
      controller
        .subscribe("owner")
        .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
    const phase = (phase: ProviderAuthState["phase"]) => state((value) => value.phase === phase);
    yield* state((value) => value.methods !== undefined);
    return {
      controller,
      changed,
      phase,
      spawned,
      terminalSpawn: () => terminalSpawn,
      exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
      killed: () => killed,
      written,
      sizes,
    };
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("runs the login terminal with the instance environment and reports success", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const flow = yield* h.controller.start("owner", Effect.void, "terminal");
    const waiting = yield* h.phase("waiting");
    assert.deepEqual(waiting.interaction, {
      type: "terminal",
      id: "terminal",
      output: "",
      outputOffset: 0,
    });
    assert.deepEqual(h.terminalSpawn(), {
      shell: "/managed/opencode",
      args: ["auth", "login"],
      cwd: "/workspace",
      cols: 80,
      rows: 24,
      env: { PATH: "/tools" },
    });
    yield* h.controller.respond!("owner", {
      instanceId,
      flowId: flow.flowId!,
      interactionId: "terminal",
      response: { type: "terminal", data: "arrow-down\r", size: { cols: 100, rows: 30 } },
    });
    assert.deepEqual(h.written, ["arrow-down\r"]);
    assert.deepEqual(h.sizes, [[100, 30]]);
    h.exit(0);
    yield* h.phase("succeeded");
    assert.deepEqual(h.changed, [true]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails the flow when the login command exits nonzero", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.controller.start("owner", Effect.void, "terminal");
    yield* h.phase("waiting");
    h.exit(1);
    const failed = yield* h.phase("failed");
    assert.equal(
      failed.message,
      "The OpenCode login command did not finish successfully. Start sign-in again.",
    );
    assert.isTrue(h.killed());
    assert.deepEqual(h.changed, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("advertises no methods without a PTY service", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(undefined, false);
    const idle = yield* h.phase("idle");
    assert.deepEqual(idle.methods, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cannot sign in while the instance is disabled", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ enabled: false });
    yield* h.controller.start("owner", Effect.void, "terminal");
    const failed = yield* h.phase("failed");
    assert.equal(failed.message, "Enable OpenCode before signing in.");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("runs the logout command headless with the instance environment", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ logoutArgs: ["logout"] }, true, 0);
    const logoutFiber = yield* h.controller.logout(Effect.void).pipe(Effect.forkScoped);
    yield* Deferred.await(h.spawned);
    yield* Fiber.join(logoutFiber);
    assert.deepEqual(h.terminalSpawn(), {
      shell: "/managed/opencode",
      args: ["logout"],
      cwd: "/workspace",
      cols: 80,
      rows: 24,
      env: { PATH: "/tools" },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails logout when the driver has no logout command", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ logoutArgs: undefined });
    const failed = yield* Effect.flip(h.controller.logout(Effect.void));
    assert.equal(
      failed.detail,
      "OpenCode has no logout command in DAK yet. Sign out inside the provider login terminal instead.",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
