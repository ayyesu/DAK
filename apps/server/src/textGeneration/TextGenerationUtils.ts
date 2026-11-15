import { TextGenerationError } from "@dak/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Schema-aware runtime check for `TextGenerationError`. */
export const isTextGenerationError = Schema.is(TextGenerationError);
const decodeJsonThreadTitle = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  // The type side, so decoding defaults do not turn required fields into
  // optional ones, and closed objects (`additionalProperties: false`):
  // structured-output modes require both, and closed was the generator
  // default before effect rc.113.
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema), {
    onExcessProperty: "error",
  });
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

// Prompts ask for under 40 characters. This cap only stops a runaway model
// from pushing a paragraph into the sidebar, header, and window title.
const MAX_THREAD_TITLE_CHARS = 120;

/** Normalise a raw thread title to a single line. Clients truncate for display. */
export function sanitizeThreadTitle(raw: string): string {
  // Unwrap a JSON-formatted title before truncation can cut off the closing brace.
  const decoded = decodeJsonThreadTitle(raw);
  const title = Option.isSome(decoded) ? decoded.value.title : raw;
  const normalized = title
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= MAX_THREAD_TITLE_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_THREAD_TITLE_CHARS - 3).trimEnd()}...`;
}

const MAX_ISLAND_DETAIL_CHARS = 90;
const MAX_ISLAND_COMPACT_CHARS = 12;

// Markdown structure and quote characters, removed outright rather than escaped.
const ISLAND_STRIP = /[*_~`#[\]()<>|\\"“”‘’']/g;
const ISLAND_CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

/** Cut at a word boundary, with an ellipsis, so the result never exceeds `maxChars`. */
const cutAtWordBoundary = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const budget = maxChars - 1; // room for the ellipsis
  const slice = value.slice(0, budget);
  const lastSpace = slice.lastIndexOf(" ");
  const base = (lastSpace >= 1 ? slice.slice(0, lastSpace) : slice).trimEnd();
  return `${base}\u2026`;
};

const cleanIslandText = (value: string, maxChars: number): string => {
  if (typeof value !== "string") return "";
  // Control characters become a space so they can split words, then everything
  // collapses to one line; stripping markdown and quotes follows, then a final
  // whitespace pass undoes the gaps the strip can leave.
  const singleLine = value.replace(ISLAND_CONTROL, " ").split(/\s+/).filter(Boolean).join(" ");
  const stripped = singleLine.replace(ISLAND_STRIP, "").replace(/\s+/g, " ").trim();
  return cutAtWordBoundary(stripped, maxChars);
};

/**
 * Normalise the model's island copy. `detail` failing closed (empty after
 * cleaning) throws a `TextGenerationError`; `compact` is allowed to be empty —
 * the client falls back to deterministic copy when either line is empty or over
 * its cap.
 */
export function sanitizeIslandCopy(
  operation: string,
  raw: { readonly detail?: unknown; readonly compact?: unknown },
): { detail: string; compact: string } {
  const detail = cleanIslandText(
    typeof raw.detail === "string" ? raw.detail : "",
    MAX_ISLAND_DETAIL_CHARS,
  );
  const compact = cleanIslandText(
    typeof raw.compact === "string" ? raw.compact : "",
    MAX_ISLAND_COMPACT_CHARS,
  );
  if (detail.length === 0) {
    throw new TextGenerationError({
      operation,
      detail: "The model returned an empty island detail line.",
    });
  }
  return { detail, compact };
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
