/**
 * OpenCodeDriver — `ProviderDriver` for the OpenCode runtime.
 *
 * Mirrors the Codex / Claude drivers: a plain value whose `create()`
 * bundles `snapshot` / `adapter` / `textGeneration` closures over the
 * per-instance `OpenCodeSettings`.
 *
 * Two instances with different `serverUrl`s therefore talk to independent
 * OpenCode servers; when no `serverUrl` is set, the adapter + text-generation
 * shares spin up their own scoped child processes, and those child
 * processes are released when the registry scope closes.
 *
 * @module provider/Drivers/OpenCodeDriver
 */
import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ServerProvider,
} from "@dak/contracts";
import type { Credential } from "@opencode/client/effect";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as OpenCode2TextGeneration from "../../textGeneration/OpenCode2TextGeneration.ts";
import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as OpenCodeAdapterV2 from "../../orchestration-v2/Adapters/OpenCodeAdapterV2.ts";
import * as OpenCode2AdapterV2 from "../../orchestration-v2/Adapters/OpenCode2AdapterV2.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { readOpenCodeGoUsageLimits } from "../openCodeUsageLimits.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2Workspace,
  makeOpenCode2ModelLoader,
  makePendingOpenCodeProvider,
  openCode2CommandsToServerProviderSlashCommands,
  openCode2SkillsToServerProviderSkills,
  openCodeSkillsToServerProviderSkills,
  openCodeCommandsToServerProviderSlashCommands,
} from "../OpenCodeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import { makeTerminalAuth } from "../TerminalAuth.ts";
import {
  makeOpenCodeRuntimeProbe,
  probeOpenCodeRuntime,
  type ProbedOpenCode,
} from "../opencodeVersionProbe.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import * as OpenCode2Client from "../opencode2/OpenCode2Client.ts";
import * as OpenCode2Server from "../opencode2/OpenCode2Server.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  findOpenCodeProfileCollisions,
  instanceProfileEnvironment,
  resolveInstanceProfileDir,
} from "../InstanceProfile.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

/**
 * OpenCode 1.x ships as `opencode-ai` and 2.x as `@opencode/cli`. An install is
 * only ever updated within its own package: DAK never moves a 1.x install onto
 * 2.x or back, since 2.x converts the shared database in place.
 */
export const openCodeUpdateFor = (generation: ProbedOpenCode["generation"]) =>
  makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: generation === "v2" ? "@opencode/cli" : "opencode-ai",
    nativeUpdate: {
      args: ["upgrade"],
      isCommandPath: isOpenCodeNativeCommandPath,
    },
  });

type OpenCodeRuntimeProbe = Effect.Success<
  ReturnType<typeof makeOpenCodeRuntimeProbe<OpenCodeRuntime.OpenCodeRuntimeError>>
>;

/** Runs `v2` for a 2.x instance and `v1` otherwise; a failed probe keeps 1.x, whose checks report it. */
function byOpenCodeRuntime<A, E, R, PE>(
  probed: Effect.Effect<ProbedOpenCode | undefined, PE>,
  paths: { readonly v1: Effect.Effect<A, E, R>; readonly v2: Effect.Effect<A, E, R> },
): Effect.Effect<A, E, R> {
  return probed.pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((result) => (result?.generation === "v2" ? paths.v2 : paths.v1)),
  );
}

/**
 * Routes each adapter call to the runtime the instance's probe detected. Capability and selection
 * reads are hot, so they use the last successful probe (1.x before one lands) and never wait on a
 * slow server. Opening a session waits for a probe, so each server is spoken to in its own protocol.
 */
function selectOpenCodeRuntimeAdapter(input: {
  readonly probe: OpenCodeRuntimeProbe;
  readonly v1: ProviderAdapterV2Shape;
  readonly v2: ProviderAdapterV2Shape;
}): ProviderAdapterV2Shape {
  const pick = <PE>(probed: Effect.Effect<ProbedOpenCode | undefined, PE>) =>
    byOpenCodeRuntime(probed, { v1: Effect.succeed(input.v1), v2: Effect.succeed(input.v2) });
  const hot = pick(Effect.map(input.probe.lastSuccess, Option.getOrUndefined));
  return {
    instanceId: input.v1.instanceId,
    driver: DRIVER_KIND,
    getCapabilities: () => Effect.flatMap(hot, (adapter) => adapter.getCapabilities()),
    planSelectionTransition: (transition) =>
      Effect.flatMap(hot, (adapter) => adapter.planSelectionTransition(transition)),
    openSession: (session) =>
      Effect.flatMap(pick(input.probe.get), (adapter) => adapter.openSession(session)),
  };
}

/** Text generation runs on the server the instance's probe detected, each in its own protocol. */
function selectOpenCodeRuntimeTextGeneration(
  probe: OpenCodeRuntimeProbe,
  v1: TextGeneration["Service"],
  v2: TextGeneration["Service"],
): TextGeneration["Service"] {
  return {
    generateCommitMessage: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateCommitMessage(input),
        v2: v2.generateCommitMessage(input),
      }),
    generatePrContent: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generatePrContent(input),
        v2: v2.generatePrContent(input),
      }),
    generateBranchName: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateBranchName(input),
        v2: v2.generateBranchName(input),
      }),
    generateThreadTitle: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateThreadTitle(input),
        v2: v2.generateThreadTitle(input),
      }),
  };
}

export type OpenCodeDriverEnv =
  | OpenCodeAdapterV2.OpenCodeAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime.OpenCodeRuntime
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

export const OpenCodeDriver: ProviderDriver<OpenCodeSettings, OpenCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const crypto = yield* Crypto.Crypto;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const instanceEnvironment = instanceProfileEnvironment({
        stateDir: serverConfig.stateDir,
        driverKind: DRIVER_KIND,
        instanceId,
        environment,
      });
      const processEnv = mergeProviderInstanceEnvironment(instanceEnvironment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      // Advertise the terminal sign-in this driver wires to every instance, so
      // account surfaces show its sign-in once the CLI is present. DAK does
      // not install OpenCode itself, and its bare logout opens an interactive
      // account picker, so no sign-out is offered until that flow is modeled.
      const stampAuthSetup = (snapshot: ServerProvider) => ({
        ...snapshot,
        setup: { canAuthenticate: snapshot.installed, canInstall: false },
        auth: { ...snapshot.auth, canLogout: false },
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenCodeSettings;
      const runtimeProbe = yield* makeOpenCodeRuntimeProbe(
        probeOpenCodeRuntime(effectiveConfig, processEnv).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
        ),
      );
      // Updates follow the installed package, which the version probe names. An
      // unknown version offers no package update, since a guess could move a
      // 2.x install onto 1.x's package or the reverse. A disabled instance never
      // runs its binary, so it has no version and offers no update.
      const noUpdate = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const maintenanceFor = (probed: typeof runtimeProbe.get) =>
        probed.pipe(
          Effect.map((result) => result.generation),
          Effect.option,
          Effect.flatMap((generation) =>
            Option.isNone(generation)
              ? Effect.succeed(noUpdate)
              : resolveProviderMaintenanceCapabilitiesEffect(openCodeUpdateFor(generation.value), {
                  binaryPath: effectiveConfig.binaryPath,
                  env: processEnv,
                }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        );
      const cachedMaintenance = yield* makeCachedProviderMaintenanceResolution(
        maintenanceFor(runtimeProbe.get),
      );
      // A fresh read (an update about to run, or a manual refresh) re-probes, so
      // a binary replaced by the other major version gets its own package.
      const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
        !effectiveConfig.enabled
          ? Effect.succeed(noUpdate)
          : options?.fresh === true
            ? runtimeProbe.refresh.pipe(
                Effect.ignore,
                Effect.andThen(cachedMaintenance({ fresh: true })),
              )
            : cachedMaintenance();
      const openCodeV1Adapter = yield* OpenCodeAdapterV2.OpenCodeAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment: instanceEnvironment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build OpenCode orchestration adapter.",
              cause,
            }),
        ),
      );
      // One OpenCode 2 server per instance, spawned on first use or reached at `serverUrl`.
      const openCode2Server = yield* OpenCode2Server.make({
        binaryPath: effectiveConfig.binaryPath,
        serverUrl: effectiveConfig.serverUrl,
        serverPassword: effectiveConfig.serverPassword,
        directory: serverConfig.cwd,
        environment: processEnv,
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
        Effect.provideService(
          OpenCode2Client.OpenCode2Client,
          yield* OpenCode2Client.make.pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
        ),
      );
      const orchestrationAdapter = selectOpenCodeRuntimeAdapter({
        probe: runtimeProbe,
        v1: openCodeV1Adapter,
        v2: yield* OpenCode2AdapterV2.make(instanceId).pipe(
          Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server),
        ),
      });
      const loadOpenCode2Models = yield* makeOpenCode2ModelLoader(
        openCode2Server.withConnection((connection) =>
          connection.client.model.list({ location: { directory: serverConfig.cwd } }).pipe(
            Effect.map((models) => models.data),
            Effect.mapError(
              (cause) =>
                new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "model.list",
                  detail: "The OpenCode server could not list its models.",
                  cause,
                }),
            ),
          ),
        ),
      );
      // A 2.x server lists models with or without an account, so the real
      // sign-in state is its credential store. A failed read (for example an
      // external server too old for the endpoint) becomes null and the status
      // check reports "unknown" instead of guessing.
      const loadOpenCode2Credentials = openCode2Server
        .withConnection((connection) =>
          connection.client.credential
            .list()
            .pipe(
              Effect.map((entries) =>
                entries.map((entry) => ({ label: entry.label, active: entry.active })),
              ),
            ),
        )
        .pipe(Effect.orElseSucceed(() => null));
      // Go usage limits need the account's API key. OpenCode 2 stores it in
      // the instance's credential database, not the 1.x auth.json, so the
      // instance's own server is the only honest source. An OAuth sign-in has
      // no API key to read; the caller falls back to OPENCODE_API_KEY.
      const loadOpenCode2ApiKey = openCode2Server
        .withConnection((connection) =>
          connection.client.credential.list().pipe(
            Effect.map((entries) => {
              const active = entries.find((entry) => entry.active);
              if (active === undefined || active.value.type !== "key") return null;
              return active.value.key.trim() || null;
            }),
          ),
        )
        .pipe(Effect.orElseSucceed(() => null));
      // Every stored sign-in on this instance, for the in-place account
      // switcher. It reads through the instance's own connection, never the
      // host profile.
      const listOpenCode2Accounts = openCode2Server
        .withConnection((connection) =>
          connection.client.credential.list().pipe(
            Effect.map((entries) =>
              entries.map((entry) => ({
                credentialId: entry.id,
                label: entry.label,
                active: entry.active,
              })),
            ),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderSetupError({
                instanceId,
                operation: "opencode.accounts.list",
                detail: "This instance's OpenCode server did not list its stored accounts.",
                cause,
              }),
          ),
        );
      // A 2.x server lists skills and commands per directory, so one server
      // answers every workspace. Its event stream says when a directory it had
      // not served yet finished scanning.
      const listOpenCode2Workspace = (cwd: string) =>
        openCode2Server.withConnection(({ client, events }) =>
          Effect.gen(function* () {
            const location = { directory: cwd };
            const scanned = yield* Deferred.make<void>();
            const pending = new Set(["command.updated", "skill.updated"]);
            const stream = yield* events.pipe(Effect.option);
            if (stream._tag === "Some") {
              yield* stream.value.pipe(
                Stream.runForEach((event) =>
                  "location" in event &&
                  event.location?.directory === cwd &&
                  pending.delete(event.type) &&
                  pending.size === 0
                    ? Deferred.succeed(scanned, undefined)
                    : Effect.void,
                ),
                Effect.ignore,
                Effect.forkScoped,
              );
            }
            return yield* loadOpenCode2Workspace(
              Effect.all(
                {
                  skills: client.skill.list({ location }).pipe(Effect.map((list) => list.data)),
                  commands: client.command.list({ location }).pipe(Effect.map((list) => list.data)),
                },
                { concurrency: "unbounded" },
              ),
              Deferred.await(scanned),
            );
          }).pipe(Effect.scoped),
        );
      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: effectiveConfig.binaryPath,
        directory: serverConfig.cwd,
        ...(effectiveConfig.serverPassword
          ? { serverPassword: effectiveConfig.serverPassword }
          : {}),
        environment: processEnv,
      });
      const textGeneration = selectOpenCodeRuntimeTextGeneration(
        runtimeProbe,
        yield* makeOpenCodeTextGeneration(effectiveConfig).pipe(
          Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
        ),
        yield* OpenCode2TextGeneration.make().pipe(
          Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server),
        ),
      );

      const checkProvider = Effect.all(
        {
          provider: checkOpenCodeProviderStatus(
            effectiveConfig,
            serverConfig.cwd,
            runtimeProbe.refresh,
            loadOpenCode2Models,
            loadOpenCode2Credentials,
          ),
          usageLimits: readOpenCodeGoUsageLimits({
            enabled: effectiveConfig.enabled,
            serverUrl: effectiveConfig.serverUrl,
            environment: processEnv,
            storedApiKey: loadOpenCode2ApiKey,
          }),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ provider, usageLimits }) => ({ ...provider, usageLimits })),
        Effect.map(stampIdentity),
        Effect.map(stampAuthSetup),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
      );
      // NOTE: the local branch intentionally uses the shared SDK server
      // instead of `opencode debug skill` (loadSkillsFromCli). The CLI writes
      // its full JSON inventory to stdout, but the Bun-compiled binary does
      // not flush more than one 64KB pipe buffer to a non-TTY stdout, so the
      // piped output arrives truncated and unparseable — which degrades to an
      // empty skill list and poisons the workspace snapshot the `$` picker
      // reads. The SDK `app.skills` endpoint honors the per-request directory
      // and returns complete results regardless of size.
      const loadWorkspaceInventory = (
        client: Parameters<typeof OpenCodeRuntime.loadOpenCodeCommands>[0],
      ) =>
        Effect.all(
          {
            skills: openCodeRuntime.loadOpenCodeSkills(client),
            commands: OpenCodeRuntime.loadOpenCodeCommands(client).pipe(
              Effect.timeout("10 seconds"),
              Effect.orElseSucceed(() => []),
            ),
          },
          { concurrency: "unbounded" },
        );
      const loadWorkspaceForCwd = (cwd: string) =>
        effectiveConfig.serverUrl.trim().length > 0
          ? Effect.scoped(
              Effect.gen(function* () {
                const server = yield* openCodeRuntime.connectToOpenCodeServer({
                  binaryPath: effectiveConfig.binaryPath,
                  directory: cwd,
                  serverUrl: effectiveConfig.serverUrl,
                  ...(effectiveConfig.serverPassword
                    ? { serverPassword: effectiveConfig.serverPassword }
                    : {}),
                  environment: processEnv,
                });
                const client = openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: cwd,
                  ...(effectiveConfig.serverPassword
                    ? { serverPassword: effectiveConfig.serverPassword }
                    : {}),
                });
                return yield* loadWorkspaceInventory(client);
              }),
            )
          : serverOwner.withServer((server) =>
              loadWorkspaceInventory(
                openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: cwd,
                  ...(server.serverPassword !== undefined
                    ? { serverPassword: server.serverPassword }
                    : {}),
                }),
              ),
            );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      // Profile isolation is what makes separate accounts possible, so both
      // ways it can fail belong on the card: the primary instance keeps the
      // machine's login by design, and an instance that points `XDG_DATA_HOME`
      // somewhere else can end up sharing one credential store with another
      // instance, which is why switching accounts appears to do nothing.
      const stampProfileIsolation = (snapshot: ServerProvider) =>
        serverSettings.getSettings.pipe(
          Effect.map((settings) => {
            const profileDir = resolveInstanceProfileDir(
              serverConfig.stateDir,
              DRIVER_KIND,
              instanceId,
            );
            const collision =
              profileDir === null
                ? undefined
                : findOpenCodeProfileCollisions({
                    stateDir: serverConfig.stateDir,
                    instances: Object.entries(settings.providerInstances)
                      .filter(([, config]) => config.driver === DRIVER_KIND)
                      .map(([id, config]) => ({
                        instanceId: ProviderInstanceId.make(id),
                        enabled: config.enabled !== false,
                        environment: config.environment,
                      })),
                  }).find((entry) => entry.instanceId === instanceId);
            const notes: Array<string> = [];
            if (collision !== undefined) {
              notes.push(
                `Shares one credential profile with ${collision.sharedWith.join(", ")}, so those instances use the same account.`,
              );
            } else if (profileDir === null) {
              // Informational: the primary instance works exactly as designed.
              notes.push("Uses this machine's OpenCode login.");
            }
            if (notes.length === 0) return snapshot;
            return {
              ...snapshot,
              // Only a real collision is a problem, and only an otherwise
              // healthy card should be escalated to it.
              status:
                collision !== undefined && snapshot.status === "ready"
                  ? ("warning" as const)
                  : snapshot.status,
              message: [snapshot.message, ...notes]
                .filter((part): part is string => part !== undefined && part.length > 0)
                .join(" "),
            };
          }),
          // The note is advisory, so a settings read failure must never hold
          // up the snapshot it decorates.
          Effect.orElseSucceed(() => snapshot),
        );
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenCodeSettings>>(
        {
          resolveMaintenance,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          checkProviderOnSettingsChange: () => false,
          refreshOnInterval: false,
          initialSnapshot: (settings) =>
            makePendingOpenCodeProvider(settings.provider).pipe(
              Effect.map(stampIdentity),
              Effect.map(stampAuthSetup),
            ),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
            resolveMaintenance().pipe(
              Effect.flatMap((maintenanceCapabilities) =>
                enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                }),
              ),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.flatMap(stampProfileIsolation),
              Effect.flatMap(publishSnapshot),
            ),
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Terminal sign-in runs `opencode auth login` inside this instance's
      // profile, so a second account never touches the host credentials.
      // `--standalone` matters: without it the CLI hands the new credentials
      // to the machine-wide background service instead of this profile's
      // database, and the host login changes under every account.
      // The login wrote new credentials while the servers below were already
      // running, and `opencode serve` keeps serving the account it verified
      // at startup. Retire both local servers *before* refreshing, because
      // the refresh borrows them and every borrow cancels the idle close —
      // so refreshing first would pin the old process for another session.
      const credentialsChanged = () =>
        Effect.all([openCode2Server.invalidate, serverOwner.invalidate], {
          concurrency: "unbounded",
        }).pipe(Effect.andThen(snapshot.refresh), Effect.asVoid);
      const terminalAuth = yield* makeTerminalAuth({
        instanceId,
        displayName: displayName ?? "OpenCode",
        enabled: effectiveConfig.enabled,
        credentialBinding: { owner: "provider", key: `opencode:${instanceId}` },
        command: effectiveConfig.binaryPath,
        environment: processEnv,
        cwd: serverConfig.cwd,
        methods: [
          {
            id: "terminal",
            name: "Sign in with OpenCode",
            description:
              "Runs `opencode auth login` for this instance. The new account's credentials land in its own profile.",
            args: ["auth", "login", "--standalone"],
          },
        ],
        onChanged: credentialsChanged,
      });
      // Switching accounts is a credential change like a login: the running
      // server verified its account at startup, so both local servers retire
      // and the snapshot refreshes on the new active credential.
      const switchOpenCode2Account = (
        credentialId: string,
        stopSessions: Effect.Effect<void, ProviderSetupError>,
      ) =>
        Effect.gen(function* () {
          // Admission closes before sessions stop (the logout contract), so
          // no new turn joins the account being switched away from. The
          // retire in `credentialsChanged` catches any server a waiting
          // borrower spawned mid-switch.
          yield* Effect.all([openCode2Server.invalidate, serverOwner.invalidate], {
            concurrency: "unbounded",
          });
          yield* stopSessions;
          yield* openCode2Server
            .withConnection((connection) =>
              connection.client.credential.activate({
                credentialID: credentialId as Credential.ID,
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSetupError({
                    instanceId,
                    operation: "opencode.accounts.switch",
                    detail: "This instance's OpenCode server did not switch accounts.",
                    cause,
                  }),
              ),
            );
          yield* credentialsChanged();
          return yield* listOpenCode2Accounts;
        });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        auth: {
          ...terminalAuth,
          listAccounts: () => listOpenCode2Accounts,
          switchAccount: switchOpenCode2Account,
        },
        snapshotForCwd: (cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : byOpenCodeRuntime(runtimeProbe.get, {
                v2: Effect.all([
                  snapshot.getSnapshot,
                  listOpenCode2Workspace(cwd).pipe(
                    Effect.timeout("20 seconds"),
                    Effect.mapError(
                      (cause) =>
                        new ProviderDriverError({
                          driver: DRIVER_KIND,
                          instanceId,
                          detail: `Failed to list OpenCode commands and skills for '${cwd}'`,
                          cause,
                        }),
                    ),
                  ),
                ]).pipe(
                  Effect.map(([machineSnapshot, { skills, commands }]) => ({
                    ...machineSnapshot,
                    skills: openCode2SkillsToServerProviderSkills(skills),
                    slashCommands: openCode2CommandsToServerProviderSlashCommands(commands),
                  })),
                ),
                v1: Effect.all([
                  snapshot.getSnapshot,
                  loadWorkspaceForCwd(cwd).pipe(Effect.timeout("20 seconds")),
                ]).pipe(
                  Effect.map(([machineSnapshot, { skills, commands }]) => ({
                    ...machineSnapshot,
                    skills: openCodeSkillsToServerProviderSkills(skills),
                    slashCommands: openCodeCommandsToServerProviderSlashCommands(commands),
                  })),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: `Failed to probe OpenCode commands and skills for '${cwd}'`,
                        cause,
                      }),
                  ),
                ),
              }),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
