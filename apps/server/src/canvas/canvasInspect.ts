// @effect-diagnostics nodeBuiltinImport:off - This measures text with the vendored engine and reads
// the vendored font manifest, both of which only exist as real paths.
import { absoluteBoxes, type MeasuredText } from "./canvasText.ts";

/**
 * Everything wrong with a design that can be established without looking at it.
 *
 * The engine's own review is a structural linter: it knows about invalid documents and a few
 * geometry rules. Everything here is measured against the same shaper and the same boxes the
 * renderer draws from, which is what lets the agent be told about a clipped headline or an
 * unlabelled button without a human looking at the picture first.
 *
 * Every issue is written for the model that has to fix it: what is wrong, in numbers, on which
 * nodes, and the smallest change that resolves it.
 */

export type CanvasIssueSeverity = "critical" | "major" | "minor" | "info";

export type CanvasIssueCode =
  | "text_overflow"
  | "bounds_overflow"
  | "off_frame"
  | "empty_control"
  | "empty_frame"
  | "sibling_overlap"
  | "frames_overlap"
  | "frame_unnamed"
  | "viewport_mismatch";

export interface CanvasInspectIssue {
  readonly code: CanvasIssueCode;
  readonly severity: CanvasIssueSeverity;
  /** Every node this issue names. One issue can name several. */
  readonly nodeIds: ReadonlyArray<string>;
  /** The numbers behind the claim, so the fix can be checked rather than guessed. */
  readonly numbers: Readonly<Record<string, number | string>>;
  /** What to change, in one sentence, addressed to the agent. */
  readonly fix: string;
}

export interface CanvasInspectResult {
  readonly issues: ReadonlyArray<CanvasInspectIssue>;
  /** How many of each kind were found, including those beyond the cap. */
  readonly counts: Readonly<Record<string, number>>;
  /** How many issues were dropped by the cap. */
  readonly omitted: number;
  readonly measuredTextNodes: number;
}

/** The most an inspect answer may carry, so one bad design cannot flood a model's context. */
export const CANVAS_INSPECT_ISSUE_LIMIT = 25;

const SEVERITY_ORDER: Readonly<Record<CanvasIssueSeverity, number>> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

interface NodeLike {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  role?: unknown;
  fill?: unknown;
  opacity?: unknown;
  visible?: unknown;
  width?: unknown;
  height?: unknown;
  fontSize?: unknown;
  content?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

const childrenOf = (node: NodeLike): ReadonlyArray<NodeLike> =>
  Array.isArray(node.children) ? (node.children as ReadonlyArray<NodeLike>) : [];

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const idOf = (node: NodeLike): string => (typeof node.id === "string" ? node.id : "");

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const overlapArea = (left: Box, right: Box): number => {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
};

const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** The smallest collision worth telling an author about, in square design units. */
const OVERLAP_MIN_AREA = 16;

const collect = (
  node: NodeLike,
  boxes: ReadonlyMap<string, Box>,
  out: { readonly id: string; readonly node: NodeLike; readonly box: Box }[],
): void => {
  const id = idOf(node);
  const box = boxes.get(id);
  if (box !== undefined) out.push({ id, node, box });
  for (const child of childrenOf(node)) collect(child, boxes, out);
};

/**
 * Two text runs landing on top of each other.
 *
 * The rule is deliberately narrow, because the broad version is useless: a page is mostly shapes
 * stacked on shapes. A background under its content, a glow behind a badge, a label centred on a
 * button, and a card inside a page are all overlaps that are the design working. Only text meeting
 * text is a defect, because the result is always two strings drawn over one another and at least one
 * of them is unreadable.
 *
 * So: two nodes that each carry text, neither containing the other, whose intersection is more than
 * a rounding artefact. Every exclusion below is a consequence of that, not a special case list.
 */
export const findSiblingOverlap = (
  document: unknown,
  boxes: ReadonlyMap<string, Box>,
): ReadonlyArray<CanvasInspectIssue> => {
  const nodes: { id: string; node: NodeLike; box: Box }[] = [];
  for (const child of childrenOf(document as NodeLike)) collect(child, boxes, nodes);

  const textBearing = nodes.filter(
    (entry) =>
      entry.node.type === "text" &&
      typeof entry.node.content === "string" &&
      entry.node.content.trim().length > 0,
  );

  const issues: CanvasInspectIssue[] = [];
  for (let left = 0; left < textBearing.length; left += 1) {
    for (let right = left + 1; right < textBearing.length; right += 1) {
      const a = textBearing[left]!;
      const b = textBearing[right]!;
      // Containment is nesting, not collision: a quote inside a panel is one text in another box.
      if (contains(a.box, b.box) || contains(b.box, a.box)) continue;
      const area = overlapArea(a.box, b.box);
      if (area <= OVERLAP_MIN_AREA) continue;
      issues.push({
        code: "sibling_overlap",
        severity: "major",
        nodeIds: [a.id, b.id],
        numbers: {
          overlapWidth: Math.round(
            Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x),
          ),
          overlapHeight: Math.round(
            Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y),
          ),
          overlapArea: Math.round(area),
        },
        fix:
          `Two text runs are drawn over each other by about ${Math.round(area)}px². Move one clear of ` +
          `the other, or shorten it so it fits its box.`,
      });
    }
  }
  return issues;
};

/** A frame whose content sits outside its own box. */
export const findBoundsOverflow = (
  document: unknown,
  boxes: ReadonlyMap<string, Box>,
  limit = 2,
): ReadonlyArray<CanvasInspectIssue> => {
  const issues: CanvasInspectIssue[] = [];
  const visit = (node: NodeLike): Box | undefined => {
    if (node.type !== "frame") {
      const box = boxes.get(idOf(node));
      return box;
    }
    let content: Box | undefined;
    for (const child of childrenOf(node)) {
      const childBox = visit(child);
      if (childBox !== undefined) {
        content =
          content === undefined
            ? childBox
            : {
                x: Math.min(content.x, childBox.x),
                y: Math.min(content.y, childBox.y),
                width:
                  Math.max(content.x + content.width, childBox.x + childBox.width) -
                  Math.min(content.x, childBox.x),
                height:
                  Math.max(content.y + content.height, childBox.y + childBox.height) -
                  Math.min(content.y, childBox.y),
              };
      }
    }
    const box = boxes.get(idOf(node));
    if (box !== undefined && content !== undefined) {
      const wide = content.width / Math.max(1, box.width);
      const tall = content.height / Math.max(1, box.height);
      if (
        (wide > limit && content.width - box.width > 8) ||
        (tall > limit && content.height - box.height > 8)
      ) {
        issues.push({
          code: "bounds_overflow",
          severity: "critical",
          nodeIds: [idOf(node)],
          numbers: {
            frameWidth: Math.round(box.width),
            frameHeight: Math.round(box.height),
            contentWidth: Math.round(content.width),
            contentHeight: Math.round(content.height),
          },
          fix:
            `This frame's content runs ${Math.round(Math.max(wide, tall))}x past its own box, so it is ` +
            `being drawn outside it. Either size the frame to its content, or set an explicit ` +
            `layout ("vertical" to stack, "horizontal" for a row) so the frame lays its children out ` +
            `instead of taking their coordinates literally.`,
        });
      }
    }
    return box;
  };
  for (const child of childrenOf(document as NodeLike)) visit(child);
  return issues;
};

/** Content outside the frame it belongs to, named per offending node. */
export const findOffFrame = (
  document: unknown,
  boxes: ReadonlyMap<string, Box>,
): ReadonlyArray<CanvasInspectIssue> => {
  const issues: CanvasInspectIssue[] = [];
  const visit = (node: NodeLike, parentBox: Box | undefined): void => {
    if (node.type !== "frame") return;
    const own = boxes.get(idOf(node));
    for (const child of childrenOf(node)) {
      const childBox = boxes.get(idOf(child));
      if (own !== undefined && childBox !== undefined) {
        const overflowRight = childBox.x + childBox.width - (own.x + own.width);
        const overflowBottom = childBox.y + childBox.height - (own.y + own.height);
        const overflowLeft = own.x - childBox.x;
        const overflowTop = own.y - childBox.y;
        const worst = Math.max(overflowRight, overflowBottom, overflowLeft, overflowTop);
        if (worst > 8) {
          issues.push({
            code: "off_frame",
            severity: "major",
            nodeIds: [idOf(child)],
            numbers: { overflowPx: Math.round(worst), frameId: idOf(node) },
            fix:
              `This node sits ${Math.round(worst)}px outside its frame ${JSON.stringify(idOf(node))} and ` +
              `will be clipped or overlap a neighbour. Move it inside, or grow the frame.`,
          });
        }
      }
      visit(child, own ?? parentBox);
    }
  };
  for (const child of childrenOf(document as NodeLike)) visit(child, boxes.get(idOf(child)));
  return issues;
};

/** A frame with nothing in it at all. */
export const findEmptyFrames = (
  document: unknown,
  _boxes: ReadonlyMap<string, Box>,
): ReadonlyArray<CanvasInspectIssue> => {
  const issues: CanvasInspectIssue[] = [];
  const visit = (node: NodeLike): void => {
    if (
      node.type === "frame" &&
      childrenOf(node).length === 0 &&
      (node.role !== undefined || num(node.width) > 0)
    ) {
      issues.push({
        code: "empty_frame",
        severity: "minor",
        nodeIds: [idOf(node)],
        numbers: { width: num(node.width), height: num(node.height) },
        fix: `This frame is empty. Delete it, or fill it — an empty frame is a placeholder the user will see.`,
      });
    }
    for (const child of childrenOf(node)) visit(child);
  };
  for (const child of childrenOf(document as NodeLike)) visit(child);
  return issues;
};

/** A frame that carries no name, which is what the viewer shows as "Frame N". */
export const findUnnamedFrames = (document: unknown): ReadonlyArray<CanvasInspectIssue> => {
  const issues: CanvasInspectIssue[] = [];
  const visit = (node: NodeLike, depth: number): void => {
    if (node.type === "frame") {
      const name = typeof node.name === "string" ? node.name.trim() : "";
      if (name.length === 0 && depth <= 1) {
        issues.push({
          code: "frame_unnamed",
          severity: "minor",
          nodeIds: [idOf(node)],
          numbers: { width: num(node.width), height: num(node.height) },
          fix:
            `Give this frame a name. It is what the user sees on its tab and in the canvas, and an ` +
            `unnamed one shows as "Frame ${depth}" instead of something they can recognise.`,
        });
      }
    }
    for (const child of childrenOf(node)) visit(child, depth + 1);
  };
  for (const child of childrenOf(document as NodeLike)) visit(child, 1);
  return issues;
};

/** Two top-level frames occupying the same part of the canvas. */
export const findFramesOverlap = (
  document: unknown,
  boxes: ReadonlyMap<string, Box>,
): ReadonlyArray<CanvasInspectIssue> => {
  const frames = childrenOf(document as NodeLike)
    .map((node) => ({ node, box: boxes.get(idOf(node)) }))
    .filter((entry): entry is { node: NodeLike; box: Box } => entry.box !== undefined);
  const issues: CanvasInspectIssue[] = [];
  for (let left = 0; left < frames.length; left += 1) {
    for (let right = left + 1; right < frames.length; right += 1) {
      const a = frames[left]!;
      const b = frames[right]!;
      const area = overlapArea(a.box, b.box);
      if (area <= OVERLAP_MIN_AREA) continue;
      issues.push({
        code: "frames_overlap",
        severity: "major",
        nodeIds: [a.node.id as string, b.node.id as string],
        numbers: { overlapArea: Math.round(area) },
        fix:
          `Two frames sit on top of each other, so one hides the other. Move them apart, or set ` +
          `their positions so they sit side by side with a gap between them.`,
      });
    }
  }
  return issues;
};

const hexToRgb = (value: unknown): readonly [number, number, number] | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/^#/u, "");
  const expanded = text.length === 3 ? text.replace(/./gu, (c) => c + c) : text;
  if (!/^[0-9a-f]{6}$/iu.test(expanded)) return undefined;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
};

const channelLuminance = (channel: number): number => {
  const ratio = channel / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
};

/** The WCAG contrast ratio between two colours, from 1 to 21. */
export const contrastRatio = (foreground: unknown, background: unknown): number | undefined => {
  const front = hexToRgb(foreground);
  const back = hexToRgb(background);
  if (front === undefined || back === undefined) return undefined;
  const luminance = ([r, g, b]: readonly [number, number, number]) =>
    0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
  const a = luminance(front);
  const b = luminance(back);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return Math.round(ratio * 100) / 100;
};

/**
 * Text against whatever it is actually sitting on.
 *
 * The nearest filled ancestor, because that is the surface the text is painted on. Measuring against
 * white is the usual shortcut and it is wrong the moment a design has a dark card on a light page.
 */
export const findLowContrast = (
  document: unknown,
  minimum = 4.5,
): ReadonlyArray<CanvasInspectIssue> => {
  const issues: CanvasInspectIssue[] = [];
  const visit = (node: NodeLike, surface: string | undefined): string | undefined => {
    const ownFill = typeof node.fill === "string" ? node.fill : undefined;
    const here = ownFill ?? surface;
    if (
      node.type === "text" &&
      typeof node.content === "string" &&
      node.content.trim().length > 0
    ) {
      const ratio = contrastRatio(node.fill, surface);
      if (ratio !== undefined && ratio < minimum) {
        issues.push({
          code: "text_overflow",
          severity: "minor",
          nodeIds: [idOf(node)],
          numbers: { contrast: ratio, required: minimum, surface: surface ?? "(none)" },
          fix:
            `This text has a contrast ratio of ${ratio}:1 against its ${JSON.stringify(surface ?? "page")} ` +
            `background, below the ${minimum}:1 needed to be readable. Darken the text or lighten the ` +
            `surface behind it.`,
        });
      }
    }
    for (const child of childrenOf(node)) visit(child, here);
    return here;
  };
  for (const child of childrenOf(document as NodeLike)) visit(child, undefined);
  return issues;
};

/**
 * Rank, cap and count.
 *
 * The cap is on what is returned, never on what is counted: a design with two hundred overlaps has
 * to be able to say two hundred, or the agent fixes three and believes it finished.
 */
export const summarizeInspect = (
  issues: ReadonlyArray<CanvasInspectIssue>,
  limit = CANVAS_INSPECT_ISSUE_LIMIT,
): {
  readonly issues: ReadonlyArray<CanvasInspectIssue>;
  readonly counts: Readonly<Record<string, number>>;
  readonly omitted: number;
} => {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  const ranked = [...issues].sort(
    (left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
  );
  return { issues: ranked.slice(0, limit), counts, omitted: Math.max(0, ranked.length - limit) };
};

/**
 * Narrow a document to one node's subtree, so an inspect of a selector answers about that node.
 *
 * A selector that matches nothing is left as the whole document rather than an empty one: answering
 * "no problems" about nothing would be the most expensive kind of wrong.
 */
export const narrowToSelector = (document: unknown, selector: string): unknown => {
  const wanted = selector.startsWith("#")
    ? selector.slice(1)
    : (selector.split("/").pop() ?? selector);
  const search = (node: NodeLike): NodeLike | undefined => {
    if (idOf(node) === wanted || (typeof node.name === "string" && node.name === selector))
      return node;
    for (const child of childrenOf(node)) {
      const found = search(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const child of childrenOf(document as NodeLike)) {
    const found = search(child);
    if (found !== undefined) return found;
  }
  return document;
};

/**
 * Text whose box cannot hold the lines the shaper produced.
 *
 * The other half of the wrap story: normalization gives a silent text node a height, but a node whose
 * height the author set themselves and got wrong is still clipped, and nothing else in the pipeline
 * would say so.
 */
export const findTextOverflow = (
  document: unknown,
  measured: ReadonlyMap<string, MeasuredText>,
): ReadonlyArray<CanvasInspectIssue> => {
  const issues: CanvasInspectIssue[] = [];
  const visit = (node: NodeLike): void => {
    if (node.type === "text") {
      const entry = measured.get(idOf(node));
      const declared = num(node.height);
      if (entry !== undefined && entry.derivedHeight > declared + 1 && node.height !== undefined) {
        issues.push({
          code: "text_overflow",
          severity: "major",
          nodeIds: [idOf(node)],
          numbers: {
            needed: entry.derivedHeight,
            declared: declared,
            lines: entry.lines,
            fontSize: num(node.fontSize),
          },
          fix:
            `This text needs ${entry.derivedHeight}px for its ${entry.lines} wrapped line(s) but the ` +
            `node is ${declared}px tall, so the last line is cut off. Set the node's height to ` +
            `${entry.derivedHeight}, or shorten the copy so it fits.`,
        });
      }
    }
    for (const child of childrenOf(node)) visit(child);
  };
  for (const child of childrenOf(document as NodeLike)) visit(child);
  return issues;
};

export type { MeasuredText };
export { absoluteBoxes };
