import { GOAL_MAX_TASKS, GoalId, type Goal, type GoalTask } from "@dak/contracts";
import { assert, describe, expect, it } from "@effect/vitest";

import {
  applyGoalReport,
  buildGoalExecutionPrompt,
  buildGoalFollowUpPrompt,
  buildGoalPlanningPrompt,
  buildGoalRepairPrompt,
  buildGoalVerificationPrompt,
  parseGoalReport,
  stripGoalReport,
} from "./GoalProtocol.ts";

function task(overrides: Partial<GoalTask> & Pick<GoalTask, "id" | "title" | "order">): GoalTask {
  return {
    detail: null,
    status: "pending",
    startedAt: null,
    completedAt: null,
    evidence: null,
    question: null,
    blocker: null,
    attempts: 0,
    dependsOn: [],
    ...overrides,
  };
}

const baseGoal: Goal = {
  id: GoalId.make("goal:1"),
  projectId: "project:1" as Goal["projectId"],
  threadId: null,
  title: "Ship the feature",
  objective: "Add a settings page for notifications.",
  acceptanceCriteria: [],
  status: "planning",
  tasks: [],
  activities: [],
  currentTaskId: null,
  modelSelection: { instanceId: "codex", model: "gpt-5.4" } as Goal["modelSelection"],
  runtimeMode: "auto",
  interactionMode: "default",
  revision: 1,
  cycleCount: 0,
  verification: { status: "pending", summary: null, checkedAt: null },
  blockedReason: null,
  failureReason: null,
  question: null,
  questionTaskId: null,
  blocker: null,
  progress: null,
  progressLabel: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  turnStartedAt: null,
  completedAt: null,
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  createdBy: "user",
  creationSource: "web",
};

const reportFor = (body: unknown) => `\`\`\`goal\n${JSON.stringify(body)}\n\`\`\``;

describe("parseGoalReport", () => {
  it("reads the report out of prose and ignores languages that are not a goal block", () => {
    const message = `I implemented the form.\n\n${reportFor({
      status: "running",
      summary: "Added the form",
      tasks: [{ title: "Add form", status: "completed", evidence: "Added src/Form.tsx" }],
    })}\n\nNext I will wire it up.`;
    const report = parseGoalReport(message);
    assert.isNotNull(report);
    expect(report.status).toBe("running");
    expect(report.summary).toBe("Added the form");
    expect(report.tasks).toEqual([
      { title: "Add form", status: "completed", evidence: "Added src/Form.tsx" },
    ]);
  });

  it("uses the last report when a retry left two blocks", () => {
    const message = [
      reportFor({ status: "running", summary: "first" }),
      reportFor({ status: "completed", summary: "second" }),
    ].join("\n\n");
    expect(parseGoalReport(message)?.summary).toBe("second");
  });

  it("accepts a json block that wraps the report", () => {
    const message = `\`\`\`json\n${JSON.stringify({ goal_report: { status: "needs_input", question: "Which host?" } })}\n\`\`\``;
    const report = parseGoalReport(message);
    expect(report?.status).toBe("needs_input");
    expect(report?.question).toBe("Which host?");
  });

  it("accepts planning so the agent can say what it is doing", () => {
    expect(
      parseGoalReport(reportFor({ status: "planning", summary: "Reading the code" }))?.status,
    ).toBe("planning");
  });

  it("rejects malformed JSON and empty reports instead of reporting progress", () => {
    expect(parseGoalReport("```goal\n{not json}\n```")).toBeNull();
    expect(parseGoalReport(reportFor({}))).toBeNull();
    expect(parseGoalReport("I finished everything, honestly.")).toBeNull();
  });

  it("accepts a pending task so an untouched plan item is not reported blocked", () => {
    const report = parseGoalReport(
      reportFor({ status: "running", tasks: [{ title: "Later", status: "pending" }] }),
    );
    expect(report?.tasks).toEqual([{ title: "Later", status: "pending", evidence: null }]);
  });

  it("counts a verification-only block as a report", () => {
    const report = parseGoalReport(reportFor({ verified: true }));
    expect(report?.verified).toBe(true);
    expect(report?.status).toBe("running");
  });

  it("recovers a report whose closing brackets were cut off", () => {
    const full = JSON.stringify({
      goal_report: {
        status: "completed",
        summary: "Verified",
        verified: true,
        acceptance: [{ criterion: "Ships", met: true, evidence: "build ok" }],
      },
    });
    const truncated = full.slice(0, full.length - 2);
    const report = parseGoalReport(`\`\`\`goal\n${truncated}\n\`\`\``);
    expect(report?.status).toBe("completed");
    expect(report?.verified).toBe(true);
    expect(report?.acceptance[0]?.evidence).toBe("build ok");
  });

  it("bounds the plan so a runaway report cannot flood the UI", () => {
    const plan = Array.from({ length: GOAL_MAX_TASKS + 10 }, (_, index) => ({
      title: `Task ${index}`,
    }));
    expect(parseGoalReport(reportFor({ status: "running", plan }))?.plan).toHaveLength(
      GOAL_MAX_TASKS,
    );
  });
});

describe("applyGoalReport", () => {
  let counter = 0;
  const makeTaskId = () => {
    counter += 1;
    return `task:${counter}`;
  };
  const nowIso = "2026-01-01T00:10:00.000Z";

  it("turns the first plan into ordered tasks", () => {
    const report = parseGoalReport(
      reportFor({
        status: "running",
        plan: [{ title: "Inspect settings" }, { title: "Add toggle", detail: "Per channel" }],
      }),
    );
    assert.isNotNull(report);
    const applied = applyGoalReport({
      tasks: [],
      acceptanceCriteria: [],
      report,
      makeTaskId,
      nowIso,
    });
    expect(applied.tasks.map((entry) => entry.title)).toEqual(["Inspect settings", "Add toggle"]);
    expect(applied.tasks.map((entry) => entry.order)).toEqual([0, 1]);
    expect(applied.tasks[1]?.detail).toBe("Per channel");
    expect(applied.status).toBe("running");
    expect(applied.changes[0]?.kind).toBe("plan");
  });

  it("keeps the agent's planning status instead of inferring one", () => {
    const report = parseGoalReport(reportFor({ status: "planning", summary: "Still planning" }));
    assert.isNotNull(report);
    const applied = applyGoalReport({
      tasks: [task({ id: "t1", title: "Inspect", order: 0, attempts: 1 })],
      acceptanceCriteria: [],
      report,
      makeTaskId,
      nowIso,
    });
    expect(applied.status).toBe("planning");
  });

  it("keeps completed work when the user edits the goal and the plan changes", () => {
    const tasks = [
      task({ id: "t1", title: "Inspect settings", order: 0, status: "completed", attempts: 1 }),
      task({ id: "t2", title: "Add toggle", order: 1 }),
    ];
    const report = parseGoalReport(
      reportFor({
        status: "running",
        plan: [{ title: "Inspect settings" }, { title: "Add email toggle" }],
      }),
    );
    assert.isNotNull(report);
    const applied = applyGoalReport({ tasks, acceptanceCriteria: [], report, makeTaskId, nowIso });
    expect(applied.tasks.map((entry) => entry.title)).toEqual([
      "Inspect settings",
      "Add email toggle",
    ]);
    expect(applied.tasks[0]?.status).toBe("completed");
  });

  it("never un-completes a completed task from a later report", () => {
    const tasks = [
      task({ id: "t1", title: "Add toggle", order: 0, status: "completed", attempts: 1 }),
    ];
    const report = parseGoalReport(
      reportFor({ status: "running", tasks: [{ title: "Add toggle", status: "in_progress" }] }),
    );
    assert.isNotNull(report);
    const applied = applyGoalReport({ tasks, acceptanceCriteria: [], report, makeTaskId, nowIso });
    expect(applied.tasks[0]?.status).toBe("completed");
  });

  it("refuses to treat a completion claim as done while tasks remain", () => {
    const tasks = [
      task({ id: "t1", title: "Add toggle", order: 0, status: "completed", attempts: 1 }),
      task({ id: "t2", title: "Verify", order: 1 }),
    ];
    const report = parseGoalReport(reportFor({ status: "completed", summary: "All done" }));
    assert.isNotNull(report);
    const applied = applyGoalReport({ tasks, acceptanceCriteria: [], report, makeTaskId, nowIso });
    expect(applied.status).toBe("running");
    expect(applied.prematureCompletion).toBe(true);
  });

  it("moves to verification only when every task is complete", () => {
    const tasks = [
      task({ id: "t1", title: "Add toggle", order: 0, status: "completed", attempts: 1 }),
    ];
    const report = parseGoalReport(reportFor({ status: "completed", summary: "Done" }));
    assert.isNotNull(report);
    const applied = applyGoalReport({ tasks, acceptanceCriteria: [], report, makeTaskId, nowIso });
    expect(applied.status).toBe("verifying");
    expect(applied.prematureCompletion).toBe(false);
  });

  it("ignores a plan echoed by an execution turn", () => {
    const tasks = [
      task({ id: "t1", title: "Add toggle", order: 0, status: "in_progress", attempts: 1 }),
      task({ id: "t2", title: "Verify", order: 1 }),
    ];
    const report = parseGoalReport(
      reportFor({ status: "running", plan: [{ title: "Add toggle (again)" }] }),
    );
    assert.isNotNull(report);
    const applied = applyGoalReport({
      tasks,
      acceptanceCriteria: [],
      report,
      makeTaskId,
      nowIso,
      planHandling: "ignore",
    });
    expect(applied.tasks.map((entry) => entry.title)).toEqual(["Add toggle", "Verify"]);
  });

  it("extends the plan from a repair turn without dropping pending work", () => {
    const tasks = [task({ id: "t1", title: "Add toggle", order: 0, status: "pending" })];
    const report = parseGoalReport(
      reportFor({ status: "running", plan: [{ title: "Add toggle" }, { title: "Fix reload" }] }),
    );
    assert.isNotNull(report);
    const applied = applyGoalReport({
      tasks,
      acceptanceCriteria: [],
      report,
      makeTaskId,
      nowIso,
      planHandling: "extend",
    });
    expect(applied.tasks.map((entry) => entry.title)).toEqual(["Add toggle", "Fix reload"]);
  });

  it("carries needs_input through and adopts proposed criteria", () => {
    const report = parseGoalReport(
      reportFor({
        status: "needs_input",
        question: "Which provider should this page live in?",
        acceptanceCriteria: ["The toggle persists", "The page loads"],
      }),
    );
    assert.isNotNull(report);
    const applied = applyGoalReport({
      tasks: [task({ id: "t1", title: "Inspect", order: 0, status: "in_progress", attempts: 1 })],
      acceptanceCriteria: [],
      report,
      makeTaskId,
      nowIso,
    });
    // The question is asked of the user, so the goal keeps running and only
    // the task that asked pauses.
    expect(applied.status).toBe("running");
    expect(applied.question).toBe("Which provider should this page live in?");
    expect(applied.acceptanceCriteria).toEqual(["The toggle persists", "The page loads"]);
  });

  it("keeps a task nobody started runnable instead of stranding it as blocked", () => {
    const report = parseGoalReport(
      reportFor({
        status: "running",
        tasks: [{ title: "Inspect", status: "blocked", evidence: "not attempted" }],
      }),
    );
    assert.isNotNull(report);
    const applied = applyGoalReport({
      tasks: [task({ id: "t1", title: "Inspect", order: 0 })],
      acceptanceCriteria: [],
      report,
      makeTaskId,
      nowIso,
    });
    expect(applied.tasks[0]?.status).toBe("pending");
    expect(applied.tasks[0]?.attempts).toBe(0);
    expect(applied.tasks[0]?.startedAt).toBeNull();
  });

  it("does not invent a failed task out of a report for work that does not exist", () => {
    const report = parseGoalReport(
      reportFor({
        status: "running",
        tasks: [{ title: "Ghost", status: "failed", evidence: "never tried" }],
      }),
    );
    assert.isNotNull(report);
    const applied = applyGoalReport({
      tasks: [],
      acceptanceCriteria: [],
      report,
      makeTaskId,
      nowIso,
    });
    expect(applied.tasks).toHaveLength(1);
    expect(applied.tasks[0]?.status).toBe("pending");
    expect(applied.tasks[0]?.attempts).toBe(0);
  });

  it("turns a reported failure into an obstacle the server recovers from", () => {
    const report = parseGoalReport(
      reportFor({
        status: "running",
        tasks: [{ title: "Inspect", status: "failed", evidence: "port 4000 in use" }],
      }),
    );
    assert.isNotNull(report);
    const applied = applyGoalReport({
      tasks: [
        task({
          id: "t1",
          title: "Inspect",
          order: 0,
          status: "in_progress",
          attempts: 1,
          startedAt: nowIso,
        }),
      ],
      acceptanceCriteria: [],
      report,
      makeTaskId,
      nowIso,
    });
    // A failure is an obstacle, not a dead end: the task goes into recovery
    // so the driver sends it a recovery turn instead of stranding it.
    expect(applied.tasks[0]?.status).toBe("recovering");
    expect(applied.tasks[0]?.evidence).toBe("port 4000 in use");
  });

  it("leaves the attempt counters to the server that dispatches the turn", () => {
    const starting = parseGoalReport(
      reportFor({ status: "running", tasks: [{ title: "Inspect", status: "in_progress" }] }),
    );
    assert.isNotNull(starting);
    const first = applyGoalReport({
      tasks: [task({ id: "t1", title: "Inspect", order: 0 })],
      acceptanceCriteria: [],
      report: starting,
      makeTaskId,
      nowIso,
    });
    expect(first.tasks[0]?.status).toBe("in_progress");
    expect(first.tasks[0]?.attempts).toBe(0);

    const repeating = parseGoalReport(
      reportFor({ status: "running", tasks: [{ title: "Inspect", status: "in_progress" }] }),
    );
    assert.isNotNull(repeating);
    const second = applyGoalReport({
      tasks: [
        task({
          id: "t1",
          title: "Inspect",
          order: 0,
          status: "in_progress",
          attempts: 1,
          startedAt: nowIso,
        }),
      ],
      acceptanceCriteria: [],
      report: repeating,
      makeTaskId,
      nowIso,
    });
    expect(second.tasks[0]?.attempts).toBe(1);
  });
});

describe("stripGoalReport", () => {
  it("removes the report block but keeps the prose", () => {
    const stripped = stripGoalReport(
      `Implemented the toggle.\n${reportFor({ status: "running", summary: "toggle" })}`,
    );
    expect(stripped).toBe("Implemented the toggle.");
  });
});

describe("goal prompts", () => {
  it("tells the planning turn to plan, work and report with evidence", () => {
    const prompt = buildGoalPlanningPrompt(baseGoal);
    expect(prompt).toContain("Add a settings page for notifications.");
    expect(prompt).toContain("```goal");
    expect(prompt).toContain("Never report a task completed unless it is actually done");
  });

  it("names the task and keeps completed work out of the turn", () => {
    const prompt = buildGoalExecutionPrompt({
      goal: {
        ...baseGoal,
        tasks: [
          task({
            id: "t1",
            title: "Inspect",
            order: 0,
            status: "completed",
            evidence: "read app/",
          }),
          task({ id: "t2", title: "Add toggle", order: 1 }),
        ],
      },
      task: task({ id: "t2", title: "Add toggle", order: 1 }),
      edited: false,
    });
    expect(prompt).toContain(`Your task this turn: "Add toggle"`);
    // Done work is a count, not a transcript: its evidence is already in the
    // workspace and in the report the agent wrote.
    expect(prompt).toContain("1/2 done");
    expect(prompt).not.toContain("read app/");
  });

  it("requires proof for each acceptance criterion during verification", () => {
    const prompt = buildGoalVerificationPrompt({
      ...baseGoal,
      status: "verifying",
      acceptanceCriteria: ["The toggle persists after reload"],
    });
    expect(prompt).toContain("The toggle persists after reload");
    expect(prompt).toContain(
      `Set "verified": true only if every criterion is demonstrably satisfied`,
    );
    // The report shape has to carry what the verifier is told to produce.
    expect(prompt).toContain(`"acceptance":[{"criterion":`);
    expect(prompt).toContain(`"verified":false`);
    expect(prompt).toContain("A criterion without proof counts as not met");
  });

  it("hands the agent what is known and leaves the choice to it", () => {
    const retrying = task({
      id: "t2",
      title: "Add toggle",
      order: 1,
      attempts: 2,
      evidence: "port 4000 already in use",
    });
    const prompt = buildGoalFollowUpPrompt({
      goal: { ...baseGoal, tasks: [retrying] },
      task: retrying,
      failure: retrying.evidence,
      nextStep: "Report the task as completed with evidence.",
    });
    expect(prompt).toContain("port 4000 already in use");
    expect(prompt).toContain("You decide how to continue from here");
    expect(prompt).toContain("Do not repeat the same failing operation unchanged");
    // No counter decides how often the agent tries.
    expect(prompt).not.toContain("attempt 2");
    expect(prompt).not.toContain("recovery attempt");
  });

  it("does not lecture a first attempt about recovery", () => {
    const first = task({ id: "t1", title: "Inspect", order: 0, attempts: 1 });
    const prompt = buildGoalExecutionPrompt({
      goal: { ...baseGoal, tasks: [first] },
      task: first,
      edited: false,
    });
    expect(prompt).not.toContain("You decide how to continue");
  });

  it("lists exactly the criteria verification rejected when repairing", () => {
    const prompt = buildGoalRepairPrompt({
      ...baseGoal,
      status: "running",
      acceptanceCriteria: ["Persists after reload", "Loads fast"],
      verification: {
        status: "failed",
        summary: "Unmet: Loads fast",
        checkedAt: "2026-01-01T00:20:00.000Z",
        criteria: [
          { criterion: "Persists after reload", met: true },
          { criterion: "Loads fast", met: false },
        ],
      },
    });
    expect(prompt).toContain("Criteria verification did not accept:\n- Loads fast");
    expect(prompt).toContain("Unmet: Loads fast");
  });
});
