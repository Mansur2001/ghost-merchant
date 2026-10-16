#!/usr/bin/env python3
# Cut the app's icons out of GuriKaabe-brandsheet.png (repo root).
#
# The sheet is one 1536x1024 image, so its small tiles are fewer pixels than their labels.
# Every output here is therefore cut from the two LARGE pieces and scaled DOWN:
#   * the Play Store tile (top right) -> the store listing icon, wordmark included
#   * the house + scooter mark (left) -> launcher icons and favicons, where a wordmark would
#     be unreadable — the sheet's own small tiles drop it for the same reason.
#
# Needs Pillow + numpy (run it from a venv). Writes masters only; mobile/make-icons.sh turns
# those into Android densities with macOS `sips`, so day-to-day builds don't need Pillow.
#
#   python3 scripts/brandsheet-icons.py
#
# The pixel boxes below were measured on the current sheet. A new sheet with a different
# layout needs them re-measured.
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SHEET = ROOT / 'GuriKaabe-brandsheet.png'
RES = ROOT / 'mobile' / 'resources'
WEB = ROOT / 'frontend' / 'user'

PLAY_TILE = (866, 66, 1436, 636)   # rounded cream tile, square, inset past its edge ring
MARK = (128, 12, 752, 518)         # house + scooter, above the wordmark

# Cream from the sheet's tiles: lighter at the top, warmer at the bottom.
CREAM_TOP = (255, 249, 231)
CREAM_BOTTOM = (253, 234, 188)
CREAM_FLAT = '#FDF1D4'             # Android adaptive-icon background (one colour only)

sheet = Image.open(SHEET).convert('RGB')


def gradient(size):
    w, h = size
    t = np.linspace(0, 1, h)[:, None, None]
    top, bot = np.array(CREAM_TOP, float), np.array(CREAM_BOTTOM, float)
    rows = (top + (bot - top) * t).astype(np.uint8)
    return Image.fromarray(np.repeat(rows, w, axis=1), 'RGB')


def keyed_mark():
    """The mark with its white paper made transparent (keeps colour and dark ink opaque)."""
    a = np.asarray(sheet.crop(MARK)).astype(float)
    mn, mx = a.min(axis=2), a.max(axis=2)
    saturated = (mx - mn) > 40
    # Light, unsaturated pixels are paper or soft shadow: fade them out, keep a hint of shadow.
    alpha = np.clip((250 - mn) / 60, 0, 1)
    alpha[saturated | (mx < 120)] = 1
    rgba = np.dstack([a, alpha * 255]).astype(np.uint8)
    img = Image.fromarray(rgba, 'RGBA')
    return img.crop(img.getbbox())


def place(canvas, mark, width_frac, y_bias=0.0):
    """Centre `mark` on `canvas`, scaled to width_frac of the canvas width."""
    W, H = canvas.size
    w = int(W * width_frac)
    h = int(mark.height * w / mark.width)
    m = mark.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(m, ((W - w) // 2, int((H - h) / 2 + y_bias * H)))
    return canvas


def rounded_mask(size, radius_frac):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), int(size * radius_frac), fill=255)
    return m


def circle_mask(size):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).ellipse((0, 0, size - 1, size - 1), fill=255)
    return m


def play_icon():
    """The sheet's Play tile, square-cornered: Google applies its own rounding, and the sheet's
    white corners would otherwise show as white notches."""
    tile = sheet.crop(PLAY_TILE)
    size = tile.width
    bg = gradient((size, size))
    # Keep the tile's own pixels inside its rounded outline; fill the corners with cream.
    out = bg.copy()
    out.paste(tile, (0, 0), rounded_mask(size, 0.17))
    return out.resize((512, 512), Image.LANCZOS)


def tile_icon(size, mark, shape):
    bg = gradient((size, size)).convert('RGBA')
    place(bg, mark, 0.78 if shape == 'square' else 0.66, y_bias=0.01)
    mask = rounded_mask(size, 0.22) if shape == 'square' else circle_mask(size)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    return out


def main():
    mark = keyed_mark()
    RES.mkdir(parents=True, exist_ok=True)

    play_icon().save(RES / 'play-store-icon-512.png')
    tile_icon(1024, mark, 'square').save(RES / 'launcher-master.png')
    tile_icon(1024, mark, 'round').save(RES / 'launcher-round-master.png')

    # Adaptive foreground: 108dp canvas, only the centre 66dp is guaranteed visible under any
    # launcher mask, so the mark sits well inside it.
    fg = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    place(fg, mark, 0.56, y_bias=0.01).save(RES / 'launcher-foreground-master.png')

    # PWA / favicon. Maskable icons get the same safe-zone treatment as Android.
    full = gradient((512, 512)).convert('RGBA')
    place(full, mark, 0.66, y_bias=0.01)
    full.save(WEB / 'icon-512.png')
    full.resize((192, 192), Image.LANCZOS).save(WEB / 'icon-192.png')
    tile_icon(256, mark, 'round').resize((32, 32), Image.LANCZOS).save(WEB / 'favicon-32.png')

    (RES / 'adaptive-background.txt').write_text(CREAM_FLAT + '\n')
    print('wrote masters to', RES, 'and web icons to', WEB)


if __name__ == '__main__':
    main()
