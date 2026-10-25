// @effect-diagnostics nodeBuiltinImport:off - An oxlint rule visitor runs to completion synchronously, so Effect's FileSystem has no entry point for this read.
import * as NodeFS from "node:fs";

import { defineRule } from "@oxlint/plugins";

// Written as an escape so this file, and every fixture that quotes it, stays free of the
// character it bans. The rule only matches the raw character, not `\u2014` in source.
const EM_DASH = "\u2014";

const FIX = "End the sentence, split it in two, or join the halves with a comma or colon.";

/** Offset at which each line of `text` begins, so a raw index becomes a line number. */
const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
};

/** 1-indexed line holding `index`, by bisecting `starts`. */
const lineAt = (starts: readonly number[], index: number): number => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
};

/**
 * An Astro file's template, which the parser hands the rule none of: only the frontmatter body
 * arrives as source, so template prose has no position the diagnostic can point at. The file is
 * re-read for that one case, returning where its template starts.
 */
const astroTemplate = (filename: string): { text: string; from: number } | null => {
  if (!filename.toLowerCase().endsWith(".astro")) return null;
  try {
    const text = NodeFS.readFileSync(filename, "utf8");
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    return frontmatter ? { text, from: frontmatter.index + frontmatter[0].length } : null;
  } catch {
    // A buffer that never reached disk, such as an untitled document.
    return null;
  }
};

/** Reports every em dash in the file, in prose and comments alike. */
export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow the em dash in source.",
    },
  },
  create(context) {
    const { filename, sourceCode } = context;
    return {
      "Program:exit"() {
        const { text } = sourceCode;
        for (let at = text.indexOf(EM_DASH); at !== -1; at = text.indexOf(EM_DASH, at + 1)) {
          context.report({
            loc: {
              start: sourceCode.getLocFromIndex(at),
              end: sourceCode.getLocFromIndex(at + EM_DASH.length),
            },
            message: `No em dash. ${FIX}`,
          });
        }

        // Template hits are anchored to the start of the frontmatter, the one place oxlint
        // accepts a location for these files, and carry their real line in the message.
        const template = astroTemplate(filename);
        if (!template) return;
        const starts = lineStarts(template.text);
        const { text: file, from } = template;
        for (let at = file.indexOf(EM_DASH, from); at !== -1; at = file.indexOf(EM_DASH, at + 1)) {
          context.report({
            loc: { start: { line: 1, column: 0 } },
            message: `No em dash on line ${lineAt(starts, at)}. ${FIX}`,
          });
        }
      },
    };
  },
});
