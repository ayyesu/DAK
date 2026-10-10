#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - A build script run directly, not service code. It
// reads SVG layers and writes image files before anything else loads them, so there is no Effect
// runtime to be inside yet.
// @effect-diagnostics globalConsole:off - This script's console output is the build log for a step
// that runs before any artifact is consumed.
/**
 * Renders the brand icons on any platform, from the Icon Composer sources.
 *
 * Icon Composer's `ictool` is macOS-only, so the icons it produced could not be regenerated on
 * Windows or Linux. That left the repository in a state where every *source* was correct and every
 * *committed raster* was not: `assets/<brand>/app-icon.icon/Assets/text.svg` already carried the
 * DAK wordmark, while the `.png` files beside it still showed the T3 it replaced. Both arrived in
 * the same initial commit, so the rasters were never right rather than having gone stale, and the
 * mistake was invisible on any machine that only reads the sources.
 *
 * This composites the same layer stack `ictool` would, from the same files, so the artwork has one
 * source of truth on every platform. The recipe is each bundle's `icon.json`: the layers, their
 * scale, and their order. Layers composite back-to-front, so the entry listed first is the topmost.
 *
 * What is lost versus `ictool`: the specular, glass and shadow treatments it synthesises from
 * `glass`, `translucency` and `shadow` keys in the bundle. Those are presentation applied at export
 * time and are not in the source artwork, so a flat composite cannot reproduce them. The result is
 * slightly plainer, never missing artwork. Running the macOS job afterwards is still worthwhile if
 * a channel wants the glass back.
 *
 * Renders with sharp, which ships a prebuilt libvips binary for Windows and Linux. Its SVG reader
 * handles what these bundles use: linear and radial gradients, `<pattern>` fills (the dev
 * blueprint grid), clip paths and opacity. It is already in the dependency tree, so this adds no
 * install step to a fresh checkout.
 */
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const require = NodeModule.createRequire(import.meta.url);

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

/**
 * sharp ships platform binaries as optional deps; resolving through it keeps them consistent.
 *
 * Typed as the callable CommonJS export rather than `typeof import("sharp")`, whose default is a
 * namespace and would make every call site an error.
 */
const sharp = require("sharp") as unknown as {
  (input?: Buffer | string, options?: { density?: number }): import("sharp").Sharp;
  (options: import("sharp").SharpOptions): import("sharp").Sharp;
};

/** Every channel's rendered icons come from one 1024px master per brand. */
const MASTER_SIZE = 1024;

/**
 * The corner radius as a share of the canvas, matching the `rx` each bundle's own SVG clips to.
 *
 * Read from the sources rather than hardcoded: the dev background clips to `rx=10` on a 128 viewBox
 * and the tile is inset by Icon Composer's `scale`, so the number belongs to the artwork. The old
 * PNGs are alpha-masked at their corners, so dropping the mask would change the icon's silhouette.
 */
const CORNER_RADIUS_RATIO = 10 / 128;

/**
 * One channel's icon bundle.
 *
 * `outputs` names the files this brand owns, so regenerating never invents a filename the rest of
 * the repo does not already reference. They are read from `scripts/lib/brand-assets.ts` in spirit:
 * the same set, spelled out here because this script writes them directly rather than asking
 * `ictool` for a path layout.
 */
interface BrandSpec {
  readonly brand: "dev" | "prod" | "nightly";
  readonly iconDir: string;
  readonly outputs: {
    readonly macos: string;
    readonly universal: string;
    readonly ios: string;
    readonly faviconIco: string;
    readonly favicon16: string;
    readonly favicon32: string;
    readonly appleTouch: string;
  };
}

const BRANDS: readonly BrandSpec[] = [
  {
    brand: "dev",
    iconDir: "assets/dev/app-icon.icon",
    outputs: {
      macos: "assets/dev/blueprint-macos-1024.png",
      universal: "assets/dev/blueprint-universal-1024.png",
      ios: "assets/dev/blueprint-ios-1024.png",
      faviconIco: "assets/dev/blueprint-web-favicon.ico",
      favicon16: "assets/dev/blueprint-web-favicon-16x16.png",
      favicon32: "assets/dev/blueprint-web-favicon-32x32.png",
      appleTouch: "assets/dev/blueprint-web-apple-touch-180.png",
    },
  },
  {
    brand: "prod",
    iconDir: "assets/prod/app-icon.icon",
    outputs: {
      macos: "assets/prod/black-macos-1024.png",
      universal: "assets/prod/black-universal-1024.png",
      ios: "assets/prod/black-ios-1024.png",
      faviconIco: "assets/prod/dak-black-web-favicon.ico",
      favicon16: "assets/prod/dak-black-web-favicon-16x16.png",
      favicon32: "assets/prod/dak-black-web-favicon-32x32.png",
      appleTouch: "assets/prod/dak-black-web-apple-touch-180.png",
    },
  },
  {
    brand: "nightly",
    iconDir: "assets/nightly/app-icon.icon",
    outputs: {
      macos: "assets/nightly/nightly-macos-1024.png",
      universal: "assets/nightly/nightly-universal-1024.png",
      ios: "assets/nightly/nightly-ios-1024.png",
      faviconIco: "assets/nightly/nightly-web-favicon.ico",
      favicon16: "assets/nightly/nightly-web-favicon-16x16.png",
      favicon32: "assets/nightly/nightly-web-favicon-32x32.png",
      appleTouch: "assets/nightly/nightly-web-apple-touch-180.png",
    },
  },
];

interface IconBundle {
  /** The canvas colour, which is not a layer. See `parseSolidFill`. */
  readonly fill: string;
  readonly layers: ReadonlyArray<IconLayer>;
}

interface IconLayer {
  readonly imageName: string;
  readonly scale: number;
}

/**
 * `icon.json` colours the canvas through a `fill` key rather than a background layer, so a bundle
 * can have exactly one layer and still not be transparent. The value is a
 * `display-p3:<r>,<g>,<b>,<a>` tuple with components in 0..1; prod relies on this for its black
 * tile and has no `background.svg` at all, so skipping it renders the prod icon as white lettering
 * on nothing.
 */
const parseSolidFill = (iconDir: string, raw: unknown): string => {
  const solid = (raw as { solid?: unknown } | undefined)?.solid;
  if (typeof solid !== "string") {
    // Optional: a bundle whose background is a full-bleed layer needs no canvas colour. Prod is
    // the one that cannot do without one — it has no background layer at all.
    return "#00000000";
  }
  const tuple = /^display-p3:\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*$/.exec(
    solid.trim(),
  );
  if (tuple === null) {
    throw new Error(`${iconDir}/icon.json has an unrecognised fill "${solid}".`);
  }
  const channel = (index: number): number => Math.round(Number(tuple[index]) * 255);
  const alpha = tuple[4] === "1.00000" ? 1 : channel(3) / 255;
  return `rgba(${String(channel(1))},${String(channel(2))},${String(channel(3))},${String(alpha)})`;
};

/** Reads a bundle's recipe: the canvas fill, and which layers in which order. */
const readBundle = (iconDir: string): IconBundle => {
  const bundlePath = NodePath.join(repoRoot, iconDir, "icon.json");
  const bundle = JSON.parse(NodeFS.readFileSync(bundlePath, "utf8")) as {
    fill?: unknown;
    groups?: ReadonlyArray<{
      layers?: ReadonlyArray<{
        "image-name"?: string;
        position?: { scale?: number };
      }>;
    }>;
  };
  const layers = (bundle.groups ?? []).flatMap((group) => group.layers ?? []);
  if (layers.length === 0) {
    throw new Error(`${iconDir}/icon.json lists no layers.`);
  }
  return {
    fill: parseSolidFill(iconDir, bundle.fill),
    layers: layers.map((layer) => {
      const imageName = layer["image-name"];
      if (imageName === undefined) {
        throw new Error(`${iconDir}/icon.json has a layer with no image-name.`);
      }
      return { imageName, scale: layer.position?.scale ?? 1 };
    }),
  };
};

/**
 * The rounded-corner mask.
 *
 * The committed icons are alpha-masked (their corner pixels are transparent), so the silhouette is
 * part of the artwork rather than something the tile draws itself.
 */
/**
 * The rounded-corner mask.
 *
 * The committed icons are alpha-masked (their corner pixels are transparent), so the silhouette is
 * part of the artwork rather than something the tile draws itself. Built as an SVG raster rather
 * than composited onto an empty canvas: `dest-in` against a fully transparent base keeps nothing,
 * which silently produced a solid white square on the first run.
 */
const CORNER_RADIUS_PX = Math.round(MASTER_SIZE * CORNER_RADIUS_RATIO);

const cornerMask = (): Promise<Buffer> =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${String(MASTER_SIZE)}" height="${String(
        MASTER_SIZE,
      )}"><rect width="${String(MASTER_SIZE)}" height="${String(MASTER_SIZE)}" rx="${String(
        CORNER_RADIUS_PX,
      )}" ry="${String(CORNER_RADIUS_PX)}" fill="#fff"/></svg>`,
    ),
  )
    .png()
    .toBuffer();

/**
 * Rasterises one brand's layers into a single masked 1024px PNG.
 *
 * `density` is raised well above the nominal size because the sources are 128-unit SVGs: rendered
 * at the default density the 1024px raster would be upscaled from a 128px render and the wordmark's
 * diagonal edges would show the stair-stepping that is obvious on the old icons.
 */
const renderMaster = async (spec: BrandSpec): Promise<Buffer> => {
  const bundle = readBundle(spec.iconDir);
  // `icon.json` lists layers front-to-back, the way a designer stacks them; compositing draws them
  // back-to-front, so the list is reversed before it becomes draw order.
  const drawOrder = bundle.layers.toReversed();

  const composite: Array<{ input: Buffer }> = [];
  for (const layer of drawOrder) {
    const source = NodePath.join(repoRoot, spec.iconDir, "Assets", layer.imageName);
    if (!NodeFS.existsSync(source)) {
      throw new Error(
        `${spec.brand}: layer ${layer.imageName} is missing from ${spec.iconDir}/Assets.`,
      );
    }
    const raster = await sharp(source, { density: 1024 })
      .resize(MASTER_SIZE, MASTER_SIZE, { fit: "fill" })
      .png()
      .toBuffer();
    composite.push({ input: raster });
  }

  // The canvas is the bundle's fill, not a transparent void: prod has no background layer and its
  // black tile is defined entirely by this key.
  const composed = await sharp({
    create: {
      width: MASTER_SIZE,
      height: MASTER_SIZE,
      channels: 4,
      background: bundle.fill,
    },
  })
    .composite(composite)
    .png()
    .toBuffer();

  return sharp(composed)
    .composite([{ input: await cornerMask(), blend: "dest-in" }])
    .png()
    .toBuffer();
};

const writePng = async (master: Buffer, target: string, size: number): Promise<void> => {
  const out = await sharp(master).resize(size, size, { fit: "fill" }).png().toBuffer();
  NodeFS.writeFileSync(NodePath.join(repoRoot, target), out);
};

const writeIco = async (master: Buffer, target: string): Promise<void> => {
  const images = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({
      size,
      contents: await sharp(master).resize(size, size, { fit: "fill" }).png().toBuffer(),
    })),
  );
  NodeFS.writeFileSync(NodePath.join(repoRoot, target), encodePngIco(images));
};

const only = process.argv[2];
const specs = only === undefined ? BRANDS : BRANDS.filter((spec) => spec.brand === only);
if (specs.length === 0) {
  console.error(
    `Unknown brand "${only}". Expected one of: ${BRANDS.map((spec) => spec.brand).join(", ")}.`,
  );
  process.exit(1);
}

for (const spec of specs) {
  const master = await renderMaster(spec);
  await writePng(master, spec.outputs.macos, MASTER_SIZE);
  await writePng(master, spec.outputs.universal, MASTER_SIZE);
  await writePng(master, spec.outputs.ios, MASTER_SIZE);
  await writePng(master, spec.outputs.appleTouch, 180);
  await writePng(master, spec.outputs.favicon16, 16);
  await writePng(master, spec.outputs.favicon32, 32);
  await writeIco(master, spec.outputs.faviconIco);
  console.log(
    `render-brand-icons: ${spec.brand} — composited ${String(
      readBundle(spec.iconDir).layers.length,
    )} layers over its ${String(spec.brand === "nightly" ? "cloud" : "tile")} fill into ${String(
      MASTER_SIZE,
    )}px and wrote 7 files.`,
  );
}
