import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { DakProjectFile, DAK_PROJECT_FILE_SCHEMA_URL } from "@dak/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `dak.json` file contents (lenient JSONC string) and the
 * decoded {@link DakProjectFile}.
 */
export const DakProjectFileFromJson = fromLenientJson(DakProjectFile);

const decodeDakProjectFile = Schema.decodeExit(DakProjectFileFromJson);

/**
 * Decode raw `dak.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseDakProjectFile(contents: string): DakProjectFile | null {
  const decoded = decodeDakProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `dak.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link DAK_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildDakProjectFileJsonSchema(): Record<string, unknown> {
  // Closed objects, as before effect rc.113 changed the generator default;
  // editors then flag unknown keys in dak.json.
  const document = Schema.toJsonSchemaDocument(DakProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: DAK_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
