import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

type AdvertisedObject = {
  properties: Record<string, unknown>;
  required?: Array<string>;
};

const schemaFor = <S extends Schema.Top>(parameters: S) =>
  advertisedJsonSchema(Tool.make("sample", { parameters })) as AdvertisedObject;

it("drops the null branch optional properties add", () => {
  const schema = schemaFor(Schema.Struct({ path: Schema.optional(Schema.String) }));

  expect(schema.properties).toEqual({ path: { type: "string" } });
  expect(schema.required ?? []).toEqual([]);
});

it("merges a tagged union of objects into one object", () => {
  const schema = schemaFor(
    Schema.Struct({
      body: Schema.Union([
        Schema.Struct({ action: Schema.Literal("read"), id: Schema.String }),
        Schema.Struct({ action: Schema.Literal("write"), id: Schema.String, text: Schema.String }),
      ]),
    }),
  );

  expect(schema.properties.body).toEqual({
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "write"] },
      id: { type: "string" },
      text: { type: "string" },
    },
    required: ["action", "id"],
  });
});

it("keeps an object branch instead of advertising a stringified fallback beside it", () => {
  const schema = schemaFor(
    Schema.Union([Schema.Struct({ path: Schema.String }), Schema.fromJsonString(Schema.Unknown)]),
  );

  expect(schema).toEqual({
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  });
});

it("drops the safe-integer bounds that every integer schema carries", () => {
  const schema = schemaFor(Schema.Struct({ count: Schema.Int }));

  expect(schema.properties.count).toEqual({ type: "integer" });
});
