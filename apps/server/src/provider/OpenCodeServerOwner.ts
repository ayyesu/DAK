import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";

const OPENCODE_SERVER_IDLE_TTL = "30 seconds";

interface OpenCodeServerOwnerState {
  server: OpenCodeRuntime.OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  borrowers: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
  /**
   * Non-null while a credential change retires the live process. The deferred
   * completes once that process has actually closed, so borrowers arriving
   * mid-recycle wait for a server holding the new credentials instead of
   * joining the one that still holds the old ones.
   */
  recycled: Deferred.Deferred<void, never> | null;
}

type AcquireAttempt =
  | { readonly _tag: "acquired"; readonly server: OpenCodeRuntime.OpenCodeServerProcess }
  | { readonly _tag: "recycling"; readonly recycled: Deferred.Deferred<void, never> };

export class OpenCodeServerOwner extends Context.Service<
  OpenCodeServerOwner,
  {
    readonly withServer: <A, E, R>(
      use: (server: OpenCodeRuntime.OpenCodeServerProcess) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
    /**
     * Retires the live process because this instance's credentials changed.
     * Returns as soon as the change is recorded; borrowers already inside the
     * old process are left to finish, and the *next* borrower waits for it to
     * drain rather than joining a process about to be replaced.
     */
    readonly invalidate: Effect.Effect<void>;
  }
>()("dak/provider/OpenCodeServerOwner") {}

/** Owns the lazy local OpenCode server shared by one provider instance. */
export const make = Effect.fn("OpenCodeServerOwner.make")(function* (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
}) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const ownerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const mutex = yield* Semaphore.make(1);
  const state: OpenCodeServerOwnerState = {
    server: null,
    serverScope: null,
    borrowers: 0,
    idleCloseFiber: null,
    recycled: null,
  };

  const cancelIdleClose = Effect.fn("OpenCodeServerOwner.cancelIdleClose")(function* () {
    const fiber = state.idleCloseFiber;
    state.idleCloseFiber = null;
    if (fiber !== null) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
  });

  const closeServer = Effect.fn("OpenCodeServerOwner.closeServer")(function* (
    expected?: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    if (expected !== undefined && state.server !== expected) {
      return;
    }
    const scope = state.serverScope;
    const recycled = state.recycled;
    state.server = null;
    state.serverScope = null;
    state.recycled = null;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
    if (recycled !== null) {
      yield* Deferred.succeed(recycled, undefined);
    }
  });

  const watchServerExit = Effect.fn("OpenCodeServerOwner.watchServerExit")(function* (
    server: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    yield* server.exitCode;
    yield* mutex.withPermit(
      Effect.gen(function* () {
        if (state.server !== server) {
          return;
        }
        yield* cancelIdleClose();
        yield* closeServer(server);
      }),
    );
  });

  const tryAcquire: Effect.Effect<AcquireAttempt, OpenCodeRuntime.OpenCodeRuntimeError> =
    mutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleClose();
        // A credential change is retiring this process; handing it out would
        // pin the previous account for another session.
        if (state.recycled !== null) {
          return { _tag: "recycling", recycled: state.recycled };
        }
        if (state.server !== null) {
          if (yield* state.server.isRunning) {
            state.borrowers += 1;
            return { _tag: "acquired", server: state.server };
          }
          yield* closeServer(state.server);
        }

        const started = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const serverScope = yield* Scope.make();
            const result = yield* Effect.exit(
              restore(
                runtime
                  .startOpenCodeServerProcess({
                    binaryPath: input.binaryPath,
                    directory: input.directory,
                    ...(input.serverPassword !== undefined
                      ? { serverPassword: input.serverPassword }
                      : {}),
                    ...(input.environment ? { environment: input.environment } : {}),
                    ...(input.verify ? { verify: input.verify } : {}),
                  })
                  .pipe(Effect.provideService(Scope.Scope, serverScope)),
              ),
            );
            if (Exit.isFailure(result)) {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(result.cause);
            }

            const server = result.value;
            state.server = server;
            state.serverScope = serverScope;
            state.borrowers = 1;
            yield* watchServerExit(server).pipe(Effect.forkIn(ownerScope));
            return server;
          }),
        );
        return { _tag: "acquired", server: started };
      }),
    );

  const acquireServer = Effect.gen(function* () {
    for (;;) {
      const attempt = yield* tryAcquire;
      if (attempt._tag === "acquired") {
        return attempt.server;
      }
      // Wait outside the mutex: `releaseServer` needs it to drain. Waiting is
      // what keeps a borrower from joining a process about to be replaced.
      yield* Deferred.await(attempt.recycled);
    }
  });

  /**
   * Credentials changed under the live process. `opencode auth login` runs as
   * a separate process, so a running `opencode serve` can keep serving the
   * account it verified at startup; only a fresh process picks the new one up.
   * The recycle waits for in-flight borrowers rather than killing them.
   */
  const invalidate = Effect.uninterruptible(
    mutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleClose();
        const server = state.server;
        if (server === null) {
          return;
        }
        // Reuse a pending recycle so a burst of credential events cannot
        // strand waiters on a deferred nothing will complete.
        const recycled = state.recycled ?? (yield* Deferred.make<void>());
        state.recycled = recycled;
        if (state.borrowers === 0) {
          yield* closeServer(server);
        }
      }),
    ),
  );

  const releaseServer = (server: OpenCodeRuntime.OpenCodeServerProcess) =>
    mutex.withPermit(
      Effect.gen(function* () {
        if (state.server !== server) {
          return;
        }
        state.borrowers = Math.max(0, state.borrowers - 1);
        if (state.borrowers > 0) {
          return;
        }
        yield* cancelIdleClose();
        // A credential change already retired this process. Close it now
        // instead of scheduling an idle TTL that would keep the old account
        // pinned and complete the recycle waiters are blocked on.
        if (state.recycled !== null) {
          yield* closeServer(server);
          return;
        }
        state.idleCloseFiber = yield* Effect.sleep(OPENCODE_SERVER_IDLE_TTL).pipe(
          Effect.andThen(
            mutex.withPermit(
              Effect.gen(function* () {
                if (state.server !== server || state.borrowers > 0) {
                  return;
                }
                state.idleCloseFiber = null;
                yield* closeServer(server);
              }),
            ),
          ),
          Effect.forkIn(ownerScope),
        );
      }),
    );

  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleClose();
        state.borrowers = 0;
        yield* closeServer();
      }),
    ),
  );

  return OpenCodeServerOwner.of({
    withServer: (use) =>
      Effect.uninterruptibleMask((restore) =>
        restore(acquireServer).pipe(
          Effect.flatMap((server) =>
            restore(use(server)).pipe(Effect.ensuring(releaseServer(server))),
          ),
        ),
      ),
    invalidate,
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const layer = (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
}) => Layer.effect(OpenCodeServerOwner, make(input));
