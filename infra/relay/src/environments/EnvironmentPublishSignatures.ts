import {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityPublishProofInvalidReason,
} from "@dak/contracts/relay";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_ACTIVITY_PUBLISH_TYP,
  verifyRelayJwt,
} from "@dak/shared/relayJwt";
import { stableStringify } from "@dak/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";

export class EnvironmentPublishSignatureExpired extends Schema.TaggedError<EnvironmentPublishSignatureExpired>()(
  "EnvironmentPublishSignatureExpired",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' publish signature for thread '${this.threadId}' expired at ${this.expiresAt}`;
  }
}

export class EnvironmentPublishSignatureInvalid extends Schema.TaggedError<EnvironmentPublishSignatureInvalid>()(
  "EnvironmentPublishSignatureInvalid",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    reason: RelayAgentActivityPublishProofInvalidReason,
    stage: Schema.Literals([
      "decode_token",
      "verify_proof",
      "validate_claims",
      "validate_expiration",
      "generate_replay_thumbprint",
      "consume_nonce",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' publish signature for thread '${this.threadId}' is invalid during ${this.stage}: ${this.reason}`;
  }
}

export class EnvironmentPublishPublicKeyMissing extends Schema.TaggedError<EnvironmentPublishPublicKeyMissing>()(
  "EnvironmentPublishPublicKeyMissing",
  {
    environmentId: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' has no publish public key`;
  }
}

export type EnvironmentPublishSignatureError =
  | EnvironmentPublishSignatureExpired
  | EnvironmentPublishSignatureInvalid
  | EnvironmentPublishPublicKeyMissing
  | DpopProofs.DpopProofReplayPersistenceError;

export class EnvironmentPublishSignatures extends Context.Service<
  EnvironmentPublishSignatures,
  {}
>()("dak-relay/environments/EnvironmentPublishSignatures") {}

export const layer = Layer.succeed(EnvironmentPublishSignatures, {});
