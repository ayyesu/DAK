const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the dak MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: DAK wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in DAK through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
}

export function appendWorktreeContextToUserText(input: {
  readonly text: string;
  readonly originalText?: string | undefined;
  readonly primaryWorktreePath?: string | null | undefined;
  readonly worktreeRepositories?:
    | ReadonlyArray<{
        readonly name: string;
        readonly path: string;
        readonly worktreePath: string;
      }>
    | undefined;
}): string {
  const worktreeRepositories = input.worktreeRepositories ?? [];
  if (worktreeRepositories.length === 0) return input.text;
  const commandText = input.originalText ?? input.text;
  if (commandText.trimStart().startsWith("/")) return input.text;
  const lines = [
    "<dak_worktrees>",
    "This thread has worktrees in multiple repositories. The provider's current working directory is the primary worktree; use the absolute paths below when working in another repository.",
  ];
  if (input.primaryWorktreePath) {
    lines.push(`Primary worktree: ${toSingleLine(input.primaryWorktreePath)}`);
  }
  for (const repository of worktreeRepositories) {
    lines.push(
      `- ${toSingleLine(repository.name)} (repo path: ${toSingleLine(repository.path)}): ${toSingleLine(repository.worktreePath)}`,
    );
  }
  lines.push("</dak_worktrees>");
  return `${input.text.trimEnd()}\n\n${lines.join("\n")}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
