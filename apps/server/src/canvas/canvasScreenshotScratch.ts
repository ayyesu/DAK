// @effect-diagnostics nodeBuiltinImport:off - This writes screenshot scratch files to disk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { base64ToBytes } from "./bytes.ts";
import type { CanvasScreenshotPart } from "./canvasScreenshot.ts";

/**
 * Where a screenshot is written when a caller cannot see an image block.
 *
 * Two shapes of harness exist and there is no way to tell from inside the server which one is on the
 * other end: some models receive MCP image content and look at it, some only ever see the tool's
 * text. So a screenshot is written to a file and the path is returned in the text as well as the
 * image being attached. A model that can read files opens it; a model that can see images does not
 * need to.
 *
 * Gitignored, because a screenshot is a byproduct of a conversation and not source.
 */
const CANVAS_SCREENSHOT_SCRATCH = ".dak/canvas-screenshots";

const SCRIPTS_IGNORED = ".dak/";

/**
 * Writes the parts to disk and returns their paths.
 *
 * Best effort: a screenshot that has already been produced must not be lost because the workspace is
 * read-only or the scratch directory could not be made. The caller still gets the image block, and
 * the failure is reported rather than swallowed.
 */
export const writeScratchScreenshots = async (
  workspaceRoot: string,
  documentId: string,
  parts: ReadonlyArray<CanvasScreenshotPart>,
): Promise<{ readonly paths: ReadonlyArray<string>; readonly error?: string }> => {
  try {
    const directory = NodePath.join(workspaceRoot, CANVAS_SCREENSHOT_SCRATCH, documentId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const paths: string[] = [];
    for (const [index, part] of parts.entries()) {
      const name = `${String(index).padStart(2, "0")}-${part.role}-y${Math.round(part.y)}.png`;
      const file = NodePath.join(directory, name);
      await NodeFSP.writeFile(file, base64ToBytes(part.image.data));
      paths.push(file);
    }
    return { paths };
  } catch (error) {
    return {
      paths: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
