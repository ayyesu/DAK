import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@dak/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GoalProof,
  GoalSummary,
  GoalTask,
  ProjectId,
  RunId,
  ThreadId,
} from "@dak/contracts";
import { scopeThreadRef } from "@dak/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  EyeIcon,
  ExternalLinkIcon,
  HistoryIcon,
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
import { useEffect, useMemo, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { TurnDiffSummary } from "../../types";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { onOpenGoalComposer, onOpenGoalWork } from "../../goalModeBus";
import { GoalBlockerPanel } from "./GoalBlockerPanel";
import { GoalChangedFiles } from "./GoalChangedFiles";
import { goalChangedFiles } from "./GoalChanges.logic";
import { GoalWorkView } from "./GoalWorkView";
import {
  canCancelGoal,
  canEditGoal,
  canPauseGoal,
  canResumeGoal,
  canRetryGoal,
  currentGoalTask,
  formatGoalActivityTime,
  formatGoalTurnElapsed,
  goalCriterionStates,
  goalHasOpenQuestion,
  goalMetaLine,
  goalNeedsAttention,
  goalObjectiveText,
  goalProgress,
  goalProgressLabel,
  goalSummaryHeadline,
  goalSummaryProgress,
  goalStatusLabel,
  goalStatusTone,
  goalTaskStatusLabel,
  goalVerificationStatusLabel,
  goalWaitingTask,
  isGoalActive,
  isGoalDriven,
  selectGoalForThread,
  type GoalTone,
} from "./GoalMode.logic";

/** Tasks shown before the list folds; a long plan must not swallow the chat. */
const VISIBLE_TASK_LIMIT = 5;
const VISIBLE_ACTIVITY_LIMIT = 12;
/** Acceptance criteria fold earlier than tasks; four is enough to read at a glance. */
const VISIBLE_CRITERIA_LIMIT = 4;

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

type GoalRun = <A, E>(
  title: string,
  effect: () => Promise<AtomCommandResult<A, E>>,
  onSuccess?: (value: A) => void,
) => Promise<void>;

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
  if (task.status === "recovering") {
    return <RotateCcwIcon aria-hidden className="size-4 text-info" />;
  }
  if (task.status === "waiting_input" || task.status === "failed") {
    return <TriangleAlertIcon aria-hidden className="size-4 text-warning" />;
  }
  return <CircleIcon aria-hidden className="size-4 text-muted-foreground/40" />;
}

function GoalCriterionIcon({ met }: { readonly met: boolean | null }) {
  if (met === true) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <CheckIcon aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (met === false) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <XIcon aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    );
  }
  return <CircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/40" />;
}

/** One piece of rich proof: an image, screenshot, canvas export, or link to test/run output. */
function GoalCriterionProof({ proof }: { readonly proof: GoalProof }) {
  const isImage = proof.type === "image" || proof.type === "screenshot" || proof.type === "canvas";
  return (
    <div className="flex flex-col gap-1 pt-1">
      {isImage ? (
        <img
          src={proof.thumbnailUrl ?? proof.url}
          alt={proof.caption ?? "proof"}
          className="max-w-[200px] max-h-[120px] rounded-md border border-border/50 object-cover cursor-pointer"
        />
      ) : (
        <a
          href={proof.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary underline-offset-4 hover:text-primary/80"
        >
          {(proof.caption ?? proof.type === "test")
            ? "Test results"
            : proof.type === "check"
              ? "Check output"
              : proof.type === "run"
                ? "Run output"
                : "Proof"}
        </a>
      )}
      {proof.caption !== null && !isImage ? (
        <p className="text-3xs text-muted-foreground">{proof.caption}</p>
      ) : null}
    </div>
  );
}

function GoalStatusPill({ goal }: { readonly goal: GoalSummary }) {
  const tone = goalStatusTone(goal.status);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium leading-4",
        TONE_PILL[tone],
      )}
    >
      {isGoalDriven(goal.status) ? <Spinner aria-hidden size="xs" /> : null}
      {goalStatusLabel(goal.status)}
    </span>
  );
}

/**
 * Age of the in-flight turn, ticking once a second like GitActionElapsedTime;
 * only the leaf re-renders, so the card commits nothing per tick.
 */
function GoalTurnElapsed({ startedAt }: { readonly startedAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, []);
  return (
    <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">
      {formatGoalTurnElapsed(startedAt, nowMs)}
    </span>
  );
}

/**
 * One goal's card. Keyed by goal id by the panel, so edit, answer and drawer
 * state never leaks from one goal into the next.
 */
function GoalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly goal: GoalSummary;
  readonly otherGoals: ReadonlyArray<GoalSummary>;
  readonly canOperate: boolean;
  readonly busy: boolean;
  /** The composer above is open; the card stays compact until it closes. */
  readonly compact: boolean;
  /** The island opened this thread's dedicated goal-work surface. */
  readonly showWork: boolean;
  readonly onCloseWork: () => void;
  readonly run: GoalRun;
  /** The thread's changed files, for the goal's own file summary. */
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  /** Opens the diff panel on a turn's file. */
  readonly onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  readonly onHide: () => void;
  readonly onSelectOther: (goalId: GoalSummary["id"]) => void;
  readonly onStartAnother: () => void;
}) {
  const { environmentId, goal, canOperate, busy } = props;
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
  const [collapsedState, setCollapsedState] = useState(() => props.compact);
  const [editText, setEditText] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  // The goal's work is read on demand: the card keeps the status, and the eye
  // opens the run of turns it took.
  const [workOpen, setWorkOpen] = useState(false);
  const [allTasksOpen, setAllTasksOpen] = useState(false);
  const [allCriteriaOpen, setAllCriteriaOpen] = useState(false);
  const [otherGoalsOpen, setOtherGoalsOpen] = useState(false);
  const nowMinute = useNowMinute();

  useEffect(() => {
    if (!props.showWork) return;
    setCollapsedState(false);
    setWorkOpen(true);
  }, [props.showWork]);

  const collapsed = collapsedState;
  const expanded = !collapsed;
  // The detail is built for a goal somebody is looking at. A collapsed card
  // shows the summary the live list already carries, and an open card opens
  // the goal's own stream, so the server never builds a detail payload that
  // nobody reads. The subscription atom keeps its last value for its idle
  // TTL, so re-opening shows the plan instead of an empty flash.
  const watchQuery = useEnvironmentQuery(
    expanded ? serverEnvironment.goalWatch({ environmentId, input: { id: goal.id } }) : null,
  );
  const goalDetail = expanded ? (watchQuery.data?.goal ?? null) : null;

  // Every mutation changes the goal, and the goal's own stream pushes the
  // change, so the card reads the new state instead of waiting for it.
  const run: GoalRun = async (title, effect, onSuccess) => {
    await props.run(title, effect, (value) => {
      onSuccess?.(value);
    });
  };

  const progress = goalDetail ? goalProgress(goalDetail) : goalSummaryProgress(goal);
  const tone = goalStatusTone(goal.status);
  const attention = goalNeedsAttention(goal.status) || goalHasOpenQuestion(goal);
  const active = isGoalActive(goal.status);
  const current = goalDetail ? currentGoalTask(goalDetail) : null;
  const waitingTask = goalDetail ? goalWaitingTask(goalDetail) : null;
  const tasks = goalDetail?.tasks ?? [];
  const hiddenTasks = allTasksOpen ? 0 : Math.max(0, tasks.length - VISIBLE_TASK_LIMIT);
  const shownTasks = allTasksOpen ? tasks : tasks.slice(0, VISIBLE_TASK_LIMIT);
  const activities = (goalDetail?.activities ?? []).toReversed().slice(0, VISIBLE_ACTIVITY_LIMIT);
  const criteria = goalDetail ? goalCriterionStates(goalDetail) : [];
  const shownCriteria = allCriteriaOpen ? criteria : criteria.slice(0, VISIBLE_CRITERIA_LIMIT);
  const hiddenCriteria = allCriteriaOpen
    ? 0
    : Math.max(0, criteria.length - VISIBLE_CRITERIA_LIMIT);
  const verification = goalDetail?.verification ?? {
    status: "pending" as const,
    summary: null,
    checkedAt: null,
  };
  const showVerification =
    goalDetail !== null && (verification.status !== "pending" || criteria.length > 0);
  const now = Date.parse(`${nowMinute}:00.000Z`);

  // The full reason replaces the headline: the headline truncates, and the
  // same sentence twice reads like a bug.
  const reasonBox =
    goal.status === "failed" && goal.failureReason !== null
      ? { text: goal.failureReason, tone: "danger" as const }
      : goal.status === "waiting_provider" && goal.waitingReason !== null
        ? { text: goal.waitingReason, tone: "attention" as const }
        : null;

  // The agent's question is asked of the user, so it shows whether the goal
  // is running other work or parked on the answer.
  const question = goal.question ?? goalDetail?.question ?? null;
  // The user asked for this in their own words; the server's title is a
  // summary of it.
  const objective = goalDetail === null ? null : goalObjectiveText(goalDetail);
  const meta = goalDetail === null ? null : goalMetaLine(goalDetail);
  // The file changes belong to the goal's own thread; another thread's
  // checkpoints would describe work this goal never did.
  const showChanges = goal.threadId !== null && goal.threadId === props.threadId;
  const changes = goalChangedFiles({
    summaries: showChanges ? props.turnDiffSummaries : [],
    startedAt: goalDetail?.startedAt ?? null,
  });
  return (
    <>
      {/* The title row and the bar stay pinned while the details scroll under
          them; the card is the scroll container, so a long plan can never push
          the composer down. */}
      <div className="sticky top-0 z-10 shrink-0 bg-card/90 backdrop-blur-xl">
        <div className="flex shrink-0 items-start gap-2 px-3.5 pt-3">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand goal details" : "Collapse goal details"}
            className="mt-0.5 shrink-0 rounded-md text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setCollapsedState((value) => !value)}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-4 transition-transform duration-200 ease-out motion-reduce:transition-none",
                !collapsed && "rotate-180",
              )}
            />
          </button>
          <TargetIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold">{goal.title}</h3>
              <GoalStatusPill goal={goal} />
              {isGoalDriven(goal.status) && goal.turnStartedAt !== null ? (
                <GoalTurnElapsed startedAt={goal.turnStartedAt} />
              ) : null}
            </div>
            {reasonBox === null ? (
              <p
                aria-live="polite"
                className={cn(
                  "mt-0.5 truncate text-xs",
                  attention ? "text-warning" : "text-muted-foreground",
                )}
              >
                {goalSummaryHeadline(goal)}
              </p>
            ) : null}
            {objective === null ? null : (
              <p className="mt-0.5 line-clamp-2 text-2xs leading-4 text-muted-foreground/80">
                {objective}
              </p>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Show the goal's work"
              aria-pressed={workOpen}
              onClick={() => {
                // The work is read from the goal's own stream, so the card
                // opens to fetch it.
                setCollapsedState(false);
                setWorkOpen((value) => !value);
              }}
            >
              <EyeIcon aria-hidden className="size-3.5" />
            </Button>
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
                onClick={props.onHide}
              >
                <XIcon aria-hidden className="size-3.5" />
              </Button>
            )}
            {props.otherGoals.length > 0 ? (
              <Popover open={otherGoalsOpen} onOpenChange={setOtherGoalsOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Show ${props.otherGoals.length} other goals`}
                    />
                  }
                >
                  <ListTreeIcon aria-hidden className="size-3.5" />
                </PopoverTrigger>
                <PopoverPopup align="end" className="w-64">
                  <p className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                    Other goals
                  </p>
                  {props.otherGoals.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                      onClick={() => {
                        // The list is a picker: staying open over the card it
                        // just replaced reads as a menu that ignored the click.
                        setOtherGoalsOpen(false);
                        props.onSelectOther(candidate.id);
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
              onClick={props.onStartAnother}
            >
              <PlusIcon aria-hidden className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="px-3.5 pt-2">
          <div
            role="progressbar"
            aria-label="Goal progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            className="h-1 overflow-hidden rounded-full bg-muted"
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
      </div>

      {reasonBox === null ? null : (
        <div
          aria-live="polite"
          className={cn(
            "mx-3.5 mt-2.5 flex shrink-0 gap-2 rounded-xl border p-2",
            reasonBox.tone === "danger"
              ? "border-destructive/30 bg-destructive/5"
              : "border-warning/30 bg-warning/5",
          )}
        >
          <TriangleAlertIcon
            aria-hidden
            className={cn(
              "mt-px size-3.5 shrink-0",
              reasonBox.tone === "danger" ? "text-destructive" : "text-warning",
            )}
          />
          <p className="line-clamp-3 min-w-0 text-xs leading-5 text-foreground">{reasonBox.text}</p>
        </div>
      )}

      {/* The agent's question stays outside the fold: it asks the user for an
          answer, so it must not hide behind a collapsed card. */}
      {question !== null ? (
        <div className="mx-3.5 mt-2.5 rounded-xl border border-warning/30 bg-warning/5 p-2">
          <p className="text-xs text-foreground">{question}</p>
          {waitingTask === null ? null : (
            <p className="mt-0.5 text-2xs text-muted-foreground">
              Answering resumes “{waitingTask.title}”. The rest of the plan keeps going.
            </p>
          )}
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

      {/* The goal's work is read on demand: the eye opens it here, inside the
          card, so the chat above keeps its own shape. */}
      {workOpen ? (
        <GoalWorkView
          title={goal.title}
          activities={activities}
          now={now}
          loading={goalDetail === null && watchQuery.error === null}
          error={watchQuery.error}
          onBack={() => {
            setWorkOpen(false);
            props.onCloseWork();
          }}
          {...(goal.threadId === null
            ? {}
            : {
                onOpenThread: () =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(environmentId, goal.threadId as ThreadId),
                    ),
                  }),
              })}
        />
      ) : (
        /* The details fold away with a height transition instead of blinking
            out; the card itself scrolls, so a long plan never pushes the
            composer down. */
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
            collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
          )}
          inert={collapsed ? true : undefined}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-col">
              <div className="flex items-baseline justify-between gap-2 px-3.5 pt-2">
                <span className="text-xl font-semibold tabular-nums leading-6">
                  {progress.percent}%
                </span>
                <span className="text-2xs text-muted-foreground">
                  {goalProgressLabel(progress)}
                </span>
              </div>
              {meta === null ? null : (
                <p className="truncate px-3.5 pt-0.5 text-2xs text-muted-foreground/80">{meta}</p>
              )}
              {watchQuery.error === null ? null : (
                <p className="px-3.5 pt-1 text-2xs text-destructive">{watchQuery.error}</p>
              )}
              {/* The agent's assessment of what is in the way. It is evidence
                  it keeps working with, not a verdict: the goal carries on. */}
              {current?.blocker == null ? null : (
                <div className="mx-3.5 mt-2.5 overflow-y-auto">
                  <GoalBlockerPanel
                    blocker={current.blocker}
                    className="max-h-40 overflow-y-auto"
                  />
                </div>
              )}
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
                            canRetryGoal(goal.status) &&
                            (task.status === "failed" || task.status === "waiting_input") &&
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
                          {task.question === null || task.question === question ? null : (
                            <p className="mt-0.5 line-clamp-2 text-2xs leading-4 text-warning">
                              {task.question}
                            </p>
                          )}
                          {task.blocker === null ? null : (
                            <p className="mt-0.5 line-clamp-2 text-2xs leading-4 text-destructive/90">
                              {task.blocker.reason}
                            </p>
                          )}
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

              {showChanges ? (
                <GoalChangedFiles changes={changes} onOpenTurnDiff={props.onOpenTurnDiff} />
              ) : null}

              {showVerification ? (
                <div className="px-3.5 pb-1 pt-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-2xs font-medium text-muted-foreground">Done when</span>
                    {verification.status === "pending" ? null : (
                      <span
                        className={cn(
                          "text-2xs font-medium",
                          verification.status === "passed" ? "text-success" : "text-destructive",
                        )}
                      >
                        {goalVerificationStatusLabel(verification.status)}
                      </span>
                    )}
                  </div>
                  {verification.summary !== null && verification.status !== "pending" ? (
                    <p className="mt-0.5 text-2xs text-muted-foreground">{verification.summary}</p>
                  ) : null}
                  {criteria.length > 0 ? (
                    <ul className="mt-1 list-none space-y-1">
                      {shownCriteria.map((criterion) => (
                        <li key={criterion.criterion} className="flex flex-col gap-2">
                          <div className="flex items-start gap-2">
                            <GoalCriterionIcon met={criterion.met} />
                            <span
                              className={cn(
                                "min-w-0 text-xs leading-4",
                                criterion.met === false
                                  ? "text-destructive"
                                  : criterion.met === true
                                    ? "text-foreground"
                                    : "text-muted-foreground",
                              )}
                            >
                              {criterion.criterion}
                            </span>
                          </div>
                          {criterion.proof.length > 0 ? (
                            <div className="ml-8 flex flex-col gap-1">
                              {criterion.proof.map((proof) => (
                                <GoalCriterionProof
                                  key={`${proof.type}:${proof.url}`}
                                  proof={proof}
                                />
                              ))}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {hiddenCriteria > 0 || allCriteriaOpen ? (
                    <button
                      type="button"
                      className="mt-1 text-2xs text-muted-foreground hover:text-foreground"
                      onClick={() => setAllCriteriaOpen((value) => !value)}
                    >
                      {allCriteriaOpen
                        ? "Show fewer criteria"
                        : `Show ${hiddenCriteria} more criteria`}
                    </button>
                  ) : null}
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
                    {!canPauseGoal(goal.status) ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!canOperate || busy || editText.trim() === ""}
                        onClick={() =>
                          void run(
                            "Could not update the goal",
                            () =>
                              updateGoal({
                                environmentId,
                                input: { id: goal.id, objective: editText.trim() },
                              }),
                            () => {
                              setEditText(null);
                              void run("Could not resume the goal", () =>
                                resumeGoal({ environmentId, input: { id: goal.id } }),
                              );
                            },
                          )
                        }
                      >
                        Save & resume
                      </Button>
                    ) : null}
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
            </div>
          </div>
        </div>
      )}

      <div className="sticky bottom-0 z-10 flex shrink-0 items-center justify-between gap-2 border-t border-border/60 bg-card/90 px-2 py-1.5 backdrop-blur-xl">
        <div className="flex items-center gap-0.5">
          {canPauseGoal(goal.status) ? (
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
          {canResumeGoal(goal.status) ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperate || busy}
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
          {canEditGoal(goal.status) && editText === null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    // The objective only arrives with the goal's details, so
                    // editing before they land would open an empty goal.
                    disabled={!canOperate || busy || goalDetail === null}
                    onClick={() => {
                      // The editor lives in the folded region, so opening it
                      // has to bring the card back.
                      setCollapsedState(false);
                      setEditText(goalDetail?.objective ?? "");
                    }}
                  />
                }
              >
                <PencilIcon aria-hidden className="size-3.5" />
                Edit
              </TooltipTrigger>
              <TooltipPopup side="top">
                {goalDetail === null ? "Loading the goal…" : "Change what the goal is for"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {canCancelGoal(goal.status) ? (
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
        </div>
      </div>

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
    </>
  );
}

/**
 * Goal Mode lives above the composer: a goal the server is driving stays
 * visible here. The composer's Goal control owns writing the next goal; this
 * panel only shows and manages what exists.
 */
export function GoalModePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly canOperate: boolean;
  /** The composer below is in Goal Mode; the card stays compact until it closes. */
  readonly goalModeOpen: boolean;
  /** A goal is actively being driven; the card stays collapsed above the input. */
  readonly goalIsDriven: boolean;
  readonly onGoalModeOpenChange: (open: boolean) => void;
  /** The goal this panel's thread just started; selects it for display. */
  readonly focusGoalId: string | null;
  /** The thread's changed files, so a goal can report what it changed. */
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  /** Opens the diff panel on a turn's file. */
  readonly onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const { environmentId, projectId } = props;
  const canOperateGoal = useAtomValue(serverEnvironment.createGoal.permissionAtom(environmentId));
  const canOperate = props.canOperate && canOperateGoal;
  const goalIsDriven = props.goalIsDriven;
  const goalsQuery = useEnvironmentQuery(
    projectId === null
      ? null
      : serverEnvironment.goalsLive({ environmentId, input: { projectId } }),
  );

  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  // A finished goal stays visible so its result can be read; hiding it is a
  // session choice, not a server change.
  const [hiddenGoalIds, setHiddenGoalIds] = useState<ReadonlySet<string>>(new Set());
  const [hiddenGoalsOpen, setHiddenGoalsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [goalWorkOpen, setGoalWorkOpen] = useState(false);

  // The selection belongs to one thread; switching threads must not keep
  // showing the previous thread's goal.
  useEffect(() => {
    setSelectedGoalId(null);
  }, [props.threadId]);

  // Starting a goal happens in the composer; surface the one it just created.
  useEffect(() => {
    if (props.focusGoalId !== null) setSelectedGoalId(props.focusGoalId);
  }, [props.focusGoalId]);

  // The palette and the chat.key command ask for Goal Mode without owning its
  // state; subscribe here, next to the consumer.
  useEffect(() => onOpenGoalComposer(() => props.onGoalModeOpenChange(true)), [props]);
  useEffect(
    () =>
      onOpenGoalWork((goalId) => {
        setSelectedGoalId(goalId);
        setGoalWorkOpen(true);
      }),
    [],
  );

  const allGoals = useMemo(
    () =>
      [...(goalsQuery.data?.goals ?? [])].toSorted((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    [goalsQuery.data],
  );
  const goals = useMemo(
    () => allGoals.filter((candidate) => !hiddenGoalIds.has(candidate.id)),
    [allGoals, hiddenGoalIds],
  );
  const hiddenGoals = useMemo(
    () => allGoals.filter((candidate) => hiddenGoalIds.has(candidate.id)),
    [allGoals, hiddenGoalIds],
  );
  const goal =
    goals.find((candidate) => candidate.id === selectedGoalId) ??
    selectGoalForThread(goals, props.threadId);
  const otherGoals = goals.filter((candidate) => candidate.id !== goal?.id);

  if (projectId === null || !goalWorkOpen) return null;
  // Hiding the last goal must not take the panel away with it: the hidden
  // goals are the only way back to them.
  if (goal === null && goalsQuery.error === null && hiddenGoals.length === 0) return null;

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
  };

  // One flag for the whole panel: starting a goal and the card's controls
  // never race each other.
  const run: GoalRun = async (title, effect, onSuccess) => {
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

  return (
    <div
      data-goal-mode-panel="true"
      role="region"
      aria-label="Goal mode"
      className="pointer-events-auto mb-2 flex max-h-[min(30rem,45dvh)] flex-col overflow-y-auto rounded-2xl border border-border/60 bg-card/80 text-card-foreground shadow-sm backdrop-blur-xl"
    >
      {goal === null ? null : (
        <GoalCard
          key={goal.id}
          environmentId={environmentId}
          threadId={props.threadId}
          goal={goal}
          otherGoals={otherGoals}
          canOperate={canOperate}
          busy={busy}
          compact={props.goalModeOpen || goalIsDriven}
          showWork={goalWorkOpen}
          onCloseWork={() => setGoalWorkOpen(false)}
          run={run}
          turnDiffSummaries={props.turnDiffSummaries}
          onOpenTurnDiff={props.onOpenTurnDiff}
          onHide={() => setHiddenGoalIds((hidden) => new Set([...hidden, goal.id]))}
          onSelectOther={(goalId) => setSelectedGoalId(goalId)}
          onStartAnother={() => {
            setSelectedGoalId(null);
            props.onGoalModeOpenChange(true);
          }}
        />
      )}

      {hiddenGoals.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3.5 py-1.5">
          <Popover open={hiddenGoalsOpen} onOpenChange={setHiddenGoalsOpen}>
            <PopoverTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Show ${hiddenGoals.length} hidden goals`}
                />
              }
            >
              <HistoryIcon aria-hidden className="size-3.5" />
              {hiddenGoals.length} hidden goal{hiddenGoals.length === 1 ? "" : "s"}
            </PopoverTrigger>
            <PopoverPopup align="start" className="w-64">
              {hiddenGoals.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={() => {
                    setHiddenGoalsOpen(false);
                    setHiddenGoalIds((hidden) => {
                      const next = new Set(hidden);
                      next.delete(candidate.id);
                      return next;
                    });
                    setSelectedGoalId(candidate.id);
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
        </div>
      ) : null}

      {goalsQuery.error !== null ? (
        <p
          className={cn(
            "shrink-0 px-3.5 pb-2.5 text-2xs text-destructive",
            goal === null && "pt-2.5",
          )}
        >
          Could not load goals: {goalsQuery.error}
        </p>
      ) : null}
    </div>
  );
}
