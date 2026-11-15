import { describe, expect, it } from "vite-plus/test";

import {
  goalTurnAnswer,
  goalTurnProviderNotice,
  goalTurnTaskTitle,
  goalTurnTone,
  parseGoalTurnMessageId,
} from "./GoalTurn.logic";

describe("parseGoalTurnMessageId", () => {
  it("reads the goal, cycle and phase from a goal turn's id", () => {
    expect(parseGoalTurnMessageId("goal-message:7d1c:3:task")).toEqual({
      goalId: "7d1c",
      cycle: 3,
      phase: "task",
    });
  });

  it("keeps a goal id that itself contains colons", () => {
    expect(parseGoalTurnMessageId("goal-message:goal:abc:12:verify")).toEqual({
      goalId: "goal:abc",
      cycle: 12,
      phase: "verify",
    });
  });

  it("ignores every other message", () => {
    expect(parseGoalTurnMessageId("message:1")).toBeNull();
    expect(parseGoalTurnMessageId("goal-message:7d1c:3:unknown")).toBeNull();
    expect(parseGoalTurnMessageId("goal-message:7d1c:x:task")).toBeNull();
  });
});

describe("goalTurnTaskTitle", () => {
  it("reads the task an execution prompt names", () => {
    const prompt = `You are executing a persistent goal in Goal Mode.\n\nYour task this turn: "Add the parser"\nWhat it covers: tokens`;
    expect(goalTurnTaskTitle(prompt)).toBe("Add the parser");
  });

  it("is null when the prompt names no task", () => {
    expect(goalTurnTaskTitle("You are executing a persistent goal in Goal Mode.")).toBeNull();
  });
});

describe("goalTurnAnswer", () => {
  it("reads what the user answered, across lines", () => {
    const prompt = `You are continuing a persistent goal in Goal Mode.\n\nYou previously asked: Which host?\nThe user answered: Use staging.\nThen retry the deploy.\n\nThe task you asked about is "Deploy".\n\nContinue the plan with that answer.`;
    expect(goalTurnAnswer(prompt)).toBe("Use staging.\nThen retry the deploy.");
  });

  it("is null for a prompt with no answer", () => {
    expect(goalTurnAnswer("You are executing a persistent goal in Goal Mode.")).toBeNull();
  });
});

describe("goalTurnProviderNotice", () => {
  it("surfaces the fault the server put at the head of the prompt", () => {
    const prompt =
      "The previous turn never reached you: the provider failed (rate_limit) - Free usage limit reached.\nThat was the environment's failure.\n\nYou are executing a persistent goal.";
    expect(goalTurnProviderNotice(prompt)).toEqual({
      kind: "rate_limit",
      message: "Free usage limit reached.",
    });
    expect(goalTurnProviderNotice("You are executing a persistent goal.")).toBeNull();
  });
});

describe("goalTurnTone", () => {
  it("flags the turns that follow trouble", () => {
    expect(goalTurnTone("recover")).toBe("attention");
    expect(goalTurnTone("repair")).toBe("attention");
    expect(goalTurnTone("task")).toBe("active");
  });
});
