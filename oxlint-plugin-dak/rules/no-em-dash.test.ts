import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

// Fixtures carry the banned character, so they are assembled from escapes rather than typed:
// a raw one here would trip the very rule these tests exercise when the repo is linted.
const EM_DASH = "\u2014";

const rule = createOxlintRuleHarness("dak/no-em-dash", { filename: "fixture.ts" });
const astro = createOxlintRuleHarness("dak/no-em-dash", { filename: "fixture.astro" });

describe("dak/no-em-dash", () => {
  rule.valid(
    "allows prose that breaks its sentence another way",
    `// The lock both lives in and creates the userData directory: keep both.`,
  );

  rule.valid("allows a hyphen used as a dash", `const hint = "slow to cold-boot - shows a hint";`);

  rule.valid("allows an en dash in a range", 'const span = "lines 1\u20139";');

  rule.valid(
    "allows the escape sequence rather than the character",
    String.raw`const marker = "a\u2014b";`,
  );

  rule.invalid(
    "reports an em dash in a comment",
    `// The lock both lives in and creates the directory${EM_DASH}so keep both.`,
    (output) => {
      assert.match(output, /No em dash\./);
    },
  );

  rule.invalid("reports an em dash in a string literal", `const hint = "left${EM_DASH}right";`);

  rule.invalid("reports an em dash in a template literal", `const hint = \`left${EM_DASH}right\`;`);

  rule.invalid(
    "reports every em dash in the file",
    `const a = "one${EM_DASH}one";\nconst b = "two${EM_DASH}two";`,
    (output) => {
      assert.strictEqual(output.split("dak(no-em-dash)").length - 1, 2);
    },
  );

  astro.valid("allows an astro file with no em dash", "---\nconst x = 1;\n---\n<p>hello</p>\n");

  astro.invalid(
    "reports an em dash in astro frontmatter at its own line",
    `---\n// reads the repo${EM_DASH}then plans\nconst x = 1;\n---\n<p>hi</p>\n`,
    (output) => {
      // oxlint gives the rule the frontmatter body and adds the opening delimiter back on output.
      assert.match(output, /fixture\.astro:2:/);
      assert.match(output, /No em dash\./);
    },
  );

  astro.invalid(
    "reports an em dash in astro template text and names its line",
    `---\nconst x = 1;\n---\n<p>left${EM_DASH}right</p>\n`,
    (output) => {
      assert.match(output, /No em dash on line 4\./);
    },
  );
});
