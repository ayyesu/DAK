import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A goal can now be parked on a provider fault. The goal keeps the fault and
 * the moment it may try again, so a restart resumes the wait instead of
 * dropping the goal.
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
});
