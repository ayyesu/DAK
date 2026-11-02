"use client";

import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@dak/client-runtime/state/runtime";
import type { EnvironmentId, OpenCodeAccount, ProviderInstanceId } from "@dak/contracts";
import { CheckIcon } from "lucide-react";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";

/**
 * Switches which stored account an OpenCode instance uses. A switch stops
 * this instance's sessions and retires its servers, so the provider snapshot
 * refreshes on its own — the caller never refreshes providers by hand.
 */
export function OpenCodeAccountSwitcher({
  environmentId,
  instanceId,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly?: boolean;
}) {
  const commands = { reportFailure: false, reportDefect: false };
  const listAccounts = useAtomCommand(serverEnvironment.listOpenCodeAccounts, commands);
  const switchAccount = useAtomCommand(serverEnvironment.switchOpenCodeAccount, commands);
  const canSwitch = useAtomValue(
    serverEnvironment.switchOpenCodeAccount.permissionAtom(environmentId),
  );
  const [accounts, setAccounts] = useState<readonly OpenCodeAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const loadedRef = useRef(false);

  async function load() {
    if (loadingRef.current || loadedRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await listAccounts({ environmentId, input: { instanceId } });
      if (result._tag === "Success") {
        loadedRef.current = true;
        setAccounts(result.value.accounts);
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not list accounts.");
      }
    } catch {
      setError("Could not list accounts.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  async function pick(credentialId: string) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setPendingId(credentialId);
    setError(null);
    try {
      const result = await switchAccount({
        environmentId,
        input: { instanceId, credentialId },
      });
      if (result._tag === "Success") {
        loadedRef.current = true;
        setAccounts(result.value.accounts);
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not switch accounts.");
      }
    } catch {
      setError("Could not switch accounts.");
    } finally {
      loadingRef.current = false;
      setPendingId(null);
    }
  }

  if (!canSwitch) return null;
  const active = accounts?.find((account) => account.active);
  const activeLabel = active?.label.trim() || "Active account";

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) void load();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            disabled={readOnly}
            aria-label={`Switch account: currently ${activeLabel}`}
          >
            Switch account
          </Button>
        }
      />
      <PopoverPopup side="bottom" align="start" width="md" aria-label="Switch account">
        <div className="grid min-w-0 gap-2">
          <p className="text-xs font-medium text-muted-foreground">Account used by this instance</p>
          {loading ? (
            <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <Spinner tone="muted" size="sm" />
              Loading accounts…
            </div>
          ) : accounts === null || accounts.length === 0 ? (
            <p className="text-xs leading-snug text-muted-foreground">
              No stored accounts found for this instance.
            </p>
          ) : (
            <ul className="grid min-w-0 gap-1">
              {accounts.map((account) => {
                const label = account.label.trim() || "Account";
                const isPending = pendingId === account.credentialId;
                return (
                  <li key={account.credentialId}>
                    <Button
                      type="button"
                      size="sm"
                      variant={account.active ? "secondary" : "ghost-muted"}
                      className="w-full justify-start"
                      disabled={account.active || pendingId !== null}
                      onClick={() => void pick(account.credentialId)}
                    >
                      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                      {account.active ? <CheckIcon className="shrink-0" /> : null}
                      {isPending ? <Spinner tone="muted" size="sm" /> : null}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {error ? (
            <p aria-live="polite" className="text-xs leading-snug text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
