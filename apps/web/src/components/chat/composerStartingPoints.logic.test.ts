import { describe, expect, it } from "vite-plus/test";

import {
  resolveComposerStartingPoints,
  startingPointsWithoutProviderCommands,
  type StartingPointCheckout,
} from "./composerStartingPoints.logic";

const cleanCheckout: StartingPointCheckout = {
  refName: "main",
  hasWorkingTreeChanges: false,
  insertions: 0,
  deletions: 0,
};

const dirtyCheckout: StartingPointCheckout = {
  refName: "main",
  hasWorkingTreeChanges: true,
  insertions: 1_046,
  deletions: 72,
};

function reviewCommand(checkout: StartingPointCheckout | null) {
  const point = resolveComposerStartingPoints({
    hasProject: true,
    isGitRepo: true,
    checkout,
  }).find((candidate) => candidate.command === "review");
  if (!point) {
    throw new Error("expected a review command");
  }
  return point;
}

describe("resolveComposerStartingPoints", () => {
  it("offers nothing until the draft has a project", () => {
    expect(
      resolveComposerStartingPoints({
        hasProject: false,
        isGitRepo: true,
        checkout: dirtyCheckout,
      }),
    ).toEqual([]);
    expect(
      resolveComposerStartingPoints({ hasProject: false, isGitRepo: false, checkout: null }),
    ).toEqual([]);
  });

  it("drops the diff review outside a git repository", () => {
    const commands = resolveComposerStartingPoints({
      hasProject: true,
      isGitRepo: false,
      checkout: null,
    }).map((point) => point.command);

    expect(commands).toEqual(["fix", "explain", "test", "check", "tour"]);
  });

  it("offers every command in a repository", () => {
    const commands = resolveComposerStartingPoints({
      hasProject: true,
      isGitRepo: true,
      checkout: null,
    }).map((point) => point.command);

    expect(commands).toEqual(["fix", "review", "explain", "test", "check", "tour"]);
  });

  it("gives each command its own complete prompt", () => {
    const prompts = resolveComposerStartingPoints({
      hasProject: true,
      isGitRepo: true,
      checkout: dirtyCheckout,
    }).map((point) => point.prompt);

    expect(new Set(prompts).size).toBe(prompts.length);
    for (const prompt of prompts) {
      expect(prompt.trim()).toBe(prompt);
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("shows the checkout's real state on the diff command", () => {
    expect(reviewCommand(dirtyCheckout).description).toBe(
      "Review the diff · +1,046 / -72 on main, uncommitted",
    );
    expect(reviewCommand(cleanCheckout).description).toBe(
      "Review the diff · Nothing uncommitted on main",
    );
    // An unreported checkout is not a clean one, and must not read as either.
    expect(reviewCommand(null).description).toBe("Review the diff");
  });

  it("points the review at something that exists", () => {
    expect(reviewCommand(dirtyCheckout).prompt).toBe(
      "Review my uncommitted changes and flag anything risky before I commit.",
    );
    expect(reviewCommand(cleanCheckout).prompt).toBe(
      "Review the most recent commit on main and flag anything risky or inconsistent.",
    );
    // A detached HEAD has no ref to name, and the copy still reads.
    expect(reviewCommand({ ...cleanCheckout, refName: null }).description).toBe(
      "Review the diff · Nothing uncommitted",
    );
    expect(reviewCommand({ ...cleanCheckout, refName: null }).prompt).toBe(
      "Review the most recent commit and flag anything risky or inconsistent.",
    );
  });

  it("steps aside for a provider command of the same name", () => {
    const points = resolveComposerStartingPoints({
      hasProject: true,
      isGitRepo: true,
      checkout: dirtyCheckout,
    });

    expect(
      startingPointsWithoutProviderCommands(points, ["Review", "init"]).map(
        (point) => point.command,
      ),
    ).toEqual(["fix", "explain", "test", "check", "tour"]);
    // Nothing claimed, nothing dropped.
    expect(startingPointsWithoutProviderCommands(points, []).map((point) => point.command)).toEqual(
      ["fix", "review", "explain", "test", "check", "tour"],
    );
  });
});
