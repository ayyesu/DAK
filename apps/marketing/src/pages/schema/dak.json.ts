import type { APIRoute } from "astro";

import { buildDakProjectFileJsonSchema } from "@dak/shared/dakProjectFile";

// Rendered at build time; published at https://dak.codes/schema/dak.json so
// dak.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildDakProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
