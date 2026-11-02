// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@dak/contracts";

/**
 * Variables that point a provider CLI at a private profile directory. Each one
 * was verified against the installed CLI or its own documentation, and the
 * receiver reads the variable itself, so a spawned child lands in the private
 * profile without DAK copying anything:
 *
 * - `CLAUDE_CONFIG_DIR` and `GROK_HOME` are documented overrides.
 * - `XDG_DATA_HOME` relocates OpenCode's credential store (`opencode.db`), and
 *   `PI_CODING_AGENT_DIR` relocates `~/.pi/agent`.
 * - Muse resolves its config roots through the XDG base directories, so its
 *   credentials (`auth.json`) and session state both live under those homes.
 *   Both must follow the profile or `muse login` would write into the host's
 *   shared config and every account would share one login.
 *
 * A driver absent from this map isolates another way or not at all. Cursor and
 * managed Codex keep credentials in DAK's own store, Antigravity installs into
 * a per-instance managed directory, existing-mode Codex uses `homePath`
 * because its layout is resolved from config rather than from the environment,
 * and registry agents are arbitrary binaries whose override variables DAK
 * cannot name, so their environment rows stay user-authored.
 */
const PROFILE_ENVIRONMENT_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  claudeAgent: ["CLAUDE_CONFIG_DIR"],
  grok: ["GROK_HOME"],
  muse: ["XDG_CONFIG_HOME", "XDG_DATA_HOME"],
  opencode: ["XDG_DATA_HOME"],
  pi: ["PI_CODING_AGENT_DIR"],
};

/**
 * The private credential root for an instance, or null for the one that keeps
 * the machine's existing login.
 *
 * An instance whose id equals its driver kind is the account DAK inherited
 * from whatever was already signed in on this machine, so it keeps reading the
 * host default (`~/.codex`, `~/.claude`, `~/.local/share/opencode`) and no
 * existing user re-authenticates. Every other instance gets its own directory
 * under the DAK home, which is where provider CLIs run, so a second account
 * never reads the first one's credential file. Remote and tunnel clients never
 * supply credentials; the directory belongs to the machine running the server.
 *
 * `instanceId` is the key of `settings.providerInstances` and the mutation
 * exposes no rename operation, so this path is stable for an instance's life.
 */
export function resolveInstanceProfileDir(
  stateDir: string,
  driverKind: ProviderDriverKind,
  instanceId: ProviderInstanceId,
): string | null {
  if (instanceId === defaultInstanceIdForDriver(driverKind)) return null;
  return NodePath.join(stateDir, "providers", driverKind, instanceId);
}

export interface InstanceProfileEnvironmentInput {
  readonly stateDir: string;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly environment: ProviderInstanceEnvironment;
}

/**
 * An instance's environment with the variables that keep it on its own
 * profile. The input comes back untouched for the primary instance, for a
 * driver with no environment variable, and whenever the instance already
 * configures one, so a user-authored value is never re-pointed at DAK's
 * directory.
 *
 * Profile entries are prepended because `mergeProviderInstanceEnvironment`
 * lets later entries win.
 */
export function instanceProfileEnvironment(
  input: InstanceProfileEnvironmentInput,
): ProviderInstanceEnvironment {
  const profileDir = resolveInstanceProfileDir(input.stateDir, input.driverKind, input.instanceId);
  const variables = PROFILE_ENVIRONMENT_VARIABLES[input.driverKind];
  if (profileDir === null || variables === undefined) return input.environment;

  const explicit = new Set(input.environment.map((entry) => entry.name));
  const profile = variables
    .filter((name) => !explicit.has(name))
    .map((name) => ({ name, value: profileDir, sensitive: false }));
  if (profile.length === 0) return input.environment;
  return [...profile, ...input.environment];
}

/**
 * OpenCode's credential store when nothing relocates it. OpenCode resolves the
 * XDG data home the same way on every platform, so this is where the primary
 * instance reads the login that was already on the machine.
 */
const OPENCODE_HOST_DATA_HOME = NodePath.join(NodeOS.homedir(), ".local", "share", "opencode");

/** Compare paths the way the filesystem holding them does. */
const profilePathKey = (value: string): string => {
  const normalized = NodePath.normalize(value.trim());
  // `normalize` keeps a trailing separator, which would otherwise make two
  // spellings of one directory compare unequal.
  const untrailed = normalized.replace(/[\\/]+$/, "");
  const canonical = untrailed.length > 0 ? untrailed : normalized;
  return NodePath.sep === "\\" ? canonical.toLowerCase() : canonical;
};

export interface OpenCodeProfileCollision {
  readonly instanceId: ProviderInstanceId;
  readonly sharedWith: ReadonlyArray<ProviderInstanceId>;
}

/**
 * Enabled OpenCode instances that resolve to the same credential store.
 *
 * DAK's own profile paths embed the instance id, so two of them can never
 * collide — a shared store only happens when a user-authored `XDG_DATA_HOME`
 * replaces the row DAK stamps. `instanceProfileEnvironment` leaves that row
 * alone on purpose, so the override is never re-pointed; naming the collision
 * instead is what makes it visible when instances stop switching accounts.
 *
 * A disabled instance is ignored because it never runs, and an authored row
 * wins over the DAK profile exactly as it does at spawn time.
 */
export function findOpenCodeProfileCollisions(input: {
  readonly stateDir: string;
  readonly instances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly environment?: ProviderInstanceEnvironment | undefined;
  }>;
}): ReadonlyArray<OpenCodeProfileCollision> {
  const byHome = new Map<string, Array<ProviderInstanceId>>();
  for (const instance of input.instances) {
    if (!instance.enabled) continue;
    const authored = instance.environment?.find((entry) => entry.name === "XDG_DATA_HOME");
    const profileDir = resolveInstanceProfileDir(
      input.stateDir,
      ProviderDriverKind.make("opencode"),
      instance.instanceId,
    );
    const home =
      authored !== undefined && authored.value.trim().length > 0
        ? authored.value
        : (profileDir ?? OPENCODE_HOST_DATA_HOME);
    const key = profilePathKey(home);
    byHome.set(key, [...(byHome.get(key) ?? []), instance.instanceId]);
  }
  const collisions: Array<OpenCodeProfileCollision> = [];
  for (const instanceIds of byHome.values()) {
    if (instanceIds.length < 2) continue;
    for (const instanceId of instanceIds) {
      collisions.push({
        instanceId,
        sharedWith: instanceIds.filter((other) => other !== instanceId),
      });
    }
  }
  return collisions;
}
