import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Goal Mode owns its own tables instead of reusing thread projections: a goal
 * outlives a single turn, is edited mid-flight, and carries an execution log
 * the conversation never sees. Nothing here duplicates message history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS goals (
      goal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      status TEXT NOT NULL,
      current_task_id TEXT,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      workspace_strategy_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      cycle_count INTEGER NOT NULL,
      verification_json TEXT NOT NULL,
      blocked_reason TEXT,
      failure_reason TEXT,
      -- Internal driver state: a queued edit, a queued answer to a question,
      -- and how many verification rounds have already run.
      pending_edit INTEGER NOT NULL DEFAULT 0,
      pending_answer TEXT,
      verify_rounds INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      creation_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      last_activity_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_goals_project
    ON goals(project_id, updated_at DESC)
  `;

  // Statuses the runner recovers after a restart: the index keeps that scan
  // small even when a project has a long goal history.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_goals_status
    ON goals(status, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS goal_tasks (
      goal_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL,
      task_order INTEGER NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      evidence TEXT,
      attempts INTEGER NOT NULL,
      PRIMARY KEY (goal_id, task_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS goal_activities (
      activity_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      task_id TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_goal_activities_goal
    ON goal_activities(goal_id, at DESC)
  `;
});
