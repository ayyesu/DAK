// @effect-diagnostics nodeBuiltinImport:off - This writes screenshot scratch files to disk.
import { base64ToBytes, bytesToBase64 } from "./bytes.ts";

/**
 * Choosing what to hand back for one design.
 *
 * A screenshot that is a single scaled image is useless for a long page: the resolution budget gets
 * spent on whichever axis is longer, so a 390x5250 page arrives a couple of hundred pixels wide and
 * is unreadable when the panel stretches it. So a tall target becomes an overview — cheap, whole,
 * immediately honest about the shape of the thing — plus sharp section crops.
 *
 * Sections are cut where the design already has a section boundary, because a crop that lands
 * between a hero and its call to action is a crop that hides the relationship. When there are no
 * boundaries to cut at, the fallback is a plain slice with a little overlap, so a boundary never
 * falls exactly between two crops and both sides of it stay visible in at least one.
 */

/**
 * The long edge we aim for.
 *
 * Around 1568 is where a raster stays sharp on a 2x display without being larger than it needs to
 * be, and it is what a vision model is reliably able to read.
 */
export const CANVAS_SCREENSHOT_MAX_EDGE = 1568;

/**
 * The width a screenshot aims to be legible at.
 *
 * Width, not the long edge, and deliberately so. Fitting the long edge is what produced the original
 * bug: a 390x5250 page capped at 1568 arrives 117px wide, and every glyph in it is a smudge. Text is
 * read across, so the budget is spent across.
 */
export const CANVAS_SCREENSHOT_TARGET_WIDTH = 1568;

/**
 * How far a small frame may be enlarged.
 *
 * Upscaling adds no detail, but it does make the image the same size as the one the user is looking
 * at, so what the agent reviews and what the user sees agree. Past this the pixels are just
 * interpolation and the file is wasted bandwidth.
 */
export const CANVAS_SCREENSHOT_MAX_UPSCALE = 4;

/** The cheap whole-target image a view shows before the sharp crops land. */
export const CANVAS_SCREENSHOT_OVERVIEW_MAX_EDGE = 384;

/** How much consecutive slices repeat, so no boundary is only ever cut in one place. */
export const CANVAS_SCREENSHOT_SLICE_OVERLAP = 64;

export interface CanvasBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasScreenshotImage {
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/png";
  readonly data: string;
}

/** One part of a screenshot: an overview, a whole target, or one section of a tall one. */
export interface CanvasScreenshotPart {
  readonly role: "overview" | "section";
  readonly y: number;
  readonly height: number;
  readonly image: CanvasScreenshotImage;
}

/**
 * The scale a target is rendered at, and whether it then needs slicing.
 *
 * Sized by width first, and only then split vertically. Fitting the long edge instead — the obvious
 * implementation — is what made a long page arrive a few pixels wide, and no amount of slicing
 * afterwards recovers legibility that was never rendered.
 */
export const planScreenshot = (
  target: CanvasBox,
): {
  readonly scale: number;
  readonly tall: boolean;
} => {
  const scale = Math.min(
    CANVAS_SCREENSHOT_MAX_UPSCALE,
    Math.max(1, CANVAS_SCREENSHOT_TARGET_WIDTH / Math.max(1, target.width)),
  );
  return { scale, tall: target.height * scale > CANVAS_SCREENSHOT_MAX_EDGE };
};

/**
 * Where a tall target is cut.
 *
 * Boundaries win when the design has them: a design made of sections reads best cut between them,
 * and the agent reviewing the crops sees whole sections rather than a row of mid-sentence slices.
 * When there are none, the fallback is a fixed slice with overlap.
 */
export const planSections = (
  target: CanvasBox,
  scale: number,
  boundaries: ReadonlyArray<number>,
): ReadonlyArray<CanvasBox> => {
  const usable = CANVAS_SCREENSHOT_MAX_EDGE / Math.max(0.01, scale);
  const inner = boundaries
    .filter((y) => y > 0 && y < target.height)
    .sort((left, right) => left - right);

  if (inner.length > 0) {
    const cuts = [0, ...inner, target.height];
    // A boundary worth cutting at is worth a crop big enough to read. Every child of a frame has an
    // offset, so feeding all of them in produced dozens of 28px slivers; a cut that would leave a
    // sliver is simply not a cut, and the slice fallback takes over from there.
    const sections: CanvasBox[] = [];
    for (let index = 0; index < cuts.length - 1; index += 1) {
      const top = cuts[index]!;
      const bottom = cuts[index + 1]!;
      const height = bottom - top;
      if (height < usable * 0.25) continue;
      sections.push({ x: target.x, y: target.y + top, width: target.width, height });
    }
    if (sections.length > 1) return sections;
  }

  const sections: CanvasBox[] = [];
  const step = Math.max(1, usable - CANVAS_SCREENSHOT_SLICE_OVERLAP);
  for (let offset = 0; offset < target.height; offset += step) {
    const height = Math.min(usable, target.height - offset);
    if (height <= 1) break;
    sections.push({ x: target.x, y: target.y + offset, width: target.width, height });
    if (offset + height >= target.height) break;
  }
  return sections;
};

export interface CanvasRenderer {
  readonly renderRegion: (input: {
    readonly payload: never;
    readonly nodeId: string;
    readonly bounds: CanvasBox;
    readonly scale?: number;
    readonly maxEdge?: number;
  }) => Promise<CanvasScreenshotImage>;
}

/**
 * Every image one screenshot consists of.
 *
 * The overview first so a caller can paint something immediately, then the sharp parts in order.
 */
export const renderScreenshot = async (
  renderer: CanvasRenderer,
  payload: never,
  target: {
    readonly nodeId: string;
    readonly box: CanvasBox;
    readonly boundaries: ReadonlyArray<number>;
  },
): Promise<ReadonlyArray<CanvasScreenshotPart>> => {
  const plan = planScreenshot(target.box);
  const parts: CanvasScreenshotPart[] = [];

  if (plan.tall) {
    const overview = await renderer.renderRegion({
      payload,
      nodeId: target.nodeId,
      bounds: target.box,
      scale: Math.min(
        CANVAS_SCREENSHOT_MAX_UPSCALE,
        Math.max(1, CANVAS_SCREENSHOT_OVERVIEW_MAX_EDGE / Math.max(1, target.box.width)),
      ),
    });
    parts.push({ role: "overview", y: 0, height: target.box.height, image: overview });
  }

  if (!plan.tall) {
    const image = await renderer.renderRegion({
      payload,
      nodeId: target.nodeId,
      bounds: target.box,
      scale: plan.scale,
    });
    parts.push({ role: "section", y: 0, height: target.box.height, image });
    return parts;
  }

  for (const section of planSections(target.box, plan.scale, target.boundaries)) {
    const image = await renderer.renderRegion({
      payload,
      nodeId: target.nodeId,
      bounds: section,
      scale: plan.scale,
    });
    parts.push({ role: "section", y: section.y - target.box.y, height: section.height, image });
  }
  return parts;
};

/** The PNG bytes of every part, decoded once for an MCP image content block. */
export const partBytes = (part: CanvasScreenshotPart): Uint8Array => base64ToBytes(part.image.data);

export const toBase64 = (bytes: Uint8Array): string => bytesToBase64(bytes);
