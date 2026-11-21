import { AuthSettingsWriteScope, type EnvironmentId, type McpConnector } from "@dak/contracts";
import { squashAtomCommandFailure } from "@dak/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentQuery } from "~/state/query";
import { mcpConnectorEnvironment } from "~/state/mcpConnectors";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import {
  CONNECTOR_POLL_INTERVAL_MS,
  checkCustomUrl,
  connectFailureMessage,
  connectorDisplayUrl,
  connectorStatusPresentation,
  describeConnectorProviders,
  groupPresets,
  shouldPollConnectors,
} from "./McpConnectorsSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CUSTOM_TARGET = "custom";

export function McpConnectorsSettings() {
  const { environment: selected } = useSettingsScope();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;
  const environmentId = connected ? selected.environmentId : null;

  return (
    <SettingsSection id="connectors" title="Connectors">
      {environmentId === null ? (
        <SettingsRow
          title="No environment connected"
          description="Connect to an environment to manage the MCP servers its agents can use."
        />
      ) : (
        <McpConnectorsControls key={environmentId} environmentId={environmentId} />
      )}
    </SettingsSection>
  );
}

function McpConnectorsControls({ environmentId }: { environmentId: EnvironmentId }) {
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(mcpConnectorEnvironment.list({ environmentId, input: {} }));
  const connect = useAtomCommand(mcpConnectorEnvironment.connect, { reportFailure: false });
  const disconnect = useAtomCommand(mcpConnectorEnvironment.disconnect, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ target: string; message: string } | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const [showNeedsSignIn, setShowNeedsSignIn] = useState(false);

  const { data, refresh, dataUpdatedAt } = query;
  const polling = shouldPollConnectors(data);
  // The server answers fast and finishes slow health checks in the background,
  // so read again until it says the pass is over.
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(refresh, CONNECTOR_POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [polling, refresh, dataUpdatedAt]);

  const busy = pending !== null;
  const disabled = !canConfigure || busy;
  const connectors = data?.connectors ?? [];
  const groups = groupPresets(data?.presets ?? [], connectors);
  const atLimit = data !== null && data.remaining === 0;
  const urlCheck = checkCustomUrl(customUrl);

  const runConnect = async (
    target: string,
    input: { presetId?: string; url?: string; name?: string },
    label: string,
  ): Promise<boolean> => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return false;
    setPending(target);
    setNotice(null);
    try {
      const result = await connect({ environmentId, input });
      if (result._tag === "Failure") {
        setNotice({ target, message: connectFailureMessage(squashAtomCommandFailure(result)) });
        return false;
      }
      const { status } = result.value.connector;
      if (status === "connected") {
        toastManager.add({ type: "success", title: `${label} is connected` });
      } else {
        toastManager.add({
          type: "warning",
          title: `${label} is still ${status === "unreachable" ? "unreachable" : "signed out"}`,
        });
      }
      refresh();
      return true;
    } finally {
      setPending(null);
    }
  };

  const handleRemove = async (connector: McpConnector) => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    const confirmation = requestConfirmDialog(
      `Remove ${connector.name}?\nNew agent sessions will stop receiving its tools. You can add it again later.`,
      { variant: "destructive" },
    );
    if (confirmation && !(await confirmation)) return;
    const target = `remove:${connector.connectorId}`;
    setPending(target);
    setNotice(null);
    try {
      const result = await disconnect({
        environmentId,
        input: { connectorId: connector.connectorId },
      });
      if (result._tag === "Failure") {
        setNotice({ target, message: connectFailureMessage(squashAtomCommandFailure(result)) });
        return;
      }
      toastManager.add({ type: "success", title: `Removed ${connector.name}` });
      refresh();
    } finally {
      setPending(null);
    }
  };

  const handleCustomSubmit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (urlCheck.kind !== "valid" || disabled || atLimit) return;
    const name = customName.trim();
    const connected = await runConnect(
      CUSTOM_TARGET,
      { url: urlCheck.url, ...(name.length > 0 ? { name } : {}) },
      name.length > 0 ? name : connectorDisplayUrl(urlCheck.url),
    );
    if (connected) {
      setCustomUrl("");
      setCustomName("");
    }
  };

  if (data === null && query.error !== null) {
    return (
      <SettingsRow
        title="Could not load connectors"
        description={query.error}
        control={
          <Button size="xs" variant="outline" onClick={refresh}>
            Try again
          </Button>
        }
      />
    );
  }
  if (data === null) {
    return <SettingsRow title="Loading connectors…" />;
  }

  const noticeFor = (target: string) =>
    notice?.target === target ? (
      <p role="alert" className="mt-1.5 text-xs text-destructive-foreground">
        {notice.message}
      </p>
    ) : null;

  return (
    <>
      <SettingsRow
        title="MCP servers for agents"
        description={`${describeConnectorProviders()} sessions get the tools of every server below. Changes apply to new sessions. Requests go through this environment, so a server never sees your agent session's credentials.`}
        control={
          data.checking ? (
            <span className="text-xs text-muted-foreground" role="status">
              Checking status…
            </span>
          ) : null
        }
      />

      {connectors.length === 0 ? (
        <SettingsRow
          title="No servers connected yet"
          description="Pick one below, or paste the URL of any remote MCP server."
        />
      ) : (
        connectors.map((connector) => {
          const presentation = connectorStatusPresentation(connector.status);
          return (
            <SettingsRow
              key={connector.connectorId}
              title={connector.name}
              description={
                <>
                  <span className="font-mono">{connectorDisplayUrl(connector.url)}</span>
                  {presentation.hint === null ? null : (
                    <span className="block">{presentation.hint}</span>
                  )}
                </>
              }
              control={
                <div className="flex items-center gap-2">
                  <Badge variant={presentation.variant}>{presentation.label}</Badge>
                  {connector.status === "connected" ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void runConnect(
                          `retry:${connector.connectorId}`,
                          { url: connector.url },
                          connector.name,
                        )
                      }
                    >
                      {pending === `retry:${connector.connectorId}` ? "Checking…" : "Retry"}
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost-destructive"
                    disabled={disabled}
                    aria-label={`Remove ${connector.name}`}
                    onClick={() => void handleRemove(connector)}
                  >
                    Remove
                  </Button>
                </div>
              }
            >
              {noticeFor(`retry:${connector.connectorId}`) ??
                noticeFor(`remove:${connector.connectorId}`)}
            </SettingsRow>
          );
        })
      )}

      {groups.available.map((preset) => (
        <SettingsRow
          key={preset.presetId}
          title={preset.name}
          description={<span className="font-mono">{connectorDisplayUrl(preset.url)}</span>}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || atLimit}
              onClick={() =>
                void runConnect(
                  `preset:${preset.presetId}`,
                  { presetId: preset.presetId },
                  preset.name,
                )
              }
            >
              {pending === `preset:${preset.presetId}` ? "Connecting…" : "Connect"}
            </Button>
          }
        >
          {noticeFor(`preset:${preset.presetId}`)}
        </SettingsRow>
      ))}

      <SettingsRow
        title="Custom server"
        description={
          atLimit
            ? "This environment has reached its connector limit. Remove one to add another."
            : "Paste the URL of a remote MCP server that speaks streamable HTTP."
        }
      >
        <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={handleCustomSubmit}>
          <Input
            aria-label="Server URL"
            aria-invalid={urlCheck.kind === "invalid"}
            placeholder="https://mcp.example.com/mcp"
            value={customUrl}
            disabled={disabled || atLimit}
            onChange={(event) => setCustomUrl(event.target.value)}
            font="mono"
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            aria-label="Name (optional)"
            placeholder="Name (optional)"
            className="sm:w-48"
            value={customName}
            disabled={disabled || atLimit}
            onChange={(event) => setCustomName(event.target.value)}
            autoComplete="off"
          />
          <Button
            type="submit"
            size="sm"
            disabled={disabled || atLimit || urlCheck.kind !== "valid"}
          >
            {pending === CUSTOM_TARGET ? "Connecting…" : "Add"}
          </Button>
        </form>
        {urlCheck.kind === "invalid" ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{urlCheck.message}</p>
        ) : null}
        {noticeFor(CUSTOM_TARGET)}
      </SettingsRow>

      {groups.needsSignIn.length === 0 ? null : (
        <SettingsRow
          title="Needs sign-in"
          description={`${groups.needsSignIn.length} popular servers sign you in with your account, which is not supported yet. They cannot be connected until it is.`}
          control={
            <Button
              size="xs"
              variant="ghost-muted"
              aria-expanded={showNeedsSignIn}
              onClick={() => setShowNeedsSignIn((open) => !open)}
            >
              {showNeedsSignIn ? "Hide" : "Show"}
            </Button>
          }
        >
          {showNeedsSignIn ? (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {groups.needsSignIn.map((preset) => (
                <li key={preset.presetId}>
                  <Badge variant="outline">{preset.name}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </SettingsRow>
      )}
    </>
  );
}
