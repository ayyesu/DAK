// @effect-diagnostics nodeBuiltinImport:off - Base64 over buffers, which is a Node concern.
export const base64ToBytes = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64"));

/**
 * The first bytes of a PNG, so a caller can tell a real image from a text payload that claimed to
 * be one without decoding the whole thing.
 */
export const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 &&
  bytes[0] === 0x89 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x4e &&
  bytes[3] === 0x47;
