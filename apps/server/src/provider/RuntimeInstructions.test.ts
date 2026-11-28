import { describe, expect, it } from "vite-plus/test";
import {
  appendWorktreeContextToUserText,
  buildRuntimeInstructions,
} from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the dak MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});

describe("appendWorktreeContextToUserText", () => {
  const worktreeRepositories = [
    {
      name: "api",
      path: "packages/api",
      worktreePath: "/tmp/project-api-branch",
    },
  ];

  it("adds primary and sibling worktree paths to the user text", () => {
    const text = appendWorktreeContextToUserText({
      text: "Implement the change",
      primaryWorktreePath: "/tmp/project-branch",
      worktreeRepositories,
    });
    expect(text).toContain("Implement the change");
    expect(text).toContain("Primary worktree: /tmp/project-branch");
    expect(text).toContain("- api (repo path: packages/api): /tmp/project-api-branch");
  });

  it("does not alter slash commands", () => {
    expect(
      appendWorktreeContextToUserText({
        text: "  /compact",
        originalText: "  /compact",
        primaryWorktreePath: "/tmp/project-branch",
        worktreeRepositories,
      }),
    ).toBe("  /compact");
  });

  it("leaves single-repo threads unchanged", () => {
    expect(
      appendWorktreeContextToUserText({
        text: "Implement the change",
        primaryWorktreePath: "/tmp/project-branch",
      }),
    ).toBe("Implement the change");
  });
});
