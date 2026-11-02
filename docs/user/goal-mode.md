# Goal mode

Goal mode gives the agent an outcome instead of a prompt. You describe what
should be true when it is finished, and the agent plans the steps, does the
work, and checks the result before reporting success.

Start one from **Goal** next to the message composer. Write the outcome in your
own words, for example "Add per-channel notification settings with tests", and
start it. The goal runs in the current thread when there is one; otherwise it
starts a thread of its own in the current project.

## What you see

A goal card sits above the composer for as long as the goal matters. It shows
the objective, the current step, a progress bar, and the plan with each task's
status. **View activity** opens the recent history: what the agent planned,
what it finished, and what it is checking. The card stays visible if you switch
threads or reload the page, and the goal keeps running while the browser is
closed because the environment drives it.

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
shows **Blocked** with the reason, so you can remove the obstacle, edit the
goal, or cancel it. A goal is marked **Completed** only after the agent has
verified every acceptance criterion; a reply on its own never counts as
completion.

## Using the thread

You can keep talking in the thread while a goal runs. Ask about progress, add
a constraint, or correct an assumption. Messages you send are delivered in
order with the goal's own turns.
