import { assert, describe, it } from "@effect/vitest";

import {
  DAK_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  dakOrchestrationPromptForFirstRun,
  dakOrchestrationSystemPrompt,
} from "./DakOrchestrationInstructions.ts";

describe("DAK orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(DAK_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(DAK_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level DAK conversations");
    assert.include(DAK_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(DAK_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(DAK_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      DAK_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `dak_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(DAK_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(DAK_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(DAK_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = dakOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasDakMcp: true,
    });

    assert.include(injected, "<dak_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      dakOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasDakMcp: true }),
      prompt,
    );
    assert.equal(
      dakOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasDakMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the DAK MCP server is attached", () => {
    assert.equal(dakOrchestrationSystemPrompt(false), undefined);
    assert.equal(dakOrchestrationSystemPrompt(true), DAK_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasDakMcp: true },
    });

    assert.include(injected, "DAK interaction mode: Default");
    assert.include(injected, "DAK collaborative browser");
    assert.include(injected, "DAK orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasDakMcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "DAK interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasDakMcp: false },
    });
    assert.include(withoutMcp, "DAK interaction mode: Default");
    assert.notInclude(withoutMcp, "DAK collaborative browser");
    assert.notInclude(withoutMcp, "DAK orchestration");
  });
});
