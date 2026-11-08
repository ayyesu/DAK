import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The goal card counts how long the current turn has been running, which needs
 * the dispatch time of the last turn rather than the goal's start time.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(goals)
  `;

  if (!columns.some((column) => column.name === "turn_started_at")) {
    yield* sql`
      ALTER TABLE goals
      ADD COLUMN turn_started_at TEXT
    `;
  }
});
