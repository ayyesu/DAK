import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://dak.codes",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
