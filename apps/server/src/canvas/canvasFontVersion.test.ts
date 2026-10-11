// @effect-diagnostics nodeBuiltinImport:off - The subject is path resolution against two real
// directory layouts, and the packaged one is built as a real directory to be read.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { canvasFontDirectories, fontSetVersion, fontSetVersionFrom } from "./canvasNormalize.ts";

/**
 * The measurement cache is keyed partly on the shipped font bytes, and that key is built on the
 * render path. Reading the faces from a repo-relative path is correct only in the source tree; in a
 * bundle the module is a chunk in the server's `dist`, four levels up is outside the repository, and
 * the faces are staged flat beside the chunk instead. The `ENOENT` from that read failed every
 * render, screenshot and export in every packaged and desktop build — the panel showed "This design
 * could not be rendered right now" — while `vp run dev` rendered the same design happily.
 *
 * These tests exercise the packaged layout directly, which is the whole point: a check that can only
 * run from the source tree cannot fail for the reason the product failed.
 */

const roots: string[] = [];

/** A stand-in for `apps/server/dist`, with the faces `place-canvas-assets` stages beside the chunk. */
const makeStagedBundle = (): { directory: string; moduleUrl: URL } => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dak-canvas-bundle-"));
  roots.push(directory);
  NodeFS.writeFileSync(NodePath.join(directory, "Inter-Regular.ttf"), "first");
  NodeFS.writeFileSync(NodePath.join(directory, "playfair-display-700.ttf"), "display");
  return { directory, moduleUrl: NodeURL.pathToFileURL(NodePath.join(directory, "bin.mjs")) };
};

afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("font set version", () => {
  it("searches the module's own directory first, which is the only one a bundle has", () => {
    const bundle = makeStagedBundle();
    const directories = canvasFontDirectories(bundle.moduleUrl);
    expect(directories[0]).toBe(bundle.directory);
  });

  it("reads a bundled layout without throwing when the repository is not beside it", () => {
    const bundle = makeStagedBundle();
    const version = fontSetVersionFrom(canvasFontDirectories(bundle.moduleUrl));
    expect(version).toMatch(/^[0-9a-f]{16}$/u);
    // The staged faces are what was hashed, so the version is not the hash of nothing.
    expect(version).not.toBe(fontSetVersionFrom([]));
  });

  it("changes when a staged face changes, so a font swap invalidates cached measurements", () => {
    const bundle = makeStagedBundle();
    const before = fontSetVersionFrom(canvasFontDirectories(bundle.moduleUrl));
    NodeFS.writeFileSync(NodePath.join(bundle.directory, "Inter-Regular.ttf"), "second");
    expect(fontSetVersionFrom(canvasFontDirectories(bundle.moduleUrl))).not.toBe(before);
  });

  it("finds the vendored and DAK-owned faces from the source tree", () => {
    const repoRoot = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const directories = canvasFontDirectories();
    expect(directories).toContain(NodePath.join(repoRoot, "packages", "canvas-engine", "fonts"));
    // The real faces are there, so the version this process uses is a hash of actual bytes.
    expect(fontSetVersion()).toMatch(/^[0-9a-f]{16}$/u);
  });
});
