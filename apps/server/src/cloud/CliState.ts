import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

export const CLOUD_CLI_DESIRED_LINK_SECRET = "cloud-cli-desired-link";

export type CliDesiredLinkMode = "managed";

const MANAGED_BYTES = new TextEncoder().encode("managed");

export const readCliDesiredCloudLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return Option.isSome(yield* secrets.get(CLOUD_CLI_DESIRED_LINK_SECRET));
});

export const readCliDesiredLinkMode = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const value = yield* secrets.get(CLOUD_CLI_DESIRED_LINK_SECRET);
  if (Option.isNone(value)) {
    return "managed" as CliDesiredLinkMode;
  }
  return "managed" as CliDesiredLinkMode;
});

export const setCliDesiredCloudLink = Effect.fn("cloud.cli_state.set_desired")(function* (
  desired: boolean,
  mode: CliDesiredLinkMode = "managed",
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  if (desired) {
    yield* secrets.set(CLOUD_CLI_DESIRED_LINK_SECRET, MANAGED_BYTES);
  } else {
    yield* secrets.remove(CLOUD_CLI_DESIRED_LINK_SECRET);
  }
});

export const clearPersistedCloudLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* Effect.all(
    [
      secrets.remove(CLOUD_CLI_DESIRED_LINK_SECRET),
      secrets.remove(CLOUD_LINKED_USER_ID),
      secrets.remove(RELAY_URL_SECRET),
      secrets.remove(RELAY_ISSUER_SECRET),
      secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      secrets.remove(CLOUD_MINT_PUBLIC_KEY),
      secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN),
    ],
    { concurrency: "unbounded" },
  );
});
