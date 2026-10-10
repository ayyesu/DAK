import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CANVAS_BUDGETS,
  checkBudgets,
  isEmptyDrift,
  measureSnapshot,
  resolveModuleClosure,
  sha256,
  verifySnapshot,
  type CanvasVendorManifest,
} from "./canvas-vendor.ts";

const created: string[] = [];
const makeTree = async (files: Readonly<Record<string, string | Uint8Array>>) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "canvas-vendor-"));
  created.push(dir);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = NodePath.join(dir, relative);
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, contents);
  }
  return dir;
};

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("canvas module closure", () => {
  it("pulls in transitively imported modules", async () => {
    const dir = await makeTree({
      "src/entry.mjs": `import { a } from "./a.mjs";\nexport const b = a;\n`,
      "src/a.mjs": `import { c } from "./nested/c.mjs";\nexport const a = c;\n`,
      "src/nested/c.mjs": `export const c = 1;\n`,
    });
    const { files, missing } = await resolveModuleClosure(dir, ["src/entry.mjs"]);
    expect([...files].sort()).toEqual(["src/a.mjs", "src/entry.mjs", "src/nested/c.mjs"]);
    expect(missing).toEqual([]);
  });

  it("pulls in an import with no from clause, such as a stylesheet", async () => {
    const dir = await makeTree({
      "src/entry.mjs": `import "./styles.css";\nexport const a = 1;\n`,
      "src/styles.css": `body{}`,
    });
    const { files } = await resolveModuleClosure(dir, ["src/entry.mjs"]);
    expect([...files].sort()).toEqual(["src/entry.mjs", "src/styles.css"]);
  });

  it("ignores bare package specifiers, which the workspace resolves", async () => {
    const dir = await makeTree({
      "src/entry.mjs": `import * as Y from "yjs";\nimport x from "@dak/contracts";\nexport { Y, x };\n`,
    });
    const { files } = await resolveModuleClosure(dir, ["src/entry.mjs"]);
    expect([...files]).toEqual(["src/entry.mjs"]);
  });

  it("reports a missing module instead of skipping it", async () => {
    const dir = await makeTree({ "src/entry.mjs": `import "./gone.mjs";\n` });
    const { missing } = await resolveModuleClosure(dir, ["src/entry.mjs"]);
    // A silent omission would surface as a runtime failure inside the sandbox.
    expect(missing).toEqual(["src/gone.mjs"]);
  });

  it("does not escape the tree through a parent-relative import", async () => {
    const dir = await makeTree({
      "src/entry.mjs": `import "../../outside.mjs";\n`,
      "outside.mjs": `export const x = 1;\n`,
    });
    const { files } = await resolveModuleClosure(dir, ["src/entry.mjs"]);
    expect([...files]).toEqual(["src/entry.mjs"]);
  });

  it("terminates on a cycle", async () => {
    const dir = await makeTree({
      "src/entry.mjs": `import "./a.mjs";\n`,
      "src/a.mjs": `import "./entry.mjs";\nexport const a = 1;\n`,
    });
    const { files } = await resolveModuleClosure(dir, ["src/entry.mjs"]);
    expect([...files].sort()).toEqual(["src/a.mjs", "src/entry.mjs"]);
  });
});

describe("canvas snapshot drift", () => {
  const manifestFor = (files: Record<string, string>): CanvasVendorManifest => ({
    repository: "https://github.com/penkrahq/penkra-apps",
    upstreamPath: "canvas",
    revision: "abc123",
    generatedBy: "test",
    entryPoints: [],
    exclusions: [],
    files: Object.fromEntries(
      Object.entries(files).map(([file, contents]) => [
        file,
        sha256(new TextEncoder().encode(contents)),
      ]),
    ),
  });

  it("reports nothing for an untouched snapshot", async () => {
    const files = { "src/a.mjs": "export const a = 1;\n", "licenses/Inter-OFL.txt": "OFL\n" };
    const dir = await makeTree(files);
    expect(isEmptyDrift(await verifySnapshot(dir, manifestFor(files)))).toBe(true);
  });

  it("catches a local edit to vendored code", async () => {
    const files = { "src/a.mjs": "export const a = 1;\n" };
    const dir = await makeTree(files);
    await NodeFSP.writeFile(NodePath.join(dir, "src/a.mjs"), "export const a = 2;\n");
    expect((await verifySnapshot(dir, manifestFor(files))).modified).toEqual(["src/a.mjs"]);
  });

  it("catches a file added without being recorded", async () => {
    const files = { "src/a.mjs": "export const a = 1;\n" };
    const dir = await makeTree(files);
    await NodeFSP.writeFile(NodePath.join(dir, "src/sneaky.mjs"), "export const b = 1;\n");
    expect((await verifySnapshot(dir, manifestFor(files))).added).toEqual(["src/sneaky.mjs"]);
  });

  it("does not flag the manifest as an unrecorded addition", async () => {
    const files = { "src/a.mjs": "export const a = 1;\n" };
    const dir = await makeTree(files);
    await NodeFSP.writeFile(NodePath.join(dir, "vendor-manifest.json"), "{}\n");
    expect(isEmptyDrift(await verifySnapshot(dir, manifestFor(files)))).toBe(true);
  });

  it("catches a recorded file that is gone", async () => {
    const files = { "src/a.mjs": "export const a = 1;\n" };
    const dir = await makeTree(files);
    await NodeFSP.rm(NodePath.join(dir, "src/a.mjs"));
    expect((await verifySnapshot(dir, manifestFor(files))).missing).toEqual(["src/a.mjs"]);
  });
});

describe("canvas budgets", () => {
  it("passes a small snapshot", async () => {
    const dir = await makeTree({ "src/a.mjs": "export const a = 1;\n" });
    expect(await checkBudgets(dir)).toEqual([]);
  });

  it("counts shipped fonts separately from the snapshot total", async () => {
    const dir = await makeTree({
      "vendor/open-pencil/fonts/Inter-Regular.ttf": Buffer.from(NodeCrypto.randomBytes(4096)),
      "src/a.mjs": "export const a = 1;\n",
    });
    const sizes = await measureSnapshot(dir);
    expect(sizes.fontBytes).toBe(4096);
    expect(sizes.snapshotBytes).toBeGreaterThan(sizes.fontBytes);
    expect(await checkBudgets(dir)).toEqual([]);
  });

  it("fails when the engine grows past its gzip ceiling", async () => {
    // Random bytes, so gzip cannot hide the growth the way repetitive data would.
    const dir = await makeTree({
      "vendor/open-pencil/engine.source.mjs": NodeCrypto.randomBytes(
        CANVAS_BUDGETS.engineGzipBytes + 64 * 1024,
      ),
    });
    const sizes = await measureSnapshot(dir);
    expect(sizes.engineGzipBytes).toBeGreaterThan(CANVAS_BUDGETS.engineGzipBytes);
    expect((await checkBudgets(dir)).map((violation) => violation.what)).toContain("engine gzip");
  });
});
