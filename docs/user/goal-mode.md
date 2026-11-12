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
`/goal` command is not used.

The composer also has a **Goal** control next to the build and plan modes, in
the same _Mode & Access_ menu. It switches the composer into goal mode, and
turns it back off when you press it again. **New goal** in the command palette
(`Cmd+K`) and the `chat.goal` key command open the same composer in goal mode.

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

Two goals never drive the same thread, because their turns would interleave
and each agent would answer the other’s task. A goal you start while another
one is working in this thread therefore runs in a thread of its own, and the
composer says so before you send it.

Reserved commands after the space, such as `/goal clear` or `/goal pause`,
send as normal messages for the provider to run instead of starting a goal.
To make one the objective, write a longer sentence such as `/goal clear the
backlog`.

## What you see

A goal card sits above the composer for as long as the goal matters. The
collapsed card is a single status line — its title, status, what is
happening now, and a slim progress bar — so it never swallows the chat.
While a turn is running, the status shows a spinner and counts the current
turn's age. A goal working through a problem shows **Recovering**, and a task
waiting on you shows **Waiting for you**. When the provider itself stops — it
is signed out, out of quota, or unreachable — the goal shows **Waiting for
provider** and keeps its plan; DAK retries it on its own and it continues from
where it stopped. Expand it for the objective, the
current step, the full plan with each task's status, and the progress
percentage. Under the progress bar the card names the model running the goal
and how many turns it has spent. The card folds open and closed with an
animation, and the controls along its bottom edge — **Pause**, **Resume**,
**Edit**, **Cancel** — stay reachable without expanding it. A question from
the agent stays visible in the same way, so an answer is never hidden behind
a collapsed card.

The card also shows what the goal changed on disk: the number of changed
files and a `+n -m` line count, the same summary the timeline shows for a
turn. Expand it to list the files, and pick one to open that file's diff in
the diff panel.

When criteria were given, the expanded card also shows **Done
when** with each criterion's state and the verification result. **View
activity** opens the recent history: what the agent planned, what it
finished, what it is checking, and what it is recovering from. The card stays
visible in its thread when you switch threads or reload the page, and the goal
keeps running while the browser is closed because the environment drives it.

**Hide this finished goal** clears a completed goal from the card; **Start
another goal** turns the composer back to the goal input while the current
goal keeps running. Hidden goals stay reachable: the card keeps a count of
them, and picking one there brings it back.

## Controlling a goal

- **Pause** interrupts right away, even mid-turn; **Resume** continues from the
  same plan. While a goal is waiting for an answer, neither is available:
  answer it to continue. A goal **Waiting for provider** can be paused to stop
  the retries, or resumed to try again immediately instead of waiting out the
  provider's delay.
- **Edit** changes the objective or adds requirements. Finished work is kept
  and only the remaining plan changes. An edit keeps the goal's current
  status: a paused goal stays paused until you resume it, and the edit dialog
  offers **Save & resume** to save and restart in one click.
- **Cancel** stops the goal for good. It asks first, and a cancelled goal never
  resumes.
- A task that could not finish can be retried on its own, without restarting
  the goal.

## The agent works things out on its own

Goal mode is autonomous by default. When something breaks — a build fails, a
test fails, a dependency conflicts, an approach turns out to be wrong — the
agent investigates the cause and tries a different approach itself. You are
only interrupted when a decision genuinely needs you.

Concretely:

- A failed build or test sends the task back through **recovery**: the agent
  gets the error as context and is asked to fix the cause and verify the fix,
  not to repeat the same command.
- Recovery escalates instead of ending. After a few recovery attempts the
  agent is asked for a **reassessment**: what is actually blocking, what was
  tried, what else was considered, and what only you can provide. That
  question is asked as many times as it takes — no count of attempts or
  reassessments ends a goal. A task is only marked **Blocked** when a
  reassessment comes back with a specific external blocker — never because
  the agent gave up.
- When the provider itself fails — signed out, out of quota, unreachable —
  the goal parks as **Waiting for provider** instead of failing. It keeps its
  plan, retries on its own (after a quota limit resets, or with a growing
  delay), and continues where it stopped once the provider is back.
- A task waiting on you (**Waiting for you**) pauses only that task. Other
  tasks keep going, and the answer picks the task up exactly where it
  stopped.
- If a goal looks active but nothing is driving it, DAK picks it back up on
  its own. You do not need to press Resume.

## When the agent asks or gets stuck

The agent stops for you only when it cannot decide on its own. A question
shows as **Needs input** with an answer box in the card, naming the task your
answer unblocks. A goal that cannot
continue shows **Blocked** (or **Failed**) with the reason in the card, so you
can remove the obstacle and resume, edit the goal, retry, or cancel it.

When the agent blocks a goal it also reports its assessment: what stopped the
work, why that is true, what was inspected to find it, what was tried, what
else was considered, and what only you can provide. That is the evidence
behind the verdict, and it is what tells you whether to clear the obstacle or
redirect the goal.

## Notifications

Goals use the same device notification settings as threads in **Settings >
Behavior**. A goal sends an attention notification when it asks you a
question, becomes blocked, or fails; it sends a completion notification when
it finishes. While the app has focus, in-app toasts open the goal's thread.
In the background, the same settings decide whether DAK sends a system
notification or plays a sound instead.

## Verification

A goal is marked **Completed** only after the agent has verified every acceptance criterion; a reply on its own never counts as completion. The card reports the check as **Verified** or **Did not pass**, with each criterion ticked or marked unmet. When a check fails, the agent keeps working until every criterion holds — there is no automatic cap on how many times it can try.

### The agent decides its own approach

There is no limit on how many tasks a plan can contain, how long a goal can
run, or how many turns it can spend. The agent determines its own approach,
breaks the work into whatever tasks it needs, and can spend as many turns as
required to fix an issue. A goal can run for weeks or months so long as you
have tokens; it stops only when it completes, when you cancel it, or when a
problem genuinely cannot be fixed.

Recovery of a failed task escalates rather than running out: a limited number
of recovery attempts buys a **reassessment**, and answering the reassessment
buys more recovery — there is no last rung that ends the goal. Work that made
progress starts a fresh recovery budget. Only a specific external blocker
ends the work.

A turn is judged by what it does, not by the clock: if it goes quiet for
about twenty minutes with nothing left running, DAK treats it as stuck and
the task goes into recovery with that silence as context. A turn that keeps
producing — planning, running commands, delegating to subagents — slides
that deadline and is never interrupted for taking as long as it needs.

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

- **Goal shows Blocked**: The agent finished its recovery attempts and its
  reassessment named a specific external blocker. The card shows the reason,
  what was tried, and what it needs from you. Remove the obstacle and resume,
  or edit the goal.
- **Goal shows Needed input**: The agent asked you a question. Answer it to
  continue; the goal picks the task up where it stopped.
- **Goal shows Failed**: There is no runnable work left and no evidence-backed
  blocker — for example every task ended without a next step, or the plan came
  back empty. Retry a task, edit the goal, or resume it.
- **Goal shows Waiting for provider**: The provider stopped — it is signed
  out, out of quota, or unreachable. DAK retries on its own and the goal
  continues when the provider is back; **Resume** tries immediately and
  **Pause** stops the retries.
- **Progress stays below 100% while verification is pending**: This is expected — verification is the final unit; it must pass for the bar to reach 100%.

## Using the thread

You can keep talking in the thread while a goal runs. Ask about progress, add
a constraint, or correct an assumption. Messages you send are delivered in
order with the goal's own turns.

While the goal is working, the send button says where your message goes:
**Send to the goal** when it joins the goal's current turn, and **Queue for
the goal** when it waits behind it.

## Agent tools

Agents can use the `dak_goal_*` MCP tools to list summaries, read full goal
details, create, update, pause, resume, cancel, answer, or retry a task. List
first to find a goal's id; use read when you need its full task and activity
history. Creating a goal on a thread that already has one is refused; finish
or cancel it, or start the new goal without that thread.

## Platform support

Goal mode is available on web and desktop. The mobile app does not support
DAK Goal Mode; it only shows the provider's own native goal feature.
