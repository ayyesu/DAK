import { describe, expect, it } from "vite-plus/test";

import { splitGoalReport } from "./goalReport.js";

const fence = (body: unknown, language = "json") =>
  `\`\`\`${language}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;

const report = { goal_report: { status: "running", summary: "Added the parser." } };

describe("splitGoalReport", () => {
  it("takes the report out of the prose and returns it", () => {
    const split = splitGoalReport(`Done with the parser.\n\n${fence(report)}`);
    expect(split.prose).toBe("Done with the parser.");
    expect(split.report?.status).toBe("running");
    expect(split.report?.summary).toBe("Added the parser.");
    expect(split.pending).toBe(false);
  });

  it("keeps code blocks that are not the report", () => {
    const sample = "```ts\nconst a = 1;\n```";
    const split = splitGoalReport(`Here is the change:\n\n${sample}\n\n${fence(report)}`);
    expect(split.prose).toBe(`Here is the change:\n\n${sample}`);
    expect(split.report).not.toBeNull();
  });

  it("returns a message with no report untouched", () => {
    const message = `Plain answer.\n\n${fence({ unrelated: true })}`;
    const split = splitGoalReport(message);
    expect(split.report).toBeNull();
    expect(split.prose).toBe(message);
  });

  it("holds back a report fence that is still streaming", () => {
    const open = 'Working on it.\n\n```json\n{"goal_report":{"status":"run';
    const split = splitGoalReport(open, { streaming: true });
    expect(split.prose).toBe("Working on it.");
    expect(split.pending).toBe(true);
    // Not streaming, the same text is just text.
    expect(splitGoalReport(open).prose).toBe(open.trim());
  });

  it("does not hold back an ordinary code block that is streaming", () => {
    const open = "Try this:\n\n```ts\nconst answer = 42;\nconsole.log(answer);";
    const split = splitGoalReport(open, { streaming: true });
    expect(split.pending).toBe(false);
    expect(split.prose).toBe(open);
  });
});
