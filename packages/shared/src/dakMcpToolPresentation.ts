export type DakMcpToolLogo = "dak";

export interface DakMcpToolPresentation {
  readonly displayName: string;
  readonly logo: DakMcpToolLogo;
}

export type DakMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render"
  | "canvas-create"
  | "canvas-list"
  | "canvas-read"
  | "canvas-edit"
  | "canvas-undo"
  | "canvas-trash"
  | "canvas-restore"
  | "canvas-export"
  | "canvas-inspect"
  | "canvas-measure"
  | "canvas-screenshot";

export interface DakMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "dak" | "browser" | "device" | "pull-request";
  readonly summaryAction: DakMcpToolSummaryAction;
}

function tool(
  labels: DakMcpToolDefinition["labels"],
  summaryAction: DakMcpToolSummaryAction,
  icon: DakMcpToolDefinition["icon"] = "dak",
  displayName = `${labels[0]} ${labels[3]}`,
): DakMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const DAK_MCP_SERVER_ALIASES = new Set(["dak", "dak_code"]);

// Cards, activity rows, summaries, and provider identity recovery share this inventory.
const DAK_MCP_TOOLS: Readonly<Record<string, DakMcpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Stopping watching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  create_threads: tool(["Create", "Creating", "Created", "DAK threads"], "thread-create"),
  dak_thread_start: tool(["Start", "Starting", "Started", "a DAK thread"], "thread-create"),
  dak_thread_list: tool(["List", "Listing", "Listed", "DAK threads"], "thread-list"),
  dak_thread_read: tool(["Read", "Reading", "Read", "a DAK thread"], "thread-read"),
  dak_thread_send: tool(["Send", "Sending", "Sent", "to a DAK thread"], "thread-send"),
  dak_thread_wait: tool(["Wait", "Waiting", "Waited", "for a DAK thread"], "thread-wait"),
  dak_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a DAK thread"],
    "thread-interrupt",
  ),
  dak_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  dak_worktree_status: tool(["Get", "Getting", "Got", "thread worktree status"], "worktree-status"),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  dak_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  dak_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  dak_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  dak_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  dak_queue_reorder: tool(["Reorder", "Reordering", "Reordered", "a queued run"], "queue-reorder"),
  dak_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  dak_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  dak_pending_request_read: tool(["Read", "Reading", "Read", "pending questions"], "question-read"),
  dak_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  dak_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  dak_thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  dak_thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  dak_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  dak_thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  dak_thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  dak_thread_organize: tool(["Organize", "Organizing", "Organized", "a thread"], "thread-organize"),
  dak_thread_update: tool(
    ["Update", "Updating", "Updated", "DAK thread metadata"],
    "thread-update",
  ),
  dak_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  dak_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  dak_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  dak_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  dak_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  dak_thread_launch: tool(["Launch", "Launching", "Launched", "a project thread"], "thread-create"),
  dak_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  dak_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  dak_project_create: tool(
    ["Register", "Registering", "Registered", "a project"],
    "project-create",
  ),
  dak_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  dak_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  dak_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  dak_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  dak_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  dak_thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
  dak_canvas_create: tool(["Create", "Creating", "Created", "a design"], "canvas-create"),
  dak_canvas_list: tool(["List", "Listing", "Listed", "designs"], "canvas-list"),
  dak_canvas_read: tool(["Read", "Reading", "Read", "a design"], "canvas-read"),
  dak_canvas_edit: tool(["Edit", "Editing", "Edited", "a design"], "canvas-edit"),
  dak_canvas_undo: tool(["Undo", "Undoing", "Undid", "a design edit"], "canvas-undo"),
  dak_canvas_trash: tool(["Trash", "Trashing", "Trashed", "a design"], "canvas-trash"),
  dak_canvas_restore: tool(["Restore", "Restoring", "Restored", "a design"], "canvas-restore"),
  dak_canvas_export: tool(["Export", "Exporting", "Exported", "a design"], "canvas-export"),
  dak_canvas_inspect: tool(["Inspect", "Inspecting", "Inspected", "a design"], "canvas-inspect"),
  dak_canvas_measure: tool(["Measure", "Measuring", "Measured", "a design"], "canvas-measure"),
  dak_canvas_screenshot: tool(
    ["Screenshot", "Screenshotting", "Screenshotted", "a design"],
    "canvas-screenshot",
  ),
};

/**
 * The DAK orchestration tool inventory, used to gate loose name matching on
 * both the server (ACP MCP identity recovery) and the client (logo branding).
 */
export const DAK_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(DAK_MCP_TOOLS));

function normalizeDakMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * ACP agents disagree on how the injected DAK server prefixes its tools:
 * `mcp__dak__x` (Claude/Cursor), `dak.x` (Codex), plus single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
function resolveDakMcpToolName(value: string): string | null {
  const label = normalizeDakMcpToolLabel(value);
  const mcpMatch =
    /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label) ??
    // Single-underscore `mcp_dak_<tool>` seen from registry agents. The server
    // is the first segment; anything after it is the tool, which may itself
    // hold underscores.
    /^mcp_(?<server>[^_]+?)_(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    if (server === undefined || tool === undefined) return null;
    if (!DAK_MCP_SERVER_ALIASES.has(server.toLowerCase())) return null;
    if (Object.hasOwn(DAK_MCP_TOOLS, tool)) return tool;
    // Backwards compat: pre-rename threads stored `dak_*` tool suffixes.
    const compat = tool.replace(/^dak_/, "dak_");
    return Object.hasOwn(DAK_MCP_TOOLS, compat) ? compat : tool;
  }

  const namespaceMatch = /^(?<server>dak|dak_code)(?:__|\s*·\s*|[.:/\s])(?<tool>.+)$/i.exec(label);
  if (namespaceMatch?.groups) {
    const tool = namespaceMatch.groups.tool ?? null;
    if (tool !== null && Object.hasOwn(DAK_MCP_TOOLS, tool)) return tool;
    // Backwards compat: pre-rename threads stored `dak_*` tool suffixes.
    const compat = tool !== null ? tool.replace(/^dak_/, "dak_") : null;
    if (compat !== null && Object.hasOwn(DAK_MCP_TOOLS, compat)) return compat;
    return tool;
  }

  const prefixed = /^(?:mcp[-_]{1,2})?(?:t3|dak)[-_ ]?code(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(DAK_MCP_TOOLS, candidate)) return candidate;
  const compatCandidate = candidate.replace(/^dak_/, "dak_");
  if (Object.hasOwn(DAK_MCP_TOOLS, compatCandidate)) return compatCandidate;
  // OpenCode 2 registers one server per thread, `dak-<thread>`, and joins
  // it to the tool with `_`. Thread ids can hold `_` too, so take the longest
  // known tool name that ends the label.
  if (!/^dak-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(DAK_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

/** The bare DAK tool name (`html_render`) for any provider's spelling of it. */
export function resolveDakMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveDakMcpToolName(toolName);
  return name !== null && Object.hasOwn(DAK_MCP_TOOLS, name) ? name : null;
}

export function resolveDakMcpToolDefinition(
  toolName: string | null | undefined,
): DakMcpToolDefinition | null {
  const name = toolName == null ? null : resolveDakMcpToolName(toolName);
  return name !== null && Object.hasOwn(DAK_MCP_TOOLS, name) ? DAK_MCP_TOOLS[name]! : null;
}

export function resolveDakMcpToolPresentation(
  toolName: string | null | undefined,
): DakMcpToolPresentation | null {
  const definition = resolveDakMcpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "dak" };
}

export function resolveDakMcpToolSummaryAction(
  toolName: string | null | undefined,
): DakMcpToolSummaryAction | null {
  return resolveDakMcpToolDefinition(toolName)?.summaryAction ?? null;
}
