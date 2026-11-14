import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/**
 * Copy for the Dynamic Island's short lines, written by the text-generation
 * model the user selected (Settings -> text generation). Deterministic copy
 * renders immediately everywhere; model copy only ever replaces it on the
 * client, after validation, within a short deadline. The server never pushes
 * island copy on its own.
 *
 * The subject is the exact evidence the model may use. Nothing else about the
 * thread is sent: goal questions and errors are untrusted text, and the prompt
 * builder delimits them as data.
 */
export const IslandCopyGoalStatus = Schema.Literals([
  "running",
  "recovering",
  "verifying",
  "needs_input",
  "failed",
]);
export type IslandCopyGoalStatus = typeof IslandCopyGoalStatus.Type;

const GoalTitle = Schema.String.check(Schema.isMaxLength(200));
const TaskTitle = Schema.String.check(Schema.isMaxLength(200));
const IslandQuestion = Schema.String.check(Schema.isMaxLength(600));
const IslandError = Schema.String.check(Schema.isMaxLength(400));
const WaitingReason = Schema.String.check(Schema.isMaxLength(400));

/**
 * The goal variant of `IslandCopySubject`. `waitingReason` is accepted for
 * completeness but is only meaningful while a goal waits on the provider, a
 * state clients never send: the text model may be the exhausted provider, so
 * asking it would fail or burn quota on copy that is already clear.
 */
export const IslandGoalCopySubject = Schema.TaggedStruct("goal", {
  status: IslandCopyGoalStatus,
  /** The goal's own title; the user's words, kept verbatim on screen. */
  title: GoalTitle,
  currentTaskTitle: Schema.optionalKey(TaskTitle),
  question: Schema.optionalKey(IslandQuestion),
  error: Schema.optionalKey(IslandError),
  waitingReason: Schema.optionalKey(WaitingReason),
});
export type IslandGoalCopySubject = typeof IslandGoalCopySubject.Type;

export const IslandCopySubject = Schema.Union([IslandGoalCopySubject]);
export type IslandCopySubject = typeof IslandCopySubject.Type;

export const IslandCopyInput = Schema.Struct({
  threadId: ThreadId,
  subject: IslandCopySubject,
});
export type IslandCopyInput = typeof IslandCopyInput.Type;

export const IslandCopyResult = Schema.Struct({
  /** At most ~90 chars, reads in at most two island lines. */
  detail: Schema.String,
  /** At most ~12 chars, fits the compact island next to the glyph. */
  compact: Schema.String,
});
export type IslandCopyResult = typeof IslandCopyResult.Type;
