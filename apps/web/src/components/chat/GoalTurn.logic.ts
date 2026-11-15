import type { GoalReport, GoalReportStatus } from "@dak/shared/goalReport";

import type { GoalTone } from "./GoalMode.logic";

/**
 * The turns Goal Mode sends into a thread are ordinary messages whose id says what they are:
 * `goal-message:<goalId>:<cycle>:<phase>` (GoalService, `dispatchTurn`). That id is the only
 * link the client has, so it is read here and nowhere else.
 */
export type GoalTurnPhase = "plan" | "task" | "verify" | "repair" | "answer" | "edit" | "recover";

export interface GoalTurnRef {
  readonly goalId: string;
  readonly cycle: number;
  readonly phase: GoalTurnPhase;
}

const GOAL_MESSAGE_ID = /^goal-message:(.+):(\d+):(plan|task|verify|repair|answer|edit|recover)$/;

/** The goal turn a message id names, or null for any other message. */
export function parseGoalTurnMessageId(id: string): GoalTurnRef | null {
  const match = GOAL_MESSAGE_ID.exec(id);
  if (match === null) return null;
  return {
    goalId: match[1]!,
    cycle: Number(match[2]),
    phase: match[3] as GoalTurnPhase,
  };
}

export function goalTurnPhaseLabel(phase: GoalTurnPhase): string {
  switch (phase) {
    case "plan":
      return "Planning";
    case "task":
      return "Working";
    case "verify":
      return "Verifying";
    case "repair":
      return "Repairing";
    case "answer":
      return "Your answer";
    case "edit":
      return "Goal edited";
    case "recover":
      return "Recovering";
  }
}

/** What the turn is for, as one line, when the prompt names no task. */
export function goalTurnPhaseSummary(phase: GoalTurnPhase): string {
  switch (phase) {
    case "plan":
      return "Reading the project and planning the work.";
    case "task":
      return "Working on the next task.";
    case "verify":
      return "Checking the result against the goal.";
    case "repair":
      return "Fixing what the check found.";
    case "answer":
      return "Continuing with your answer.";
    case "edit":
      return "Continuing with the edited goal.";
    case "recover":
      return "Picking up after a turn that did not finish.";
  }
}

export function goalTurnTone(phase: GoalTurnPhase): GoalTone {
  switch (phase) {
    case "repair":
    case "recover":
      return "attention";
    case "edit":
      return "muted";
    case "plan":
    case "task":
    case "verify":
    case "answer":
      return "active";
  }
}

/**
 * The task a turn was given, read from its prompt ("Your task this turn: ..."). Best effort: the
 * wording belongs to the server, so a prompt that changes simply yields null and the card falls
 * back to the phase summary.
 */
export function goalTurnTaskTitle(prompt: string): string | null {
  const match = /Your task this turn: "([^"\n]{1,200})"/.exec(prompt);
  return match?.[1]?.trim() || null;
}

/**
 * What the user told the agent in an answer turn ("The user answered: ..."). The answer is the
 * one part of that prompt a person wrote, so the card shows it instead of the instructions around it.
 */
export function goalTurnAnswer(prompt: string): string | null {
  const match =
    /(?:^|\n)The user answered: ([\s\S]*?)(?:\n\nThe task you asked about|\n\nContinue the plan|(?![\s\S]))/.exec(
      prompt,
    );
  return match?.[1]?.trim() || null;
}

/**
 * What the provider said when it failed the turn before this one. The server opens the next
 * prompt with it so the agent knows the fault was the environment's.
 */
export function goalTurnProviderNotice(
  prompt: string,
): { readonly kind: string; readonly message: string } | null {
  const match =
    /^The previous turn never reached you: the provider failed \(([^)\n]*)\) - (.*)$/m.exec(prompt);
  if (match === null) return null;
  return { kind: match[1]!.trim(), message: match[2]!.trim() };
}

export function goalReportStatusLabel(status: GoalReportStatus): string {
  switch (status) {
    case "planning":
      return "Planned";
    case "running":
      return "Progress";
    case "recovering":
      return "Recovering";
    case "needs_input":
      return "Needs your input";
    case "completed":
      return "Completed";
  }
}

export function goalReportTone(report: Pick<GoalReport, "status">): GoalTone {
  switch (report.status) {
    case "completed":
      return "success";
    case "needs_input":
    case "recovering":
      return "attention";
    case "planning":
    case "running":
      return "active";
  }
}

/** Tasks and criteria shown before a card folds the rest behind a toggle. */
export const GOAL_REPORT_VISIBLE_ITEMS = 3;
