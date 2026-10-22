/**
 * The prompts a new thread offers in the composer's command menu.
 *
 * Each one is a complete instruction rather than a stem to finish: picking it
 * drops the whole prompt in the composer, and Send is a turn the reader can
 * accept or edit. A prompt that needs something the draft does not have (a
 * repository to diff) is dropped rather than offered, because a command that
 * cannot run is worse than one that is not there.
 */
export type ComposerStartingPointCommand = "fix" | "review" | "explain" | "test" | "check" | "tour";

export interface ComposerStartingPoint {
  /** Typeable command name, without the leading slash. */
  readonly command: ComposerStartingPointCommand;
  /** The line after the label in the command menu. */
  readonly description: string;
  readonly prompt: string;
}

/**
 * The draft's checkout as the environment last reported it. `null` means the
 * client has not heard back, which is not the same as a clean tree and must not
 * be shown as one.
 */
export interface StartingPointCheckout {
  readonly refName: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly insertions: number;
  readonly deletions: number;
}

const REVIEW_POINT: ComposerStartingPoint = {
  command: "review",
  description: "Review the diff",
  prompt: "Review my uncommitted changes and flag anything risky before I commit.",
};

const STARTING_POINTS: readonly ComposerStartingPoint[] = [
  {
    command: "fix",
    description: "Fix a failing test",
    prompt: "Find and fix the first failing test or type error in this project.",
  },
  REVIEW_POINT,
  {
    command: "explain",
    description: "Explain a module",
    prompt: "Explain the module that matters most in this project: what it owns and who calls it.",
  },
  {
    command: "test",
    description: "Write a test",
    prompt: "Find the riskiest untested path in this project and write a test for it.",
  },
  {
    command: "check",
    description: "Check the repo",
    prompt: "Run this project's build, tests, and type checking, then fix whatever fails.",
  },
  {
    command: "tour",
    description: "Tour the codebase",
    prompt:
      "Give me a tour of this codebase: the entry points, the main modules, and how they fit together.",
  },
];

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function refSuffix(refName: string | null): string {
  return refName === null ? "" : ` on ${refName}`;
}

/**
 * The diff command carries the checkout's real state, which is the one thing in
 * the menu the reader cannot already see from the composer. Uncommitted work is
 * what the command promises; a clean tree says so and reviews the commit that
 * is there rather than a diff that is not.
 */
function reviewPoint(checkout: StartingPointCheckout | null): ComposerStartingPoint {
  if (checkout === null) {
    return REVIEW_POINT;
  }
  if (!checkout.hasWorkingTreeChanges) {
    return {
      ...REVIEW_POINT,
      description: `${REVIEW_POINT.description} · Nothing uncommitted${refSuffix(checkout.refName)}`,
      prompt: `Review the most recent commit${refSuffix(checkout.refName)} and flag anything risky or inconsistent.`,
    };
  }
  return {
    ...REVIEW_POINT,
    description: `${REVIEW_POINT.description} · +${formatCount(checkout.insertions)} / -${formatCount(checkout.deletions)}${refSuffix(checkout.refName)}, uncommitted`,
  };
}

export function resolveComposerStartingPoints(input: {
  hasProject: boolean;
  isGitRepo: boolean;
  checkout: StartingPointCheckout | null;
}): readonly ComposerStartingPoint[] {
  // Without a project there is nothing to read, so nothing is offered.
  if (!input.hasProject) {
    return [];
  }
  if (!input.isGitRepo) {
    return STARTING_POINTS.filter((point) => point.command !== "review");
  }
  return STARTING_POINTS.map((point) =>
    point.command === "review" ? reviewPoint(input.checkout) : point,
  );
}

/**
 * A provider command keeps its name. When the runtime already answers to
 * `review`, a second entry labelled `/review` that does something else turns
 * the menu into a coin flip, so the prompt steps aside for it.
 */
export function startingPointsWithoutProviderCommands(
  points: readonly ComposerStartingPoint[],
  providerCommands: ReadonlyArray<string>,
): readonly ComposerStartingPoint[] {
  if (providerCommands.length === 0) {
    return points;
  }
  const claimed = new Set(providerCommands.map((name) => name.toLowerCase()));
  return points.filter((point) => !claimed.has(point.command));
}
