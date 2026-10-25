import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@dak/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import type * as ProviderAuthService from "./ProviderAuthService.ts";
import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";

/**
 * Terminal sign-in for drivers whose CLI ships its own interactive login
 * command, like `opencode auth login`. It builds a ProviderAuthController
 * through ProviderAuthFlow.make, so provider settings get the methods list,
 * terminal interaction, and flow lifetime the ACP sign-in already uses
 * (AcpRegistryAuth) without any client changes.
 *
 * The command runs in a PTY seeded with the instance's own environment, so
 * credentials land in that instance's isolated profile and stay there.
 */

export interface TerminalAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  /** Argv appended to the driver command, e.g. ["auth", "login"]. */
  readonly args: ReadonlyArray<string>;
  /** Extra environment merged over the instance environment for this login. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface TerminalAuthOptions {
  readonly instanceId: ProviderInstanceId;
  /** Human name for sign-in messages, e.g. "OpenCode". */
  readonly displayName: string;
  /** Disabled instances cannot sign in, mirroring the ACP enabled gate. */
  readonly enabled: boolean;
  /** Equal keys mean these instances share credentials on this environment. */
  readonly credentialBinding: NonNullable<
    ProviderAuthService.ProviderAuthController["credentialBinding"]
  >;
  /** The login command, normally the driver's configured binaryPath. */
  readonly command: string;
  /**
   * The instance's chat environment so sign-in sees the same profile the
   * runtime uses at launch.
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly methods: ReadonlyArray<TerminalAuthMethod>;
  /**
   * Runs after the login command exits cleanly, before the flow reports
   * success. Unlike ACP there is no shared runtime to reconnect for
   * verification: driver snapshots do not expose a credential-aware auth
   * status (Muse always reports "unknown", OpenCode conflates "ready" with
   * signed in), so the login command's own exit code is the verification.
   * Drivers use this to refresh their published snapshot.
   */
  readonly onChanged?: (authenticated: boolean) => Effect.Effect<void>;
  /** Logout argv runs headless through the same command. */
  readonly logoutArgs?: ReadonlyArray<string> | undefined;
}

export const makeTerminalAuth = Effect.fnUntraced(function* (options: TerminalAuthOptions) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  // Terminal-only methods need a PTY; without one the settings UI shows no
  // sign-in methods, the same filter the ACP driver applies.
  const methods: Effect.Effect<
    ReadonlyArray<ProviderAuthMethod>,
    ProviderSetupError
  > = Option.isNone(pty)
    ? Effect.succeed([])
    : Effect.succeed(
        options.methods.map((method) => ({
          id: method.id,
          name: method.name,
          description: method.description ?? null,
          type: "terminal" as const,
        })),
      );

  const runTerminal = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty))
      return yield* failure(
        "start",
        "Interactive provider sign-in is unavailable on this environment.",
      );
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: options.command,
        args: [...args],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: { ...options.environment },
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("start", `Could not open the ${options.displayName} sign-in terminal.`, cause),
        ),
      );
    const detachData = process.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-16_384));
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {
          /* The login process may already have exited. */
        }
      }),
    );
    let transcript = "";
    let outputOffset = 0;
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) process.resize(response.size.cols, response.size.rows);
                  if (response.data) process.write(response.data);
                },
                catch: () =>
                  failure(
                    "respond",
                    `The ${options.displayName} sign-in terminal is no longer available.`,
                  ),
              })
            : Effect.void,
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-16_384);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* Deferred.await(exited)) !== 0) {
      return yield* failure(
        "start",
        `The ${options.displayName} login command did not finish successfully. Start sign-in again.`,
      );
    }
  });

  const authenticate = (methodId: string, context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      if (!options.enabled)
        return yield* failure("start", `Enable ${options.displayName} before signing in.`);
      const method = options.methods.find((candidate) => candidate.id === methodId);
      if (!method) return yield* failure("start", "This sign-in method is no longer available.");
      yield* Effect.scoped(runTerminal(method.args, context));
      yield* context.verifying;
      if (options.onChanged) yield* options.onChanged(true);
    });

  const logoutArgs = options.logoutArgs;
  const logout: Effect.Effect<void | string, ProviderSetupError> =
    logoutArgs === undefined
      ? Effect.fail(
          failure(
            "logout",
            `${options.displayName} has no logout command in DAK yet. Sign out inside the provider login terminal instead.`,
          ),
        )
      : Effect.gen(function* () {
          if (Option.isNone(pty))
            return yield* failure(
              "logout",
              "Interactive provider sign-in is unavailable on this environment.",
            );
          const exited = yield* Deferred.make<number>();
          const process = yield* pty.value
            .spawn({
              shell: options.command,
              args: [...logoutArgs],
              cwd: options.cwd,
              cols: 80,
              rows: 24,
              env: { ...options.environment },
            })
            .pipe(
              Effect.mapError((cause) =>
                failure(
                  "logout",
                  `Could not run the ${options.displayName} logout command.`,
                  cause,
                ),
              ),
            );
          const detachExit = process.onExit(({ exitCode }) => {
            Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
          });
          const exitCode = yield* Deferred.await(exited).pipe(
            Effect.timeoutOrElse({
              duration: "60 seconds",
              orElse: () => Effect.succeed(-1),
            }),
          );
          detachExit();
          try {
            process.kill();
          } catch {
            /* The logout process may already have exited. */
          }
          if (exitCode !== 0)
            return yield* failure(
              "logout",
              `The ${options.displayName} logout command did not finish successfully.`,
            );
        });

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: options.credentialBinding,
    methods,
    authenticate,
    logout,
  });
});
