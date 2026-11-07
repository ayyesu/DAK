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
Expand it for the objective, the current step, the full plan with each
task's status, and the progress percentage. When criteria were given, the
expanded card also shows **Done when** with each criterion's state and
the verification result. **View activity** opens the recent history: what
the agent planned, what it finished, and what it is checking. The card
stays visible in its thread when you switch threads or reload the page,
and the goal keeps running while the browser is closed because the
environment drives it.

**Hide this finished goal** clears a completed goal from the card; **Start
another goal** turns the composer back to the goal input while the current
goal keeps running.

## Controlling a goal

- **Pause** interrupts right away, even mid-turn; **Resume** continues from
  the same plan.
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

## Verification

A goal is marked **Completed** only after the agent has verified every
acceptance criterion; a reply on its own never counts as completion. The card
reports the check as **Verified** or **Did not pass**, with each criterion
ticked or marked unmet. When a check fails, the goal keeps working until the
criteria hold or the goal runs out of attempts.

## Using the thread

You can keep talking in the thread while a goal runs. Ask about progress, add
a constraint, or correct an assumption. Messages you send are delivered in
order with the goal's own turns.
