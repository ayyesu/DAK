# Goal mode

Goal mode gives the agent an outcome instead of a prompt. You describe what
should be true when it is finished, and the agent plans the steps, does the
work, and checks the result before reporting success.

## Starting a goal

In the message composer, type `/goal` followed by a space, then write the
outcome — for example `/goal Add per-channel notification settings with tests`.
After the space, the composer shows a goal-mode hint bar (`/goal` chip +
“Describe the outcome…”) and a **Done when** criteria field appears below
the prompt; the send button reads **Start goal**. The same composer is the
goal input — there is no separate goal form, and the provider’s native
`/goal` command is not used. **New goal** in the command palette (`Cmd+K`)
and the `chat.goal` key command open the same composer in goal mode.

Optionally add **Done when** criteria, one per line — for example:

```
Tests pass
Settings page has a notification section
Docs mention the new options
```

Criteria are the checklist the agent is held to. Press Enter or **Start
goal** to begin. It runs in the current thread when there is one; otherwise
it starts a thread of its own in the current project. Like a Codex `/goal`, a
goal belongs to its thread, so you will not see another thread's goal in this
one — the **Other goals** menu lists them. To leave goal mode, delete the
leading `/goal ` (or press the hint bar’s ✕), which turns the composer back
into a normal message box.

Reserved commands after the space, such as `/goal clear` or `/goal pause`,
send as normal messages for the provider to run instead of starting a goal.
To make one the objective, write a longer sentence such as `/goal clear the
backlog`.

## What you see

A goal card sits above the composer for as long as the goal matters. The
collapsed card is a single status line — its title, status, what is
happening now, and a slim progress bar — so it never swallows the chat.
While a turn is running, the status shows a spinner and counts the current
turn's age. Expand it for the objective, the current step, the full plan
with each task's status, and the progress percentage. When criteria were
given, the expanded card also shows **Done when** with each criterion's
state and the verification result. **View activity** opens the recent
history: what the agent planned, what it finished, and what it is checking.
The card stays visible in its thread when you switch threads or reload the
page, and the goal keeps running while the browser is closed because the
environment drives it.

**Hide this finished goal** clears a completed goal from the card; **Start
another goal** turns the composer back to the goal input while the current
goal keeps running.

## Controlling a goal

- **Pause** interrupts right away, even mid-turn; **Resume** continues from the
  same plan. While a goal is waiting for an answer, neither is available:
  answer it to continue.
- **Edit** changes the objective or adds requirements. Finished work is kept
  and only the remaining plan changes. An edit keeps the goal's current
  status: a paused goal stays paused until you resume it, and the edit dialog
  offers **Save & resume** to save and restart in one click.
- **Cancel** stops the goal for good. It asks first, and a cancelled goal never
  resumes.
- A failed or blocked task can be retried on its own, without restarting the
  goal.

## When the agent asks or gets stuck

The agent stops for you only when it cannot decide on its own. A question shows
as **Needs input** with an answer box in the card. A goal that cannot continue
shows **Blocked** (or **Failed**) with the reason in the card, so you can
remove the obstacle and resume, edit the goal, retry, or cancel it.

If a goal looks active but nothing is driving it, DAK marks it **Blocked** with
“The goal stopped making progress. Resume to continue.” The check leaves goals
with an active driver or recent changes alone.

## Notifications

Goals use the same device notification settings as threads in **Settings >
Behavior**. A goal sends an attention notification when it needs input, becomes
blocked, or fails; it sends a completion notification when it finishes. While
the app has focus, in-app toasts open the goal's thread. In the background,
the same settings decide whether DAK sends a system notification or plays a
sound instead.

## Verification

A goal is marked **Completed** only after the agent has verified every acceptance criterion; a reply on its own never counts as completion. The card reports the check as **Verified** or **Did not pass**, with each criterion ticked or marked unmet. When a check fails, the agent keeps working until every criterion holds — there is no automatic cap on how many times it can try.

### The agent decides its own approach

There is no limit on how many tasks a plan can contain, how many times a task can be retried, or how long a goal can run. The agent determines its own approach, breaks the work into whatever tasks it needs, and can spend as many turns as required to fix an issue. A goal can run for weeks or months so long as you have tokens; it stops only when it completes, when you cancel it, or when a problem genuinely cannot be fixed.

### Verification requires proof

A criterion counts as met only when the matching `acceptance` entry claims `met: true` **and** carries proof — not just the agent's word. Proof can be images, screenshots, canvas output, test results, check output, or run output, each with a URL and a caption describing what it shows. A bare `met: true` without proof counts as not met.

If verification fails because criteria lack proof, the agent identifies the unmet criteria, performs corrective work, captures new proof, and re-verifies automatically. This loop repeats until every criterion is provably satisfied or you stop the goal.

### Progress percentage includes a verification unit

The progress bar counts `tasks + 1` total units, where the last unit is verification:

- **Total** = `number of tasks + 1`
- **Done** = `completedTasks + (verified ? 1 : 0)`

This means the bar never reaches 100% until verification independently passes. If verification fails, progress stays below 100% and corrective execution resumes.

### How the verification loop works

1. After all tasks are `completed`, the goal enters the **verifying** state.
2. A verification turn runs; the agent checks every criterion against the workspace — running tests, typechecks, builds, or commands that prove the behaviour. Reading code is not proof when a check can be run. The agent must attach proof (images, screenshots, canvas output, test results, check output, or run output) to every criterion it claims is met.
3. If all criteria carry proof and `verified: true`, the goal is marked **Completed**.
4. If any criterion lacks proof or is not met, the goal enters **repair** mode; the agent fixes what is needed and reports a repair turn. After the repair, verification runs again. This repeats as long as needed.
5. You can pause, edit, or cancel the goal at any time.

### “Gets stuck” scenarios

- **Goal shows Blocked with “Verification never reported back”**: The verification turn finished without emitting a report. Resume the goal to try again.
- **Goal shows Blocked with “No runnable task remains”**: Every task ended without a runnable next step. Retry a task manually or edit the goal.
- **Goal shows Needed input**: The agent asked the user a question. Answer it to continue.
- **Progress stays below 100% while verification is pending**: This is expected — verification is the final unit; it must pass for the bar to reach 100%.

## Using the thread

You can keep talking in the thread while a goal runs. Ask about progress, add
a constraint, or correct an assumption. Messages you send are delivered in
order with the goal's own turns.

## Agent tools

Agents can use the `dak_goal_*` MCP tools to list summaries, read full goal
details, create, update, pause, resume, cancel, answer, or retry a task. List
first to find a goal's id; use read when you need its full task and activity
history.

## Platform support

Goal mode is available on web and desktop. The mobile app does not support
DAK Goal Mode; it only shows the provider's own native goal feature.
