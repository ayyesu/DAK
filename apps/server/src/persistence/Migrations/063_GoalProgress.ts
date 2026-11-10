import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The agent now reports its own progress each turn so the card never sits at
 * 0% while planning. Store that report on the goal so it survives turn
 * boundaries and shows in both the collapsed and expanded card.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(goals)
  `;

  if (!columns.some((column) => column.name === "progress")) {
    yield* sql`
      ALTER TABLE goals
      ADD COLUMN progress INTEGER
    `;
  }

  if (!columns.some((column) => column.name === "progress_label")) {
    yield* sql`
      ALTER TABLE goals
      ADD COLUMN progress_label TEXT
    `;
  }
});
