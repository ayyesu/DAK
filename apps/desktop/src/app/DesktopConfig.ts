import { OtlpHeadersFromString, OtlpProtocol } from "@dak/shared/observability";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.Boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  dakHome: trimmedString("DAK_HOME"),
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("DAK_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteDakServerEntryPath: trimmedString("DAK_DEV_REMOTE_DAK_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.Port("DAK_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("DAK_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("DAK_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("DAK_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: trimmedString("DAK_OTLP_TRACES_URL"),
  otlpMetricsUrl: trimmedString("DAK_OTLP_METRICS_URL"),
  otlpLogsUrl: trimmedString("DAK_OTLP_LOGS_URL"),
  otlpExportIntervalMs: Config.Int("DAK_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "DAK_OTLP_HEADERS").pipe(Config.option),
  otlpProtocol: Config.schema(OtlpProtocol, "DAK_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("DAK_DISABLE_AUTO_UPDATE"),
  mockUpdates: optionalBoolean("DAK_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.Port("DAK_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
