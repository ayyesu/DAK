import {
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@dak/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const CLOUD_MINT_PUBLIC_KEY = "cloud-mint-ed25519-public-key";
export const CLOUD_ENDPOINT_RUNTIME_CONFIG = "cloud-endpoint-runtime-config";
export const CLOUD_ENDPOINT_CONFIRMED_ORIGIN = "cloud-endpoint-confirmed-origin";
export const CLOUD_LINKED_USER_ID = "cloud-linked-user-id";
export const RELAY_URL_SECRET = "cloud-relay-url";
export const RELAY_ISSUER_SECRET = "cloud-relay-issuer";
export const RELAY_ENVIRONMENT_CREDENTIAL_SECRET = "cloud-relay-environment-credential";
export const HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET = "cloud-hold-webhooks-while-offline";

export const encodeEndpointRuntimeConfigJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export const decodeRuntimeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export const ManagedEndpointConfirmedOrigin = Schema.Struct({
  config: RelayManagedEndpointRuntimeConfig,
  origin: RelayManagedEndpointOrigin,
});

export const encodeConfirmedOriginJson = Schema.encodeEffect(
  Schema.fromJsonString(ManagedEndpointConfirmedOrigin),
);

export const decodeConfirmedOrigin = Schema.decodeUnknownOption(
  Schema.fromJsonString(ManagedEndpointConfirmedOrigin),
);

/** A non-empty secret as text, or null when it is missing, empty or unreadable. */
const readSecretString = (name: string) =>
  ServerSecretStore.ServerSecretStore.pipe(
    Effect.flatMap((secrets) => secrets.get(name)),
    Effect.map((bytes) =>
      Option.isSome(bytes) && bytes.value.length > 0 ? new TextDecoder().decode(bytes.value) : null,
    ),
    Effect.orElseSucceed(() => null),
  );

/** The relay URL and environment credential, or null when not linked to DAK Connect. */
export const readRelayConnection = Effect.all([
  readSecretString(RELAY_URL_SECRET),
  readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
]).pipe(
  Effect.map(([url, environmentCredential]) =>
    url && environmentCredential ? { url, environmentCredential } : null,
  ),
);

/** Whether this environment opted in to DAK Connect holding webhooks while it is offline. */
export const readHoldWebhooksWhileOffline = readSecretString(
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
).pipe(Effect.map((value) => value === "true"));
