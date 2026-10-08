import { describe, expect, it } from "vite-plus/test";

import { DAK_MCP_TOOL_NAMES, resolveDakMcpToolPresentation } from "./dakMcpToolPresentation.ts";

describe("resolveDakMcpToolPresentation", () => {
  it("recognizes every DAK tool across provider prefixes and completion suffixes", () => {
    for (const tool of DAK_MCP_TOOL_NAMES) {
      const presentation = resolveDakMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__dak__",
        "mcp__dak__",
        "mcp__dak__",
        "Dak-code.",
        "dak/",
        "dak:",
        "mcp_dak_",
        "DAK ",
        "dak · ",
      ]) {
        expect(resolveDakMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveDakMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor DAK MCP tool names", () => {
    expect(resolveDakMcpToolPresentation("mcp__dak__dak_thread_read")).toEqual({
      displayName: "Read a DAK thread",
      logo: "dak",
    });
  });

  it("pretty prints Codex DAK MCP tool names", () => {
    expect(resolveDakMcpToolPresentation("dak.create_threads")).toEqual({
      displayName: "Create DAK threads",
      logo: "dak",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveDakMcpToolPresentation("mcp__dak__dak_thread_update")).toEqual({
      displayName: "Update DAK thread metadata",
      logo: "dak",
    });
  });

  it("pretty prints bare DAK MCP toolkit names", () => {
    expect(resolveDakMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "dak",
    });
  });

  it("pretty prints worktree DAK MCP tool names", () => {
    expect(resolveDakMcpToolPresentation("mcp__dak__dak_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "dak",
    });
    expect(resolveDakMcpToolPresentation("dak.dak_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "dak",
    });
  });

  it("pretty prints preview DAK MCP tool names", () => {
    expect(resolveDakMcpToolPresentation("Dak-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "dak",
    });
    expect(resolveDakMcpToolPresentation("mcp__dak__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "dak",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_dak_delegate_task",
      "dak:delegate_task",
      "dak/delegate_task",
      "dak delegate_task",
      "DAK delegate_task",
      "dak__delegate_task",
    ]) {
      expect(resolveDakMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveDakMcpToolPresentation("dak-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveDakMcpToolPresentation("dak-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveDakMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveDakMcpToolPresentation("dak.not_a_real_tool")).toBeNull();
  });
});
