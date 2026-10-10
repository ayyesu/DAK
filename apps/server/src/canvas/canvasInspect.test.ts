// @effect-diagnostics nodeBuiltinImport:off - This measures text with the vendored engine.
import { describe, expect, it } from "vite-plus/test";

import {
  contrastRatio,
  findEmptyFrames,
  findFramesOverlap,
  findLowContrast,
  findSiblingOverlap,
  findUnnamedFrames,
  summarizeInspect,
  type CanvasInspectIssue,
} from "./canvasInspect.ts";

/**
 * The overlap rule, tested on its own because it is the one rule here that could be made so broad
 * that every design reports every shape on top of every other shape.
 */

const box = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

const text = (id: string, x: number, y: number, width: number, height: number) => ({
  type: "text",
  id,
  content: "some copy",
  x,
  y,
  width,
  height,
  children: [],
});

const shape = (id: string, x: number, y: number, width: number, height: number) => ({
  type: "rectangle",
  id,
  fill: "#ffffff",
  x,
  y,
  width,
  height,
  children: [],
});

const boxesOf = (nodes: ReadonlyArray<unknown>) =>
  new Map(
    (
      nodes as ReadonlyArray<{ id: string; x: number; y: number; width: number; height: number }>
    ).map((node) => [node.id, box(node.x, node.y, node.width, node.height)]),
  );

describe("sibling overlap", () => {
  it("flags two text runs drawn over each other", () => {
    const a = text("a", 10, 10, 200, 40);
    const b = text("b", 60, 20, 200, 40);
    const issues = findSiblingOverlap({ children: [a, b] }, boxesOf([a, b]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("sibling_overlap");
    expect(issues[0]?.nodeIds).toEqual(["a", "b"]);
    expect(issues[0]?.severity).toBe("major");
  });

  it("leaves two text runs that merely sit close together alone", () => {
    const a = text("a", 10, 10, 200, 40);
    const b = text("b", 10, 60, 200, 40);
    expect(findSiblingOverlap({ children: [a, b] }, boxesOf([a, b]))).toEqual([]);
  });

  it("does not flag a label sitting on the button it labels", () => {
    // The exclusion, stated as a test: a filled shape under its own text is the design working, and
    // a rule that flagged it would report every button in every design.
    const button = shape("btn", 10, 10, 200, 48);
    const label = text("btn-label", 30, 22, 160, 24);
    const boxes = boxesOf([button, label]);
    expect(findSiblingOverlap({ children: [button, label] }, boxes)).toEqual([]);
  });

  it("does not flag a background under the content it backs", () => {
    const background = shape("bg", 0, 0, 390, 800);
    const heading = text("h", 20, 20, 350, 50);
    const boxes = boxesOf([background, heading]);
    expect(findSiblingOverlap({ children: [background, heading] }, boxes)).toEqual([]);
  });

  it("does not flag a card inside the page that contains it", () => {
    const page = { type: "frame", id: "page", x: 0, y: 0, width: 390, height: 800, children: [] };
    const card = { type: "frame", id: "card", x: 16, y: 16, width: 358, height: 200, children: [] };
    const boxes = boxesOf([page, card]);
    expect(findSiblingOverlap({ children: [page, card] }, boxes)).toEqual([]);
  });

  it("ignores an empty text node", () => {
    const a = text("a", 10, 10, 200, 40);
    const empty = { ...text("b", 60, 20, 200, 40), content: "   " };
    expect(findSiblingOverlap({ children: [a, empty] }, boxesOf([a, empty]))).toEqual([]);
  });

  it("gives the numbers needed to check the fix", () => {
    const a = text("a", 10, 10, 200, 40);
    const b = text("b", 60, 20, 200, 40);
    const issue = findSiblingOverlap({ children: [a, b] }, boxesOf([a, b]))[0]!;
    expect(issue.numbers.overlapWidth).toBe(150);
    expect(issue.numbers.overlapHeight).toBe(30);
    expect(issue.fix).toMatch(/Move one clear/);
  });
});

describe("contrast", () => {
  it("computes the WCAG ratio", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 2);
  });

  it("accepts a three-digit hex", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 1);
  });

  it("says nothing about a colour it cannot read", () => {
    expect(contrastRatio("rebeccapurple", "#ffffff")).toBeUndefined();
    expect(contrastRatio("#ffffff", undefined)).toBeUndefined();
  });

  it("measures against the nearest filled ancestor, not against white", () => {
    // The usual shortcut is to measure every text node against the page, which is wrong the moment a
    // design has a dark card on a light page: dark text on a dark card passes against white and fails
    // on the card it is actually painted on.
    const card = {
      type: "frame",
      id: "card",
      fill: "#0f172a",
      x: 0,
      y: 0,
      width: 358,
      height: 200,
      children: [{ ...text("t", 16, 16, 300, 24), fill: "#ffffff" }],
    };
    expect(findLowContrast({ children: [card] }, 4.5)).toEqual([]);

    const bad = {
      type: "frame",
      id: "card",
      fill: "#0f172a",
      x: 0,
      y: 0,
      width: 358,
      height: 200,
      children: [{ ...text("t", 16, 16, 300, 24), fill: "#64748b" }],
    };
    const issues = findLowContrast({ children: [bad] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.numbers.required).toBe(4.5);
    // 3.75:1 — reads as "almost readable" and is not, which is exactly the band that needs flagging.
    expect(issues[0]?.numbers.contrast).toBeLessThan(4.5);
    expect(issues[0]?.numbers.surface).toBe("#0f172a");
  });
});

describe("frame checks", () => {
  it("reports an empty frame", () => {
    const frame = {
      type: "frame",
      id: "empty",
      role: "route",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [],
    };
    expect(findEmptyFrames({ children: [frame] }, new Map())).toHaveLength(1);
  });

  it("reports two frames on top of each other", () => {
    const a = {
      type: "frame",
      id: "a",
      role: "route",
      x: 0,
      y: 0,
      width: 390,
      height: 800,
      children: [],
    };
    const b = {
      type: "frame",
      id: "b",
      role: "route",
      x: 0,
      y: 0,
      width: 390,
      height: 800,
      children: [],
    };
    const issues = findFramesOverlap({ children: [a, b] }, boxesOf([a, b]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.nodeIds).toEqual(["a", "b"]);
  });

  it("leaves frames side by side alone", () => {
    const a = {
      type: "frame",
      id: "a",
      role: "route",
      x: 0,
      y: 0,
      width: 390,
      height: 800,
      children: [],
    };
    const b = {
      type: "frame",
      id: "b",
      role: "route",
      x: 420,
      y: 0,
      width: 390,
      height: 800,
      children: [],
    };
    expect(findFramesOverlap({ children: [a, b] }, boxesOf([a, b]))).toEqual([]);
  });

  it("reports a top-level frame with no name", () => {
    const frame = { type: "frame", id: "x", x: 0, y: 0, width: 390, height: 800, children: [] };
    const issues = findUnnamedFrames({ children: [frame] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.fix).toContain("name");
  });

  it("accepts a named frame", () => {
    const frame = {
      type: "frame",
      id: "x",
      name: "Home",
      x: 0,
      y: 0,
      width: 390,
      height: 800,
      children: [],
    };
    expect(findUnnamedFrames({ children: [frame] })).toEqual([]);
  });
});

describe("the inspect cap", () => {
  const issue = (index: number, severity: CanvasInspectIssue["severity"]): CanvasInspectIssue => ({
    code: "empty_frame",
    severity,
    nodeIds: [`n-${index}`],
    numbers: {},
    fix: "fix it",
  });

  it("ranks by severity before capping", () => {
    const issues = [
      ...Array.from({ length: 30 }, (_, index) => issue(index, "minor")),
      issue(99, "critical"),
    ];
    const summary = summarizeInspect(issues, 25);
    expect(summary.issues).toHaveLength(25);
    expect(summary.issues[0]?.severity).toBe("critical");
    expect(summary.omitted).toBe(6);
  });

  it("counts every issue even when the list is capped", () => {
    // A design with two hundred problems has to be able to say two hundred, or the agent fixes three
    // and believes it finished.
    const issues = Array.from({ length: 200 }, (_, index) => issue(index, "minor"));
    const summary = summarizeInspect(issues, 25);
    expect(summary.counts.empty_frame).toBe(200);
    expect(summary.omitted).toBe(175);
  });
});
