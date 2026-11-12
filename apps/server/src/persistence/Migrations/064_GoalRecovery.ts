import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Goal Mode now separates "the agent hit an obstacle" from "the goal is
 * deadlocked". Tasks carry recovery counters and their dependencies instead of
 * a bare blocked state, and a goal keeps the question it is waiting on so
 * independent work can continue while the user answers.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const goalColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(goals)
  `;
  if (!goalColumns.some((column) => column.name === "question")) {
    yield* sql`
      ALTER TABLE goals
      ADD COLUMN question TEXT
    `;
  }
  if (!goalColumns.some((column) => column.name === "question_task_id")) {
    yield* sql`
      ALTER TABLE goals
      ADD COLUMN question_task_id TEXT
    `;
  }
  if (!goalColumns.some((column) => column.name === "blocker_json")) {
    yield* sql`
      ALTER TABLE goals
      ADD COLUMN blocker_json TEXT
    `;
  }

  const taskColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(goal_tasks)
  `;
  if (!taskColumns.some((column) => column.name === "recovery_attempts")) {
    yield* sql`
      ALTER TABLE goal_tasks
      ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!taskColumns.some((column) => column.name === "reassessments")) {
    yield* sql`
      ALTER TABLE goal_tasks
      ADD COLUMN reassessments INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!taskColumns.some((column) => column.name === "depends_on_json")) {
    yield* sql`
      ALTER TABLE goal_tasks
      ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
  if (!taskColumns.some((column) => column.name === "question")) {
    yield* sql`
      ALTER TABLE goal_tasks
      ADD COLUMN question TEXT
    `;
  }
  if (!taskColumns.some((column) => column.name === "blocker_json")) {
    yield* sql`
      ALTER TABLE goal_tasks
      ADD COLUMN blocker_json TEXT
    `;
  }

  // A task that was parked as blocked or left as failed is recoverable work
  // now: the drive loop runs recovery turns on it instead of stranding it.
  yield* sql`
    UPDATE goal_tasks
    SET status = 'recovering'
    WHERE status IN ('blocked', 'failed')
  `;
});
