import { describe, expect, it } from "vite-plus/test";

import {
  assertNoPermanentDeleteTool,
  authoritativeSequence,
  checkExecutionResultLimits,
  checkExportDestination,
  decideConflictRetry,
  detectFrameOverflow,
  detectModuleViewportMismatch,
  isProjectionCurrent,
  isSafeFilenameSegment,
  resolveImplicitLayout,
  resolveTrashConfirmation,
  summarizeReviewIssues,
  withImplicitAbsoluteLayout,
} from "./canvasInvariants.ts";

describe("canvas authoritative sequence", () => {
  it("takes the highest of the snapshot and the update log", () => {
    expect(
      authoritativeSequence({
        snapshot: { throughSequence: 4 },
        updates: [{ sequence: 9 }, { sequence: 6 }],
      }),
    ).toBe(9);
  });

  it("recovers when a crash leaves the snapshot behind the committed log", () => {
    // Compaction is best-effort and runs after the append commits, so this is
    // the normal state after a failed compaction, not a corruption.
    const payload = { snapshot: { throughSequence: 3 }, updates: [{ sequence: 7 }] };
    expect(authoritativeSequence(payload)).toBe(7);
    expect(isProjectionCurrent(payload)).toBe(false);
  });

  it("reads 0 for a document with no snapshot and no updates", () => {
    expect(authoritativeSequence({})).toBe(0);
    expect(isProjectionCurrent({})).toBe(true);
  });

  it("treats a snapshot with no pending updates as current", () => {
    const payload = { snapshot: { throughSequence: 12 }, updates: [] };
    expect(authoritativeSequence(payload)).toBe(12);
    expect(isProjectionCurrent(payload)).toBe(true);
  });

  it("reports a compacted design as current even though its log is long", () => {
    // The log is never truncated, so a design that has been edited many times carries many
    // updates forever. Counting them instead of comparing sequences marked every edited design
    // permanently behind, which is what pinned "This view may be a moment behind the design" to
    // the panel.
    const payload = {
      snapshot: { throughSequence: 26 },
      updates: Array.from({ length: 26 }, (_, index) => ({ sequence: index + 1 })),
    };
    expect(authoritativeSequence(payload)).toBe(26);
    expect(isProjectionCurrent(payload)).toBe(true);
  });

  it("reports a design as behind while compaction trails the log", () => {
    expect(
      isProjectionCurrent({ snapshot: { throughSequence: 4 }, updates: [{ sequence: 9 }] }),
    ).toBe(false);
  });
});

describe("canvas implicit layout", () => {
  const rect = (id: string, x?: number, y?: number) => ({
    type: "rectangle",
    id,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    width: 50,
    height: 20,
  });

  it("reads a frame whose children carry coordinates as absolute", () => {
    expect(resolveImplicitLayout({ type: "frame", id: "f", children: [rect("a", 10, 20)] })).toBe(
      "none",
    );
  });

  it("never overrides a layout the author chose", () => {
    for (const layout of ["horizontal", "vertical", "grid", "none"]) {
      expect(
        resolveImplicitLayout({ type: "frame", id: "f", layout, children: [rect("a", 10, 20)] }),
      ).toBeUndefined();
    }
  });

  it("leaves a frame alone when its children have no coordinates", () => {
    // Auto-layout is what the author is asking for here, so the engine's default stands.
    expect(
      resolveImplicitLayout({
        type: "frame",
        id: "f",
        children: [{ type: "rectangle", id: "a", width: 50, height: 20 }],
      }),
    ).toBeUndefined();
  });

  it("applies at every level, not just the root", () => {
    const document = {
      children: [
        {
          type: "frame",
          id: "root",
          width: 400,
          height: 400,
          children: [
            {
              type: "frame",
              id: "inner",
              x: 16,
              y: 16,
              width: 200,
              height: 200,
              children: [rect("a", 5, 5)],
            },
            {
              type: "frame",
              id: "column",
              layout: "vertical",
              x: 16,
              y: 240,
              width: 200,
              height: 120,
              children: [rect("b")],
            },
          ],
        },
      ],
    };
    const rewritten = withImplicitAbsoluteLayout(document) as {
      children: ReadonlyArray<{
        layout?: string;
        children: ReadonlyArray<{ id: string; layout?: string }>;
      }>;
    };
    // The root and the implicit card both become absolute; the declared column is left alone.
    expect(rewritten.children[0]?.layout).toBe("none");
    expect(rewritten.children[0]?.children[0]?.layout).toBe("none");
    expect(rewritten.children[0]?.children[1]?.layout).toBe("vertical");
  });

  it("leaves a frame whose own children carry no coordinates, however deep the tree", () => {
    // The rule is per frame, not inherited: an outer frame is only absolute when its own children
    // were placed by hand.
    const document = {
      children: [
        {
          type: "frame",
          id: "root",
          width: 400,
          height: 400,
          children: [
            {
              type: "frame",
              id: "inner",
              width: 200,
              height: 200,
              children: [rect("a", 5, 5)],
            },
          ],
        },
      ],
    };
    const rewritten = withImplicitAbsoluteLayout(document) as {
      children: ReadonlyArray<{ layout?: string; children: ReadonlyArray<{ layout?: string }> }>;
    };
    expect(rewritten.children[0]?.layout).toBeUndefined();
    expect(rewritten.children[0]?.children[0]?.layout).toBe("none");
  });

  it("returns the same document when nothing needs changing", () => {
    const document = {
      children: [
        {
          type: "frame",
          id: "root",
          layout: "vertical",
          children: [{ type: "rectangle", id: "a", width: 5, height: 5 }],
        },
      ],
    };
    expect(withImplicitAbsoluteLayout(document)).toBe(document);
  });

  it("does not rewrite the document it was given", () => {
    // The rasterizer runs over the document an edit is about to commit.
    const document = {
      children: [{ type: "frame", id: "root", width: 10, height: 10, children: [rect("a", 1, 1)] }],
    };
    withImplicitAbsoluteLayout(document);
    expect(document.children[0]).not.toHaveProperty("layout");
  });
});

describe("canvas frame overflow", () => {
  it("says nothing about a design that fits its frames", () => {
    expect(
      detectFrameOverflow({
        children: [
          {
            type: "frame",
            id: "page",
            width: 390,
            height: 1000,
            children: [
              { type: "rectangle", id: "a", x: 16, y: 16, width: 358, height: 100 },
              { type: "rectangle", id: "b", x: 16, y: 200, width: 358, height: 100 },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("reports content laid out in a row past its own frame", () => {
    // The shape a page takes when its frame has no layout mode: every section placed by hand, and
    // then stacked end to end by a renderer that decided they were auto-layout children.
    const issues = detectFrameOverflow({
      children: [
        {
          type: "frame",
          id: "page",
          width: 390,
          height: 5250,
          children: Array.from({ length: 40 }, (_, index) => ({
            type: "rectangle",
            id: `s-${index}`,
            x: index * 358,
            y: 0,
            width: 358,
            height: 440,
          })),
        },
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("bounds_overflow");
    expect(issues[0]?.severity).toBe("critical");
    expect(issues[0]?.nodeId).toBe("page");
    expect(issues[0]?.message).toContain("layout");
  });

  it("measures a nested frame against its own box", () => {
    expect(
      detectFrameOverflow({
        children: [
          {
            type: "frame",
            id: "page",
            width: 390,
            height: 4000,
            children: [
              {
                type: "frame",
                id: "card",
                width: 358,
                height: 200,
                children: [{ type: "rectangle", id: "a", x: 8, y: 8, width: 342, height: 184 }],
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("does not mistake a frame's own position for its content", () => {
    // A card that sits 2270px down the page is not a card that overflows itself. Its `x`/`y` place
    // it in the page; its children are measured against its own 358x220 box. Measuring the union
    // against the frame's own box would have reported every card on a long page as broken.
    expect(
      detectFrameOverflow({
        children: [
          {
            type: "frame",
            id: "page",
            width: 390,
            height: 5250,
            children: [
              {
                type: "frame",
                id: "card",
                x: 16,
                y: 2270,
                width: 358,
                height: 220,
                children: [
                  { type: "rectangle", id: "label", x: 16, y: 24, width: 326, height: 18 },
                  { type: "rectangle", id: "bar", x: 16, y: 130, width: 326, height: 8 },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("still reports a nested frame whose own children run past it", () => {
    const issues = detectFrameOverflow({
      children: [
        {
          type: "frame",
          id: "page",
          width: 390,
          height: 5250,
          children: [
            {
              type: "frame",
              id: "card",
              x: 16,
              y: 2270,
              width: 358,
              height: 220,
              children: Array.from({ length: 20 }, (_, index) => ({
                type: "rectangle",
                id: `c-${index}`,
                x: 16,
                y: index * 120,
                width: 326,
                height: 100,
              })),
            },
          ],
        },
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.nodeId).toBe("card");
  });
});

describe("canvas module viewport", () => {
  it("warns about a phone-width frame in a web design", () => {
    const issues = detectModuleViewportMismatch({
      module: "web",
      children: [{ type: "frame", id: "home", role: "route", width: 390, height: 5250 }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("viewport_mismatch");
    expect(issues[0]?.message).toContain("mobile");
  });

  it("names the deliverable once rather than every frame inside it", () => {
    // A card inside a phone-width page is not a separate artifact with its own wrong width.
    const issues = detectModuleViewportMismatch({
      module: "web",
      children: [
        {
          type: "frame",
          id: "home",
          role: "route",
          width: 390,
          height: 5250,
          children: [
            { type: "frame", id: "card-0", width: 358, height: 440 },
            { type: "frame", id: "card-1", width: 358, height: 440 },
          ],
        },
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.nodeId).toBe("home");
  });

  it("says nothing for a mobile design, which is the module that means phone", () => {
    expect(
      detectModuleViewportMismatch({
        module: "mobile",
        children: [{ type: "frame", id: "home", width: 390, height: 844 }],
      }),
    ).toEqual([]);
  });

  it("says nothing for a desktop-width frame", () => {
    expect(
      detectModuleViewportMismatch({
        module: "web",
        children: [{ type: "frame", id: "home", width: 1440, height: 4000 }],
      }),
    ).toEqual([]);
  });

  it("leaves a module with no declared width alone", () => {
    // A generic document's presets run from a phone card to an A4 sheet, so a narrow frame there
    // is not evidence of anything.
    expect(
      detectModuleViewportMismatch({
        module: "generic",
        children: [{ type: "frame", id: "card", width: 390, height: 800 }],
      }),
    ).toEqual([]);
  });
});

describe("canvas review issues", () => {
  const issues = Array.from({ length: 50 }, (_, index) => ({
    nodeId: `node-${index}`,
    kind: index % 2 === 0 ? "overflow" : "contrast",
    severity: index % 10 === 0 ? "critical" : "minor",
  }));

  it("bounds the sample but never truncates the counts", () => {
    const summary = summarizeReviewIssues(issues, [], 20);
    expect(summary.sample).toHaveLength(20);
    expect(summary.total).toBe(50);
    expect(summary.omitted).toBe(30);
    expect(summary.byKind).toEqual({ overflow: 25, contrast: 25 });
    expect(summary.bySeverity).toEqual({ critical: 5, minor: 45 });
  });

  it("ranks issues the edit touched ahead of untouched ones", () => {
    const summary = summarizeReviewIssues(issues, ["node-49"], 1);
    expect(summary.sample[0]?.nodeId).toBe("node-49");
  });

  it("ranks a critical issue above a minor one at equal touch state", () => {
    const summary = summarizeReviewIssues(
      [
        { nodeId: "a", kind: "contrast", severity: "minor" },
        { nodeId: "b", kind: "overflow", severity: "critical" },
      ],
      [],
      1,
    );
    expect(summary.sample[0]?.nodeId).toBe("b");
  });

  it("treats an issue with no kind or severity rather than dropping it", () => {
    const summary = summarizeReviewIssues([{ nodeId: "a" }], [], 20);
    expect(summary.total).toBe(1);
    expect(summary.byKind).toEqual({ other: 1 });
    expect(summary.bySeverity).toEqual({ unspecified: 1 });
  });
});

describe("canvas execution result limits", () => {
  it("accepts an edit within both limits", () => {
    expect(
      checkExecutionResultLimits({
        touchedNodeIds: ["a"],
        issueCount: 0,
        nodeLimit: 10_000,
        issueLimit: 10_000,
      }),
    ).toEqual({ _tag: "WithinLimits" });
  });

  it("refuses a sprawling edit with a way forward", () => {
    const result = checkExecutionResultLimits({
      touchedNodeIds: Array.from({ length: 10_001 }, (_, index) => `n${index}`),
      issueCount: 0,
      nodeLimit: 10_000,
      issueLimit: 10_000,
    });
    expect(result._tag).toBe("Exceeded");
    if (result._tag !== "Exceeded") return;
    expect(result.what).toBe("touchedNodeIds");
    expect(result.message).toContain("Split unrelated design intents");
  });

  it("refuses an edit that produces too many issues", () => {
    const result = checkExecutionResultLimits({
      touchedNodeIds: [],
      issueCount: 10_001,
      nodeLimit: 10_000,
      issueLimit: 10_000,
    });
    expect(result._tag).toBe("Exceeded");
    if (result._tag !== "Exceeded") return;
    expect(result.what).toBe("issues");
    expect(result.message).toContain("Narrow the design intent");
  });
});

describe("canvas export destinations", () => {
  const workspaceRoot = "/projects/demo";

  it("accepts a new path inside the workspace", () => {
    expect(
      checkExportDestination({
        workspaceRoot,
        destination: "/projects/demo/out/deck.pptx",
        exists: false,
      }),
    ).toEqual({ _tag: "Ok", path: "/projects/demo/out/deck.pptx" });
  });

  it("refuses a path outside the workspace", () => {
    const result = checkExportDestination({
      workspaceRoot,
      destination: "/etc/passwd.png",
      exists: false,
    });
    expect(result._tag).toBe("OutsideWorkspace");
  });

  it("refuses a path that only looks like it is inside the workspace", () => {
    const result = checkExportDestination({
      workspaceRoot,
      destination: "/projects/demo-other/out.png",
      exists: false,
    });
    expect(result._tag).toBe("OutsideWorkspace");
  });

  it("refuses to overwrite an existing file", () => {
    const result = checkExportDestination({
      workspaceRoot,
      destination: "/projects/demo/out.png",
      exists: true,
    });
    expect(result._tag).toBe("Unsafe");
  });

  it("accepts a trailing separator as a directory to create", () => {
    expect(
      checkExportDestination({
        workspaceRoot,
        destination: "/projects/demo/exports/",
        exists: false,
      })._tag,
    ).toBe("Ok");
  });
});

describe("canvas filename segments", () => {
  it.each([
    ["", "empty"],
    [".", "current directory"],
    ["..", "parent directory"],
    ["a/b", "separator"],
    ["a\\b", "windows separator"],
    ["a\u0000b", "control character"],
    ["con", "windows reserved name"],
    ["NUL.txt", "windows reserved name with extension"],
    ["COM1", "windows reserved device"],
    ["lpt9.log", "windows reserved device with extension"],
    ["e\u0301", "decomposed unicode"],
    ["x".repeat(256), "over the byte limit"],
  ])("rejects %s (%s)", (segment) => {
    expect(isSafeFilenameSegment(segment)).toBe(false);
  });

  it("accepts an ordinary name", () => {
    expect(isSafeFilenameSegment("deck.pptx")).toBe(true);
    expect(isSafeFilenameSegment("Page 1.png")).toBe(true);
  });
});

describe("canvas permanent delete guard", () => {
  it("passes the recoverable lifecycle tools", () => {
    expect(() =>
      assertNoPermanentDeleteTool(["canvas_trash", "canvas_restore", "canvas_documents_list"]),
    ).not.toThrow();
  });

  it("refuses a tool that can permanently delete", () => {
    expect(() => assertNoPermanentDeleteTool(["canvas_permanentlyDelete"])).toThrow(
      /can permanently delete/,
    );
    expect(() => assertNoPermanentDeleteTool(["canvas_empty_trash"])).toThrow(
      /can permanently delete/,
    );
  });
});

describe("canvas trash confirmation", () => {
  it("confirms only the exact current title", () => {
    expect(
      resolveTrashConfirmation({ currentTitle: "Launch deck", confirmTitle: "Launch deck" }),
    ).toEqual({
      _tag: "Confirmed",
      title: "Launch deck",
    });
  });

  it("refuses a stale title and returns the current one to confirm", () => {
    const result = resolveTrashConfirmation({
      currentTitle: "Launch deck",
      confirmTitle: "Old name",
    });
    expect(result._tag).toBe("TitleMismatch");
    if (result._tag !== "TitleMismatch") return;
    expect(result.currentTitle).toBe("Launch deck");
    expect(result.message).toContain('"Launch deck"');
  });

  it("reports a document that is not there as not found", () => {
    expect(
      resolveTrashConfirmation({ currentTitle: undefined, confirmTitle: "Launch deck" }),
    ).toEqual({ _tag: "NotFound" });
  });
});

describe("canvas conflict retry", () => {
  it("retries a stale edit while attempts remain", () => {
    expect(decideConflictRetry({ attempt: 0, maxAttempts: 3 })).toEqual({
      _tag: "Retry",
      attempt: 1,
    });
    expect(decideConflictRetry({ attempt: 1, maxAttempts: 3 })).toEqual({
      _tag: "Retry",
      attempt: 2,
    });
  });

  it("stops instead of spinning when the user keeps editing", () => {
    const result = decideConflictRetry({ attempt: 2, maxAttempts: 3 });
    expect(result._tag).toBe("GiveUp");
    if (result._tag !== "GiveUp") return;
    expect(result.attempts).toBe(3);
    expect(result.message).toContain("not applied");
  });
});
