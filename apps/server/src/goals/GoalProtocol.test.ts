import { GOAL_MAX_TASKS, GoalId, type Goal, type GoalTask } from "@dak/contracts";
import { assert, describe, expect, it } from "@effect/vitest";

import {
  applyGoalReport,
  buildGoalExecutionPrompt,
  buildGoalPlanningPrompt,
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
    attempts: 0,
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
    expect(applied.status).toBe("needs_input");
    expect(applied.acceptanceCriteria).toEqual(["The toggle persists", "The page loads"]);
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
    expect(prompt).toContain("[completed] Inspect — evidence: read app/");
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
  });
});
