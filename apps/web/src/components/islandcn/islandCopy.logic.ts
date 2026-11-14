/**
 * The goal island's LLM copy, minus the React and RPC plumbing: subject
 * building, cache keys, output validation, the persisted LRU cache, the rate
 * limit, the in-flight marker, and the circuit breaker. Everything here is
 * pure with injected time/storage so the unit tests can drive the clock and
 * the model's behavior directly.
 *
 * Model copy is only ever an upgrade: deterministic copy renders immediately,
 * and this module decides when the model's text may replace it.
 */

import type { GoalSummary, IslandCopySubject } from "@dak/contracts";

export const ISLAND_DETAIL_LIMIT = 90;
export const ISLAND_COMPACT_LIMIT = 12;
export const ISLAND_COPY_TIMEOUT_MS = 4_000;
export const ISLAND_COPY_MIN_INTERVAL_MS = 20_000;
const ISLAND_COPY_TITLE_LIMIT = 200;
const ISLAND_COPY_TASK_LIMIT = 200;
const ISLAND_COPY_QUESTION_LIMIT = 600;
const ISLAND_COPY_ERROR_LIMIT = 400;

const LRU_LIMIT = 100;
const LRU_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PERSIST_KEY = "dak:island-copy:v1";

const BREAKER_THRESHOLD = 2;
const BREAKER_BASE_MS = 10 * 60 * 1000;
const BREAKER_MAX_MS = 60 * 60 * 1000;

export interface IslandCopy {
  readonly detail: string;
  readonly compact: string;
}

const normalize = (value: string | null | undefined): string =>
  value === null || value === undefined ? "" : value.replace(/\s+/g, " ").trim();

/** Hard cut for the wire. The prompt builder caps again server-side. */
const cut = (value: string, maxChars: number): string => value.slice(0, maxChars);

const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * Stable key over the semantic fields only. Progress, task counts and
 * timestamps are deliberately excluded: they change every turn and would
 * re-generate (and re-spend) on every tick.
 */
export const islandCopyKey = (subject: IslandCopySubject): string =>
  fnv1a(
    JSON.stringify([
      subject._tag,
      subject.status,
      normalize(subject.title),
      normalize(subject.currentTaskTitle ?? null),
      normalize(subject.question ?? null),
      normalize(subject.error ?? null),
    ]),
  );

/**
 * Build the wire subject for a goal. Returns null for every state the model
 * must never see: `waiting_provider` (the text model may be the exhausted
 * provider; the deterministic copy is already clear), and the states with
 * nothing for it to write (paused, planning, draft, completed, cancelled).
 */
export const buildIslandCopySubject = (
  goal: Pick<GoalSummary, "status" | "title" | "currentTaskTitle" | "question" | "failureReason">,
): IslandCopySubject | null => {
  const title = cut(normalize(goal.title), ISLAND_COPY_TITLE_LIMIT);
  const task = normalize(goal.currentTaskTitle);
  const currentTaskTitle = task.length > 0 ? cut(task, ISLAND_COPY_TASK_LIMIT) : undefined;
  switch (goal.status) {
    case "running":
    case "recovering":
    case "verifying":
      return {
        _tag: "goal",
        status: goal.status,
        title,
        ...(currentTaskTitle === undefined ? {} : { currentTaskTitle }),
      };
    case "needs_input": {
      const question = cut(normalize(goal.question), ISLAND_COPY_QUESTION_LIMIT);
      return {
        _tag: "goal",
        status: "needs_input",
        title,
        ...(currentTaskTitle === undefined ? {} : { currentTaskTitle }),
        ...(question.length === 0 ? {} : { question }),
      };
    }
    case "failed": {
      const error = cut(normalize(goal.failureReason), ISLAND_COPY_ERROR_LIMIT);
      return {
        _tag: "goal",
        status: "failed",
        title,
        ...(error.length === 0 ? {} : { error }),
      };
    }
    default:
      return null;
  }
};

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
// Markdown structure, quotes and backslashes: the model is told to avoid them,
// and the island does not render them.
const MARKDOWN_CHARS = /[*_~`#[\]()<>|\\"“”‘’']/;

/**
 * Accept the model's reply only if it can render safely: non-empty lines,
 * within the caps, no control or markdown characters. Anything else returns
 * null and the caller falls back to the deterministic copy.
 */
export const validateIslandCopy = (raw: unknown): IslandCopy | null => {
  if (raw === null || typeof raw !== "object") return null;
  const detail = (raw as { detail?: unknown }).detail;
  const compact = (raw as { compact?: unknown }).compact;
  if (typeof detail !== "string" || typeof compact !== "string") return null;
  const cleanedDetail = normalize(detail);
  const cleanedCompact = normalize(compact);
  if (cleanedDetail.length === 0 || cleanedDetail.length > ISLAND_DETAIL_LIMIT) return null;
  if (cleanedCompact.length === 0 || cleanedCompact.length > ISLAND_COMPACT_LIMIT) return null;
  if (CONTROL_CHARS.test(cleanedDetail) || CONTROL_CHARS.test(cleanedCompact)) return null;
  if (MARKDOWN_CHARS.test(cleanedDetail) || MARKDOWN_CHARS.test(cleanedCompact)) return null;
  return { detail: cleanedDetail, compact: cleanedCompact };
};

/**
 * Whether an RPC error is the provider saying it has no text generation at all
 * (e.g. ACP). Matching on the detail text is deliberate: the client never sees
 * the driver, only the typed error, and ACP's message is stable in-tree.
 */
export const isUnsupportedIslandError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const tagged = error as { _tag?: unknown; detail?: unknown };
  if (tagged._tag !== "TextGenerationError") return false;
  const detail = typeof tagged.detail === "string" ? tagged.detail.toLowerCase() : "";
  return (
    detail.includes("do not provide application text generation") ||
    detail.includes("unsupported") ||
    detail.includes("not supported")
  );
};

/**
 * A request's answer may be used only while the island still shows the state
 * it was asked about, and only within the timeout budget.
 */
export const isIslandCopyRequestCurrent = (
  expectedKey: string,
  currentKey: string | null,
  elapsedMs: number,
): boolean => currentKey === expectedKey && elapsedMs <= ISLAND_COPY_TIMEOUT_MS;

export interface IslandCopyStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface IslandCopyGateOptions {
  readonly now?: () => number;
  /**
   * Where the LRU cache persists. `undefined` auto-detects localStorage;
   * `null` keeps the cache in memory only (tests, non-browser builds).
   */
  readonly storage?: IslandCopyStorage | null;
}

export type IslandCopySkipReason =
  | "setting-off"
  | "offline"
  | "unsupported"
  | "breaker-open"
  | "rate-limited"
  | "inflight";

export type IslandCopyGateDecision = true | { readonly skip: IslandCopySkipReason };

export interface IslandCopyGate {
  /** Cached copy for a key, if any and fresh. */
  readonly cached: (key: string) => IslandCopy | undefined;
  /** Whether a request may be made right now, and if not, why. */
  readonly decision: (input: {
    readonly scope: string;
    readonly online: boolean;
    readonly smartText: boolean;
    readonly modelFingerprint: string;
  }) => IslandCopyGateDecision;
  /** Mark a request started (one in flight at a time; sets the rate-limit clock). */
  readonly start: (scope: string) => void;
  /** Clear the in-flight marker. Call when the request settles for any reason. */
  readonly settle: () => void;
  /** Record success: reset the breaker, cache the copy, persist the LRU. */
  readonly succeed: (key: string, copy: IslandCopy) => void;
  /** Record a failure, or an "unsupported" latch keyed to the model selection. */
  readonly fail: (kind: "failure" | "unsupported", modelFingerprint?: string) => void;
  /** Breaker internals, for tests and diagnostics. */
  readonly breakerState: () => {
    readonly consecutiveFailures: number;
    readonly disabledUntil: number;
    readonly backoffMs: number;
    readonly unsupportedFingerprint: string | null;
    readonly inflight: boolean;
  };
}

const loadPersisted = (
  storage: IslandCopyStorage,
  now: () => number,
): Map<string, { copy: IslandCopy; storedAt: number }> => {
  const entries = new Map<string, { copy: IslandCopy; storedAt: number }>();
  try {
    const raw = storage.getItem(PERSIST_KEY);
    if (raw === null) return entries;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return entries;
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length !== 4) continue;
      const [key, detail, compact, storedAt] = row as [unknown, unknown, unknown, unknown];
      if (
        typeof key !== "string" ||
        typeof detail !== "string" ||
        typeof compact !== "string" ||
        typeof storedAt !== "number"
      ) {
        continue;
      }
      if (now() - storedAt > LRU_TTL_MS) continue;
      entries.set(key, { copy: { detail, compact }, storedAt });
    }
    // The file is written oldest-first; keep the newest of it.
    while (entries.size > LRU_LIMIT) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return entries;
  } catch {
    return new Map();
  }
};

export const createIslandCopyGate = (options: IslandCopyGateOptions = {}): IslandCopyGate => {
  const now = options.now ?? (() => Date.now());
  const storage =
    options.storage === undefined
      ? ((): IslandCopyStorage | null => {
          try {
            return typeof localStorage === "undefined" ? null : localStorage;
          } catch {
            return null;
          }
        })()
      : options.storage;

  let loaded = false;
  const entries = new Map<string, { copy: IslandCopy; storedAt: number }>();
  const ensureLoaded = () => {
    if (loaded) return;
    loaded = true;
    if (storage === null) return;
    for (const [key, entry] of loadPersisted(storage, now)) entries.set(key, entry);
  };
  const persist = () => {
    if (storage === null) return;
    try {
      const rows = [...entries.entries()].map(([key, entry]) => [
        key,
        entry.copy.detail,
        entry.copy.compact,
        entry.storedAt,
      ]);
      storage.setItem(PERSIST_KEY, JSON.stringify(rows));
    } catch {
      // A full or blocked localStorage must never break the island.
    }
  };
  const prune = () => {
    for (const [key, entry] of entries) {
      if (now() - entry.storedAt > LRU_TTL_MS) entries.delete(key);
    }
    // Map order is oldest-inserted first; `cached` re-inserts on use, so this
    // eviction order is recency order.
    while (entries.size > LRU_LIMIT) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  // Circuit breaker and rate limiting live in memory: a restart may spend a
  // few tokens again, which is cheaper than persisting failure state that
  // could pin a healthy provider off forever.
  let consecutiveFailures = 0;
  let disabledUntil = 0;
  let backoffMs = BREAKER_BASE_MS;
  let unsupportedFingerprint: string | null = null;
  let inflight = false;
  const lastCallAt = new Map<string, number>();

  return {
    cached: (key) => {
      ensureLoaded();
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (now() - entry.storedAt > LRU_TTL_MS) {
        entries.delete(key);
        persist();
        return undefined;
      }
      // Refresh LRU position.
      entries.delete(key);
      entries.set(key, entry);
      return entry.copy;
    },
    decision: ({ scope, online, smartText, modelFingerprint }) => {
      if (!smartText) return { skip: "setting-off" };
      if (!online) return { skip: "offline" };
      // An unsupported provider latches until the model selection changes.
      if (unsupportedFingerprint !== null) {
        if (unsupportedFingerprint === modelFingerprint) return { skip: "unsupported" };
        unsupportedFingerprint = null;
      }
      if (disabledUntil > now()) return { skip: "breaker-open" };
      if (inflight) return { skip: "inflight" };
      const last = lastCallAt.get(scope);
      if (last !== undefined && now() - last < ISLAND_COPY_MIN_INTERVAL_MS) {
        return { skip: "rate-limited" };
      }
      return true;
    },
    start: (scope) => {
      inflight = true;
      lastCallAt.set(scope, now());
    },
    settle: () => {
      inflight = false;
    },
    succeed: (key, copy) => {
      ensureLoaded();
      consecutiveFailures = 0;
      disabledUntil = 0;
      backoffMs = BREAKER_BASE_MS;
      entries.delete(key);
      entries.set(key, { copy, storedAt: now() });
      prune();
      persist();
    },
    fail: (kind, modelFingerprint) => {
      if (kind === "unsupported") {
        unsupportedFingerprint = modelFingerprint ?? "";
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= BREAKER_THRESHOLD) {
        disabledUntil = now() + backoffMs;
        backoffMs = Math.min(backoffMs * 2, BREAKER_MAX_MS);
        consecutiveFailures = 0;
      }
    },
    breakerState: () => ({
      consecutiveFailures,
      disabledUntil,
      backoffMs,
      unsupportedFingerprint,
      inflight,
    }),
  };
};
