/**
 * Thin React wrapper over `islandCopy.logic.ts`: deterministic copy first,
 * model copy when it lands within the timeout. The hook never blocks or
 * throws into the island; failures are reported to the gate's circuit breaker
 * and the deterministic copy stays on screen.
 */

import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import type { EnvironmentId, IslandCopySubject, ThreadId } from "@dak/contracts";
import { squashAtomCommandFailure } from "@dak/client-runtime/state/runtime";

import { useClientSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  ISLAND_COPY_TIMEOUT_MS,
  createIslandCopyGate,
  isIslandCopyRequestCurrent,
  isUnsupportedIslandError,
  islandCopyKey,
  validateIslandCopy,
  type IslandCopy,
} from "./islandCopy.logic";

// One gate per app: one request in flight across every environment, one
// breaker for the provider, one persisted LRU budget.
const gate = createIslandCopyGate();

export interface IslandCopyOptions {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  /** Rate-limit scope; the goal id, falling back to the copy key. */
  readonly scope?: string | undefined;
}

export const useIslandCopy = (
  subject: IslandCopySubject | null,
  fallback: IslandCopy,
  options: IslandCopyOptions,
): IslandCopy => {
  const smartText = useClientSettings((settings) => settings.islandSmartText);
  const [copy, setCopy] = useState<IslandCopy>(fallback);
  const currentKey = subject === null ? null : islandCopyKey(subject);
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;
  const requestRef = useRef(0);
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(options.environmentId));
  const modelFingerprint = JSON.stringify(serverSettings?.textGenerationModelSelection ?? null);

  const generate = useAtomCommand(serverEnvironment.islandGenerateCopy, {
    reportFailure: false,
    reportDefect: false,
  });

  // Deterministic copy wins until model copy actually lands: when the
  // fallback changes, drop back to it unless the LLM copy for this exact
  // subject is already cached.
  const fallbackDetail = fallback.detail;
  const fallbackCompact = fallback.compact;
  useEffect(() => {
    setCopy((previous) => {
      if (previous.detail === fallbackDetail && previous.compact === fallbackCompact) {
        return previous;
      }
      const cached = currentKey === null ? undefined : gate.cached(currentKey);
      return cached ?? { detail: fallbackDetail, compact: fallbackCompact };
    });
  }, [fallbackDetail, fallbackCompact, currentKey]);

  // Turning the setting off puts the deterministic lines straight back, even
  // if model copy is on screen.
  useEffect(() => {
    if (smartText) return;
    setCopy({ detail: fallbackDetail, compact: fallbackCompact });
  }, [smartText, fallbackDetail, fallbackCompact]);

  const { environmentId, threadId } = options;
  const scope = options.scope ?? currentKey ?? "island";
  useEffect(() => {
    if (subject === null || currentKey === null) return;
    if (!smartText) return;
    // Without a thread there is no project to resolve the model selection
    // against; the fallback stays.
    if (threadId === null) return;
    const key = currentKey;
    const cached = gate.cached(key);
    if (cached !== undefined) {
      setCopy(cached);
      return;
    }
    const online = typeof navigator === "undefined" ? false : navigator.onLine;
    if (gate.decision({ scope, online, smartText, modelFingerprint }) !== true) return;
    const requestId = (requestRef.current += 1);
    gate.start(scope);
    const startedAt = Date.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      gate.settle();
      // The 4 s budget is the product contract: a slower answer is useless on
      // the island, and it counts against the breaker like any failure.
      if (requestRef.current === requestId) gate.fail("failure", modelFingerprint);
    }, ISLAND_COPY_TIMEOUT_MS);
    void generate({ environmentId, input: { threadId, subject } }).then(
      (result) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        gate.settle();
        if (!isIslandCopyRequestCurrent(key, currentKeyRef.current, Date.now() - startedAt)) {
          return;
        }
        if (requestRef.current !== requestId) return;
        if (result._tag !== "Success") {
          gate.fail(
            isUnsupportedIslandError(squashAtomCommandFailure(result)) ? "unsupported" : "failure",
            modelFingerprint,
          );
          return;
        }
        const valid = validateIslandCopy(result.value);
        if (valid === null) {
          gate.fail("failure", modelFingerprint);
          return;
        }
        gate.succeed(key, valid);
        setCopy(valid);
      },
      () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        gate.settle();
        gate.fail("failure", modelFingerprint);
      },
    );
    return () => {
      clearTimeout(timer);
      // The request may still be in flight server-side; the in-flight marker
      // clears when it settles. Late answers are discarded by the timeout
      // above and the requestId/currentKey checks.
    };
  }, [currentKey, smartText, environmentId, threadId, modelFingerprint, scope, generate]);

  return copy;
};
