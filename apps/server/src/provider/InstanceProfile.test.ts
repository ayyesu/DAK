// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
} from "@dak/contracts";

import { instanceProfileEnvironment, resolveInstanceProfileDir } from "./InstanceProfile.ts";

const stateDir = NodePath.join("dak-home", "userdata");
const driver = (kind: string) => ProviderDriverKind.make(kind);
const instance = (id: string) => ProviderInstanceId.make(id);

const profileDirOf = (kind: string, id: string): string => {
  const profileDir = resolveInstanceProfileDir(stateDir, driver(kind), instance(id));
  if (profileDir === null) throw new Error(`${id} must not be the primary instance of ${kind}`);
  return profileDir;
};

describe("resolveInstanceProfileDir", () => {
  it("keeps the primary instance on the machine's existing login", () => {
    for (const kind of ["claudeAgent", "codex", "grok", "muse", "opencode", "pi"]) {
      expect(resolveInstanceProfileDir(stateDir, driver(kind), instance(kind))).toBeNull();
    }
  });

  it("gives each additional instance a directory under the DAK home", () => {
    expect(resolveInstanceProfileDir(stateDir, driver("opencode"), instance("opencode_work"))).toBe(
      NodePath.join(stateDir, "providers", "opencode", "opencode_work"),
    );
  });

  it("separates two instances of one driver", () => {
    expect(profileDirOf("claudeAgent", "claudeAgent_work")).not.toBe(
      profileDirOf("claudeAgent", "claudeAgent_personal"),
    );
  });
});

describe("instanceProfileEnvironment", () => {
  it("leaves the primary instance byte-identical", () => {
    const environment: ProviderInstanceEnvironment = [
      { name: "XAI_API_KEY", value: "xai-test", sensitive: true },
    ];

    expect(
      instanceProfileEnvironment({
        stateDir,
        driverKind: driver("opencode"),
        instanceId: instance("opencode"),
        environment,
      }),
    ).toBe(environment);
  });

  it("adds nothing for a driver that isolates another way", () => {
    const environment: ProviderInstanceEnvironment = [
      { name: "CODEX_HOME", value: "/custom-home", sensitive: false },
    ];

    expect(
      instanceProfileEnvironment({
        stateDir,
        driverKind: driver("codex"),
        instanceId: instance("codex_work"),
        environment,
      }),
    ).toBe(environment);
  });

  it("fills an instance with no configured rows with only its profile home", () => {
    expect(
      instanceProfileEnvironment({
        stateDir,
        driverKind: driver("opencode"),
        instanceId: instance("opencode_work"),
        environment: [],
      }),
    ).toEqual([
      { name: "XDG_DATA_HOME", value: profileDirOf("opencode", "opencode_work"), sensitive: false },
    ]);
  });

  it("points two instances of one driver at distinct homes", () => {
    const work = instanceProfileEnvironment({
      stateDir,
      driverKind: driver("claudeAgent"),
      instanceId: instance("claudeAgent_work"),
      environment: [],
    });
    const personal = instanceProfileEnvironment({
      stateDir,
      driverKind: driver("claudeAgent"),
      instanceId: instance("claudeAgent_personal"),
      environment: [],
    });

    expect(work[0]?.name).toBe("CLAUDE_CONFIG_DIR");
    expect(work[0]?.value).not.toBe(personal[0]?.value);
  });

  it("uses the override each receiver documents", () => {
    for (const [kind, variableName] of [
      ["claudeAgent", "CLAUDE_CONFIG_DIR"],
      ["grok", "GROK_HOME"],
      ["opencode", "XDG_DATA_HOME"],
      ["pi", "PI_CODING_AGENT_DIR"],
    ] as const) {
      expect(
        instanceProfileEnvironment({
          stateDir,
          driverKind: driver(kind),
          instanceId: instance(`${kind}_work`),
          environment: [],
        }),
      ).toEqual([
        { name: variableName, value: profileDirOf(kind, `${kind}_work`), sensitive: false },
      ]);
    }
  });

  it("points Muse at both XDG homes so its credentials leave the shared config", () => {
    expect(
      instanceProfileEnvironment({
        stateDir,
        driverKind: driver("muse"),
        instanceId: instance("muse_work"),
        environment: [],
      }),
    ).toEqual([
      { name: "XDG_CONFIG_HOME", value: profileDirOf("muse", "muse_work"), sensitive: false },
      { name: "XDG_DATA_HOME", value: profileDirOf("muse", "muse_work"), sensitive: false },
    ]);
  });

  it("keeps a user-configured home over the profile", () => {
    const environment: ProviderInstanceEnvironment = [
      { name: "GROK_HOME", value: "/shared/grok", sensitive: false },
    ];

    expect(
      instanceProfileEnvironment({
        stateDir,
        driverKind: driver("grok"),
        instanceId: instance("grok_work"),
        environment,
      }),
    ).toBe(environment);
  });

  it("prepends the profile without disturbing unrelated rows", () => {
    const environment: ProviderInstanceEnvironment = [
      { name: "XAI_API_KEY", value: "xai-test", sensitive: true },
    ];

    const resolved = instanceProfileEnvironment({
      stateDir,
      driverKind: driver("grok"),
      instanceId: instance("grok_work"),
      environment,
    });

    expect(resolved.map((entry) => entry.name)).toEqual(["GROK_HOME", "XAI_API_KEY"]);
    expect(resolved[1]?.value).toBe("xai-test");
  });
});
