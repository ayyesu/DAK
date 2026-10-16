import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@dak/client-runtime/connection";
import { EnvironmentId } from "@dak/contracts";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "../../connection/desktopLocal";
import { resolveSidebarConnectionMode } from "./SidebarChrome.logic";

const environmentId = EnvironmentId.make("environment-test");

describe("sidebar connection mode", () => {
  it("treats the same-origin primary backend as local", () => {
    const target = new PrimaryConnectionTarget({
      environmentId,
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      label: "This device",
    });

    expect(resolveSidebarConnectionMode(target)).toBe("local");
  });

  it("treats desktop-local secondaries such as WSL as local", () => {
    const target = new BearerConnectionTarget({
      connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
      environmentId,
      label: "WSL (Ubuntu)",
    });

    expect(resolveSidebarConnectionMode(target)).toBe("local");
  });

  it("treats saved remote and relay targets as remote", () => {
    expect(
      resolveSidebarConnectionMode(
        new BearerConnectionTarget({ connectionId: "remote-1", environmentId, label: "Home Mac" }),
      ),
    ).toBe("remote");
    expect(
      resolveSidebarConnectionMode(new RelayConnectionTarget({ environmentId, label: "Relay" })),
    ).toBe("remote");
    expect(
      resolveSidebarConnectionMode(
        new SshConnectionTarget({ connectionId: "ssh-1", environmentId, label: "Build box" }),
      ),
    ).toBe("remote");
  });
});
