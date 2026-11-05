# Goal mode

Goal mode gives the agent an outcome instead of a prompt. You describe what
should be true when it is finished, and the agent plans the steps, does the
work, and checks the result before reporting success.

## Starting a goal

Open the goal form with **Goal** next to the message composer, or run
**New goal** from the command palette (`Cmd+K`). The palette command has no
default shortcut; assign one to `chat.goal` in **Settings → Keybindings** if
you use it often.

Write the outcome in your own words, for example "Add per-channel
notification settings with tests". Optionally add **Done when** criteria, one
per line — for example:

```
Tests pass
Settings page has a notification section
Docs mention the new options
```

Criteria are the checklist the agent is held to. Then start the goal. It runs
in the current thread when there is one; otherwise it starts a thread of its
own in the current project.

## What you see

A goal card sits above the composer for as long as the goal matters. It shows
the objective, the current step, a progress bar, and the plan with each task's
status. When criteria were given, the card also shows **Done when** with each
criterion's state and the verification result. **View activity** opens the
recent history: what the agent planned, what it finished, and what it is
checking. The card stays visible if you switch threads or reload the page, and
the goal keeps running while the browser is closed because the environment
drives it.

**Hide this finished goal** clears a completed goal from the card; **Start
another goal** opens the form while the current goal keeps running.

## Controlling a goal

- **Pause** stops after the current turn; **Resume** continues from the same
  plan.
- **Edit** changes the objective or adds requirements. Finished work is kept
  and only the remaining plan changes.
- **Cancel** stops the goal for good. It asks first, and a cancelled goal never
  resumes.
- A failed or blocked task can be retried on its own, without restarting the
  goal.

## When the agent asks or gets stuck

The agent stops for you only when it cannot decide on its own. A question shows
as **Needs input** with an answer box in the card. A goal that cannot continue
shows **Blocked** (or **Failed**) with the reason in the card, so you can
remove the obstacle, retry, edit the goal, or cancel it.

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
