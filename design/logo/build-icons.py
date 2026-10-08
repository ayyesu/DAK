#!/usr/bin/env python3
"""Build Dak's logo: every icon and mark from one set of outlines.

WORDMARK below is the DAK wordmark traced from the artwork (1024 x 1024, the
"DAK" tile): three closed outlines, one per letter, no counters. Everything
else in the repository is generated from it, so the drawing lives in exactly
one place:

  * design/logo/dak-icon-1024.png    the master icon
  * app/src-tauri/icons/             what Tauri bundles: .png, .ico, .icns
                                     and the Windows store tiles
  * internal/box/phoneui/            the phone companion's icons
  * site/ and docs-site/             the apple-touch icons
  * *.svg                            the mark and the favicons

Framing: the app icons are the tile inset in a transparent canvas (100..924 of
1024, as they always were), the phone icons are the tile full bleed with
rounded corners, and the apple-touch icons are an opaque square. The wordmark
is 88.6% of the tile's width everywhere, as it is in the artwork.

Requires Pillow and numpy:

    python design/logo/build-icons.py
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]

# --- The drawing ------------------------------------------------------------
# Traced from the artwork at 1024 x 1024.
WORDMARK: list[list[tuple[int, int]]] = [
    # A
    [(518, 346), (438, 486), (405, 547), (382, 586), (378, 595), (357, 630),
     (442, 630), (518, 503), (522, 508), (524, 513), (563, 578), (592, 630),
     (670, 630), (671, 631), (681, 630), (658, 587), (613, 510), (602, 489),
     (597, 482), (519, 346)],
    # K
    [(739, 345), (732, 349), (686, 395), (626, 452), (609, 470), (737, 623),
     (743, 627), (752, 630), (811, 630), (812, 631), (819, 631), (820, 630),
     (833, 631), (837, 630), (838, 631), (830, 621), (761, 547), (695, 480),
     (830, 343), (747, 343)],
    # D
    [(207, 342), (206, 343), (206, 411), (210, 412), (283, 412), (297, 415),
     (309, 420), (321, 428), (330, 437), (340, 453), (345, 472), (345, 494),
     (341, 510), (330, 530), (314, 546), (298, 555), (279, 560), (208, 562),
     (206, 564), (207, 565), (206, 566), (207, 631), (280, 631), (281, 630),
     (298, 629), (311, 625), (320, 621), (334, 612), (355, 591), (372, 568),
     (386, 546), (406, 509), (412, 496), (417, 481), (420, 465), (419, 438),
     (412, 414), (399, 391), (392, 382), (378, 368), (360, 355), (343, 347),
     (319, 342)],
]

MARK_BOX = (206, 342, 838, 631)  # the wordmark's tight bounding box
MARK_W = MARK_BOX[2] - MARK_BOX[0]

TILE = (100, 100, 924, 924)  # the app tile inside the 1024 canvas
TILE_RX = 185
FULL = (0, 0, 1024, 1024)  # the phone tile: full bleed
PHONE_RX = 184

WIDTH_RATIO = 0.886  # the wordmark's width as a share of the tile's
INK = "#ecebe7"  # the wordmark on the tile
INK_RGB = (236, 235, 231)
BG_TOP = (30, 30, 30)
BG_BOTTOM = (7, 7, 7)


def wordmark_fit(box: tuple[float, float, float, float]) -> tuple[float, float, float]:
    """Where the wordmark sits in a tile: (scale, dx, dy)."""
    x0, y0, x1, y1 = box
    s = WIDTH_RATIO * (x1 - x0) / MARK_W
    dx = (x0 + x1) / 2 - s * (MARK_BOX[0] + MARK_BOX[2]) / 2
    dy = (y0 + y1) / 2 - s * (MARK_BOX[1] + MARK_BOX[3]) / 2
    return s, dx, dy


def path_data() -> str:
    parts = []
    for poly in WORDMARK:
        head, *rest = poly
        parts.append(f"M{head[0]} {head[1]}" + "".join(f"L{x} {y}" for x, y in rest) + "Z")
    return "".join(parts)


# --- SVG ---------------------------------------------------------------------
def mark_svg() -> str:
    """The wordmark alone, for the app's own surfaces (fill: currentColor)."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{MARK_BOX[0]} {MARK_BOX[1]} {MARK_W} {MARK_BOX[3] - MARK_BOX[1]}">'
        f'<path d="{path_data()}" fill="currentColor" fill-rule="evenodd"/>'
        "</svg>\r\n"
    )


def tile_svg(view_box: str) -> str:
    """The tile and the wordmark: the favicon."""
    x0, y0, x1, y1 = TILE
    s, dx, dy = wordmark_fit(TILE)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}"><defs>'
        '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#1e1e1e"/><stop offset="1" stop-color="#070707"/>'
        "</linearGradient>"
        '<linearGradient id="hl" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#fff" stop-opacity=".09"/>'
        '<stop offset=".45" stop-color="#fff" stop-opacity="0"/>'
        "</linearGradient></defs>"
        f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{TILE_RX}" fill="url(#bg)"/>'
        f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{TILE_RX}" fill="url(#hl)"/>'
        f'<rect x="{x0 + 1.5}" y="{y0 + 1.5}" width="{x1 - x0 - 3}" height="{y1 - y0 - 3}"'
        f' rx="{TILE_RX - 1.5}" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="3"/>'
        f'<path d="{path_data()}" fill="{INK}" fill-rule="evenodd" '
        f'transform="translate({dx:.1f} {dy:.1f}) scale({s:.4f})"/>'
        "</svg>\r\n"
    )


# --- Raster ------------------------------------------------------------------
def render(size: int, box=TILE, radius: int = TILE_RX, ss: int | None = None) -> Image.Image:
    """The icon at `size`: the tile at `box` with the wordmark inside it."""
    if ss is None:
        ss = 4 if size <= 256 else 2
    n = size * ss
    k = n / 1024
    x0, y0, x1, y1 = (v * k for v in box)
    r = radius * k

    # The tile: a soft diagonal wash, near-black to black.
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    t = np.clip(((xx - x0) / (x1 - x0) + (yy - y0) / (y1 - y0)) / 2, 0, 1)[..., None]
    wash = np.array(BG_TOP, np.float32) * (1 - t) + np.array(BG_BOTTOM, np.float32) * t

    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=r, fill=255)

    icon = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    icon.paste(Image.fromarray(wash.astype(np.uint8), "RGB").convert("RGBA"), (0, 0), mask)

    # A sheen across the top third, and the tile's faint rim.
    sheen = Image.new("RGBA", (n, n), (255, 255, 255, 0))
    ramp = np.clip(1 - (yy - y0) / ((y1 - y0) * 0.45), 0, 1) * 24
    sheen.putalpha(Image.fromarray(ramp.astype(np.uint8), "L"))
    rim = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle(
        (x0 + 1.5 * k, y0 + 1.5 * k, x1 - 1.5 * k, y1 - 1.5 * k),
        radius=max(0.0, r - 1.5 * k), outline=(255, 255, 255, 20), width=max(1, round(3 * k)))

    s, dx, dy = wordmark_fit(box)
    ink = Image.new("L", (n, n), 0)
    draw = ImageDraw.Draw(ink)
    for poly in WORDMARK:
        draw.polygon([(x * k * s + dx * k, y * k * s + dy * k) for x, y in poly], fill=255)

    out = Image.alpha_composite(icon, sheen)
    out = Image.alpha_composite(out, rim)
    out.paste(Image.new("RGBA", (n, n), INK_RGB + (255,)), (0, 0), ink)
    return out.resize((size, size), Image.LANCZOS)


def write_icns(path: Path, sizes: tuple[int, ...] = (16, 32, 64, 128, 256, 512, 1024)) -> None:
    """An .icns carrying a PNG for every size macOS asks for."""
    otypes = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07", 256: b"ic08",
              512: b"ic09", 1024: b"ic10"}
    chunks = b""
    for size in sizes:
        buf = io.BytesIO()
        render(size).save(buf, format="PNG")
        payload = buf.getvalue()
        chunks += otypes[size] + struct.pack(">I", len(payload) + 8) + payload
    path.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


def main() -> None:
    svg_targets = {
        "design/logo/dak-mark.svg": mark_svg(),
        "app/public/dak-mark.svg": mark_svg(),
        "site/demo/dak-mark.svg": mark_svg(),
        "design/logo/b2-mono.svg": tile_svg("0 0 1024 1024"),
        "app/public/favicon.svg": tile_svg("0 0 1024 1024"),
        "site/assets/favicon.svg": tile_svg("100 100 824 824"),
        "site/demo/favicon.svg": tile_svg("100 100 824 824"),
        "docs-site/app/icon.svg": tile_svg("100 100 824 824"),
    }
    for name, text in svg_targets.items():
        (ROOT / name).write_text(text, encoding="utf-8", newline="")

    icons = ROOT / "app/src-tauri/icons"
    render(1024).save(ROOT / "design/logo/dak-icon-1024.png")
    render(512).save(icons / "icon.png")
    for size in (32, 64, 128, 256):
        render(size).save(icons / ("128x128@2x.png" if size == 256 else f"{size}x{size}.png"))
    for name, size in {
        "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89, "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150, "Square284x284Logo.png": 284, "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }.items():
        render(size).save(icons / name)

    render(1024).save(icons / "icon.ico", format="ICO",
                      sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    write_icns(icons / "icon.icns")

    render(512, box=FULL, radius=PHONE_RX).save(ROOT / "internal/box/phoneui/icon-512.png")
    render(192, box=FULL, radius=PHONE_RX).save(ROOT / "internal/box/phoneui/icon-192.png")
    render(180, box=FULL, radius=0).save(ROOT / "internal/box/phoneui/apple-touch-icon.png")
    flat = render(180, box=FULL, radius=0).convert("RGB")
    flat.save(ROOT / "site/assets/apple-touch-icon.png")
    flat.save(ROOT / "docs-site/app/apple-icon.png")

    print("wrote 4 marks, 4 favicons, the master icon and 26 icon files")


if __name__ == "__main__":
    main()
