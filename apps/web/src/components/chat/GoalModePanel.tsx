import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@dak/client-runtime/state/runtime";
import type {
  EnvironmentId,
  Goal,
  GoalTask,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@dak/contracts";
import { scopeThreadRef } from "@dak/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleIcon,
  ExternalLinkIcon,
  ListTreeIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  TargetIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  currentGoalTask,
  formatGoalActivityTime,
  goalHeadline,
  goalNeedsAttention,
  goalProgress,
  goalStatusLabel,
  goalStatusTone,
  goalTaskStatusLabel,
  isGoalActive,
  selectGoalForThread,
  type GoalTone,
} from "./GoalMode.logic";

/** Tasks shown before the list folds; a long plan must not swallow the chat. */
const VISIBLE_TASK_LIMIT = 5;
const VISIBLE_ACTIVITY_LIMIT = 12;

const TONE_PILL: Record<GoalTone, string> = {
  active: "bg-info/10 text-info",
  attention: "bg-warning/10 text-warning",
  success: "bg-success/10 text-success",
  danger: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

const TONE_BAR: Record<GoalTone, string> = {
  active: "bg-info",
  attention: "bg-warning",
  success: "bg-success",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

function GoalTaskIcon({ task }: { readonly task: GoalTask }) {
  if (task.status === "completed") {
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
        <CheckIcon aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (task.status === "in_progress") {
    return <Spinner aria-hidden size="xs" />;
  }
  if (task.status === "failed" || task.status === "blocked") {
    return <TriangleAlertIcon aria-hidden className="size-4 text-warning" />;
  }
  return <CircleIcon aria-hidden className="size-4 text-muted-foreground/40" />;
}

function GoalStatusPill({ goal }: { readonly goal: Goal }) {
  const tone = goalStatusTone(goal.status);
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-3xs font-medium leading-4",
        TONE_PILL[tone],
      )}
    >
      {goalStatusLabel(goal.status)}
    </span>
  );
}

/**
 * Goal Mode lives above the composer: a goal the server is driving stays
 * visible here, and an idle composer shows the "define a goal" form once the
 * composer's Goal control opens it.
 */
export function GoalModePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly canOperate: boolean;
  readonly composerOpen: boolean;
  readonly onComposerOpenChange: (open: boolean) => void;
}) {
  const { environmentId, projectId } = props;
  const canOperateGoal = useAtomValue(serverEnvironment.createGoal.permissionAtom(environmentId));
  const canOperate = props.canOperate && canOperateGoal;
  const goalsQuery = useEnvironmentQuery(
    projectId === null
      ? null
      : serverEnvironment.goalsLive({ environmentId, input: { projectId } }),
  );
  const createGoal = useAtomCommand(serverEnvironment.createGoal, { label: "start goal" });
  const updateGoal = useAtomCommand(serverEnvironment.updateGoal, { label: "update goal" });
  const pauseGoal = useAtomCommand(serverEnvironment.pauseGoal, { label: "pause goal" });
  const resumeGoal = useAtomCommand(serverEnvironment.resumeGoal, { label: "resume goal" });
  const cancelGoal = useAtomCommand(serverEnvironment.cancelGoal, { label: "cancel goal" });
  const answerGoal = useAtomCommand(serverEnvironment.answerGoal, {
    label: "answer goal question",
  });
  const retryGoalTask = useAtomCommand(serverEnvironment.retryGoalTask, {
    label: "retry goal task",
  });

  const navigate = useNavigate();
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  // A finished goal stays visible so its result can be read; hiding it is a
  // session choice, not a server change.
  const [hiddenGoalIds, setHiddenGoalIds] = useState<ReadonlySet<string>>(new Set());
  const [objective, setObjective] = useState("");
  const [editText, setEditText] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [allTasksOpen, setAllTasksOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const nowMinute = useNowMinute();

  const goals = useMemo(
    () =>
      [...(goalsQuery.data?.goals ?? [])]
        .filter((candidate) => !hiddenGoalIds.has(candidate.id))
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [goalsQuery.data, hiddenGoalIds],
  );
  const goal =
    goals.find((candidate) => candidate.id === selectedGoalId) ??
    selectGoalForThread(goals, props.threadId);
  const otherGoals = goals.filter((candidate) => candidate.id !== goal?.id);

  if (projectId === null) return null;
  if (goal === null && !props.composerOpen) return null;

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
  };

  const run = async <A, E>(
    title: string,
    effect: () => Promise<AtomCommandResult<A, E>>,
    onSuccess?: (value: A) => void,
  ) => {
    if (busy) return;
    setBusy(true);
    const result = await effect();
    setBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      reportFailure(title, squashAtomCommandFailure(result));
      return;
    }
    onSuccess?.(result.value);
  };

  const startGoal = () => {
    const text = objective.trim();
    if (text === "" || props.modelSelection === null) return;
    void run(
      "Could not start the goal",
      () =>
        createGoal({
          environmentId,
          input: {
            projectId,
            threadId: props.threadId,
            objective: text,
            modelSelection: props.modelSelection as ModelSelection,
            runtimeMode: props.runtimeMode,
            interactionMode: props.interactionMode,
          },
        }),
      (created) => {
        setObjective("");
        setSelectedGoalId(created.goal.id);
        props.onComposerOpenChange(false);
      },
    );
  };

  const progress = goal === null ? null : goalProgress(goal);
  const tone = goal === null ? "muted" : goalStatusTone(goal.status);
  const active = goal === null ? false : isGoalActive(goal.status);
  const attention = goal === null ? false : goalNeedsAttention(goal.status);
  const current = goal === null ? null : currentGoalTask(goal);
  const tasks = goal?.tasks ?? [];
  const hiddenTasks = allTasksOpen ? 0 : Math.max(0, tasks.length - VISIBLE_TASK_LIMIT);
  const shownTasks = allTasksOpen ? tasks : tasks.slice(0, VISIBLE_TASK_LIMIT);
  const activities =
    goal === null ? [] : goal.activities.toReversed().slice(0, VISIBLE_ACTIVITY_LIMIT);
  const now = Date.parse(`${nowMinute}:00.000Z`);

  return (
    <div
      data-goal-mode-panel="true"
      className="pointer-events-auto mb-2 overflow-hidden rounded-2xl border border-border/60 bg-card/80 text-card-foreground shadow-sm backdrop-blur-xl"
    >
      {props.composerOpen || goal === null ? (
        <div className="p-3.5">
          <div className="flex items-center gap-2">
            <TargetIcon aria-hidden className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">What should I accomplish?</span>
            {goal === null ? null : (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Close the goal form"
                className="ml-auto"
                onClick={() => props.onComposerOpenChange(false)}
              >
                <XIcon aria-hidden className="size-3.5" />
              </Button>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Describe the outcome. The agent plans the steps, does the work, runs checks and keeps
            going until it can prove the goal is done. You can pause or change it at any time.
          </p>
          <Textarea
            autoFocus
            aria-label="Goal description"
            placeholder="Describe your goal…"
            rows={3}
            value={objective}
            className="mt-2.5 min-h-16 resize-none"
            onChange={(event) => setObjective(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                startGoal();
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-2xs text-muted-foreground">
              {props.modelSelection === null
                ? "Pick a model to start a goal"
                : !canOperate
                  ? "This connection cannot start goals"
                  : goal === null
                    ? "Goal mode enabled · plans, executes, verifies"
                    : "Your current goal keeps running while you write this one"}
            </span>
            <Button
              size="sm"
              disabled={
                busy || !canOperate || props.modelSelection === null || objective.trim() === ""
              }
              onClick={startGoal}
            >
              Start goal
              <ArrowRightIcon aria-hidden className="size-3.5" />
            </Button>
          </div>
          {goalsQuery.error !== null ? (
            <p className="mt-2 text-2xs text-destructive">
              Could not load goals: {goalsQuery.error}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2 px-3.5 pt-3">
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand goal details" : "Collapse goal details"}
              className="mt-0.5 shrink-0 rounded-md text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setCollapsed((value) => !value)}
            >
              <TargetIcon aria-hidden className="size-4" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="truncate text-sm font-semibold">{goal.title}</h3>
                <GoalStatusPill goal={goal} />
              </div>
              <p
                className={cn(
                  "mt-0.5 truncate text-xs",
                  attention ? "text-warning" : "text-muted-foreground",
                )}
              >
                {goalHeadline(goal)}
              </p>
            </div>
            <div className="flex items-center gap-0.5">
              {goal.threadId !== null && goal.threadId !== props.threadId ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Open the goal's thread"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(environmentId, goal.threadId as ThreadId),
                      ),
                    })
                  }
                >
                  <ExternalLinkIcon aria-hidden className="size-3.5" />
                </Button>
              ) : null}
              {active ? null : (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Hide this finished goal"
                  onClick={() => setHiddenGoalIds((hidden) => new Set([...hidden, goal.id]))}
                >
                  <XIcon aria-hidden className="size-3.5" />
                </Button>
              )}
              {otherGoals.length > 0 ? (
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Show ${otherGoals.length} other goals`}
                      />
                    }
                  >
                    <ListTreeIcon aria-hidden className="size-3.5" />
                  </PopoverTrigger>
                  <PopoverPopup align="end" className="w-64">
                    <p className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                      Other goals
                    </p>
                    {otherGoals.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                        onClick={() => {
                          setSelectedGoalId(candidate.id);
                          setCollapsed(false);
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {goalStatusLabel(candidate.status)}
                        </span>
                      </button>
                    ))}
                  </PopoverPopup>
                </Popover>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Start another goal"
                disabled={!canOperate}
                onClick={() => {
                  setSelectedGoalId(null);
                  props.onComposerOpenChange(true);
                }}
              >
                <PlusIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          </div>

          {progress === null ? null : (
            <div className="px-3.5 pt-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xl font-semibold tabular-nums leading-6">
                  {progress.percent}%
                </span>
                <span className="text-2xs text-muted-foreground">
                  {progress.completed} of {progress.total} {progress.total === 1 ? "task" : "tasks"}{" "}
                  completed
                </span>
              </div>
              <div
                role="progressbar"
                aria-label="Goal progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent}
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
              >
                {/* scaleX keeps the growth on the compositor instead of
                    re-laying out the row on every percent step. */}
                <div
                  className={cn(
                    "h-full w-full origin-left rounded-full transition-transform duration-500 ease-out",
                    TONE_BAR[tone],
                  )}
                  style={{ transform: `scaleX(${progress.percent / 100})` }}
                />
              </div>
            </div>
          )}

          {collapsed ? null : (
            <>
              {shownTasks.length > 0 ? (
                <ul className="mt-2.5 list-none space-y-0 px-3.5">
                  {shownTasks.map((task, index) => {
                    const last = index === shownTasks.length - 1 && hiddenTasks === 0;
                    const isCurrent = current?.id === task.id && task.status !== "completed";
                    return (
                      <li key={task.id} className="flex gap-2.5">
                        <span className="relative flex w-4 shrink-0 justify-center pt-0.5">
                          <GoalTaskIcon task={task} />
                          {last ? null : (
                            <span
                              aria-hidden
                              className="absolute top-4.5 bottom-0 w-px bg-border"
                            />
                          )}
                        </span>
                        <div className="min-w-0 flex-1 pb-2">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "min-w-0 truncate text-xs font-medium",
                                task.status === "pending"
                                  ? "text-muted-foreground"
                                  : "text-foreground",
                              )}
                            >
                              {task.title}
                            </span>
                            {isCurrent && goal.status === "running" ? (
                              <span className="shrink-0 text-2xs text-info">now</span>
                            ) : null}
                            {canOperate &&
                            (task.status === "failed" || task.status === "blocked") &&
                            !busy ? (
                              <button
                                type="button"
                                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                                aria-label={`Retry ${task.title}`}
                                onClick={() =>
                                  void run("Could not retry the task", () =>
                                    retryGoalTask({
                                      environmentId,
                                      input: { id: goal.id, taskId: task.id },
                                    }),
                                  )
                                }
                              >
                                <RotateCcwIcon aria-hidden className="size-3" />
                              </button>
                            ) : null}
                          </div>
                          <p className="truncate text-2xs text-muted-foreground">
                            {task.evidence ?? goalTaskStatusLabel(task.status)}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-3.5 pt-2 text-xs text-muted-foreground">
                  The plan appears as soon as the agent finishes planning.
                </p>
              )}

              {hiddenTasks > 0 || allTasksOpen ? (
                <button
                  type="button"
                  className="mx-3.5 mb-1 text-2xs text-muted-foreground hover:text-foreground"
                  onClick={() => setAllTasksOpen((value) => !value)}
                >
                  {allTasksOpen ? "Show fewer tasks" : `Show ${hiddenTasks} more tasks`}
                </button>
              ) : null}

              {goal.status === "needs_input" ? (
                <div className="mx-3.5 mb-2 rounded-xl border border-warning/30 bg-warning/5 p-2">
                  <p className="text-xs text-foreground">{goal.blockedReason}</p>
                  <div className="mt-1.5 flex items-end gap-1.5">
                    <Textarea
                      aria-label="Answer the agent's question"
                      placeholder="Your answer…"
                      rows={1}
                      value={answerText}
                      className="min-h-8 resize-none"
                      onChange={(event) => setAnswerText(event.target.value)}
                    />
                    <Button
                      size="xs"
                      disabled={!canOperate || busy || answerText.trim() === ""}
                      onClick={() =>
                        void run(
                          "Could not send the answer",
                          () =>
                            answerGoal({
                              environmentId,
                              input: { id: goal.id, text: answerText.trim() },
                            }),
                          () => setAnswerText(""),
                        )
                      }
                    >
                      Send
                    </Button>
                  </div>
                </div>
              ) : null}

              {editText !== null ? (
                <div className="mx-3.5 mb-2 rounded-xl border border-border/60 p-2">
                  <Textarea
                    autoFocus
                    aria-label="Edit the goal"
                    rows={3}
                    value={editText}
                    className="min-h-16 resize-none"
                    onChange={(event) => setEditText(event.target.value)}
                  />
                  <p className="mt-1 text-2xs text-muted-foreground">
                    Completed work is kept; the agent revises what remains.
                  </p>
                  <div className="mt-1.5 flex justify-end gap-1.5">
                    <Button size="xs" variant="ghost" onClick={() => setEditText(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      disabled={!canOperate || busy || editText.trim() === ""}
                      onClick={() =>
                        void run(
                          "Could not update the goal",
                          () =>
                            updateGoal({
                              environmentId,
                              input: { id: goal.id, objective: editText.trim() },
                            }),
                          () => setEditText(null),
                        )
                      }
                    >
                      Save changes
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-2 border-t border-border/60 px-2 py-1.5">
                <div className="flex items-center gap-0.5">
                  {active && goal.status !== "needs_input" && goal.status !== "paused" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!canOperate || busy}
                      onClick={() =>
                        void run("Could not pause the goal", () =>
                          pauseGoal({ environmentId, input: { id: goal.id } }),
                        )
                      }
                    >
                      <PauseIcon aria-hidden className="size-3.5" />
                      Pause
                    </Button>
                  ) : null}
                  {/* Paused counts as active for the panel, so Resume needs its
                      own door: a paused goal must be startable again. */}
                  {!active || goal.status === "paused" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={
                        !canOperate ||
                        busy ||
                        goal.status === "completed" ||
                        goal.status === "cancelled"
                      }
                      onClick={() =>
                        void run("Could not resume the goal", () =>
                          resumeGoal({ environmentId, input: { id: goal.id } }),
                        )
                      }
                    >
                      <PlayIcon aria-hidden className="size-3.5" />
                      Resume
                    </Button>
                  ) : null}
                  {goal.status !== "completed" &&
                  goal.status !== "cancelled" &&
                  editText === null ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!canOperate || busy}
                      onClick={() => setEditText(goal.objective)}
                    >
                      <PencilIcon aria-hidden className="size-3.5" />
                      Edit
                    </Button>
                  ) : null}
                  {goal.status !== "completed" && goal.status !== "cancelled" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!canOperate || busy}
                      onClick={() => setCancelOpen(true)}
                    >
                      <XIcon aria-hidden className="size-3.5" />
                      Cancel
                    </Button>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className="hidden text-2xs text-muted-foreground sm:inline">
                    {formatGoalActivityTime(goal.lastActivityAt, now)}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setActivityOpen((value) => !value)}
                  >
                    {activityOpen ? "Hide activity" : "View activity"}
                    {activityOpen ? (
                      <ChevronUpIcon aria-hidden className="size-3.5" />
                    ) : (
                      <ChevronDownIcon aria-hidden className="size-3.5" />
                    )}
                  </Button>
                </div>
              </div>

              {activityOpen ? (
                <div className="max-h-56 overflow-y-auto border-t border-border/60 bg-muted/20 px-3.5 py-2">
                  <ol className="list-none space-y-1.5">
                    {activities.length === 0 ? (
                      <li className="text-2xs text-muted-foreground">No activity yet.</li>
                    ) : (
                      activities.map((activity) => (
                        <li key={activity.id} className="flex gap-2">
                          <span className="w-14 shrink-0 pt-px text-3xs tabular-nums text-muted-foreground/70">
                            {formatGoalActivityTime(activity.at, now)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-2xs text-foreground/90">{activity.summary}</p>
                            {activity.detail === null ? null : (
                              <p className="line-clamp-2 text-3xs text-muted-foreground">
                                {activity.detail}
                              </p>
                            )}
                          </div>
                        </li>
                      ))
                    )}
                  </ol>
                  {goal.verification.summary === null ? null : (
                    <p className="mt-2 border-t border-border/50 pt-1.5 text-3xs text-muted-foreground">
                      Verification ({goal.verification.status}): {goal.verification.summary}
                    </p>
                  )}
                </div>
              ) : null}
            </>
          )}
        </>
      )}

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this goal?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent stops working on it and its remaining tasks are dropped. Work already done
              in the thread stays where it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Keep it
            </AlertDialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={!canOperate || busy}
              onClick={() => {
                setCancelOpen(false);
                if (goal === null) return;
                void run("Could not cancel the goal", () =>
                  cancelGoal({ environmentId, input: { id: goal.id } }),
                );
              }}
            >
              Cancel goal
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
