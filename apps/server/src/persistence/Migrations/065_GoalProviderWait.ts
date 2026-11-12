import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A goal can now be parked on a provider fault. The goal keeps the fault and
 * the moment it may try again, so a restart resumes the wait instead of
 * dropping the goal. The fault stays on the goal until a turn has told the
 * agent about it, so the agent knows why that turn never reached it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const goalColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(goals)
  `;
  if (!goalColumns.some((column) => column.name === "provider_wait_json")) {
    yield* sql`
      ALTER TABLE goals
      ADD COLUMN provider_wait_json TEXT
    `;
  }

  // The parked sweep runs every few seconds and asks for the goals that are
  // waiting. Without this it scans every goal on every pass.
  yield* sql`
    CREATE INDEX IF NOT EXISTS goals_status_idx ON goals(status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS goals_thread_idx ON goals(thread_id)
  `;
});
