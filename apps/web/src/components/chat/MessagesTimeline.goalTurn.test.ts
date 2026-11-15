import { MessageId } from "@dak/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

const at = "2026-01-01T00:00:00Z";

const entry = (id: string, role: "user" | "assistant", text: string) => ({
  id,
  kind: "message" as const,
  createdAt: at,
  message: {
    id: MessageId.make(id),
    runId: null,
    role,
    text,
    createdAt: at,
    updatedAt: at,
    streaming: false,
  },
});

describe("goal turns in the timeline", () => {
  it("tags the message Goal Mode sent and the replies to it, until a person writes again", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        entry("u1", "user", "fix the bug"),
        entry("a1", "assistant", "done"),
        entry("goal-message:g1:2:task", "user", "You are executing a persistent goal."),
        entry("a2", "assistant", "Finished the task."),
        entry("u2", "user", "thanks"),
        entry("a3", "assistant", "you're welcome"),
      ],
      isWorking: false,
      latestRun: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const goalTurnById = Object.fromEntries(
      rows.flatMap((row) => (row.kind === "message" ? [[row.message.id, row.goalTurn]] : [])),
    );
    expect(goalTurnById).toEqual({
      u1: undefined,
      a1: undefined,
      "goal-message:g1:2:task": { goalId: "g1", cycle: 2, phase: "task" },
      a2: { goalId: "g1", cycle: 2, phase: "task" },
      u2: undefined,
      a3: undefined,
    });
  });
});
