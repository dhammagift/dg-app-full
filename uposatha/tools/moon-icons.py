#!/usr/bin/env python3
"""Draws the eight moon-phase variants of Uposatha's small icons (run from uposatha/):

  ic_stat_moon_0..7   the status-bar icon of a reminder: white on transparent, the unlit part of the moon a thin ring
  shortcut_moon_0..7  the launcher-shortcut icon: white moon on the teal disc, the unlit part faint
  ic_launcher_moon_N_foreground / _monochrome (mipmap-*)  the adaptive launcher icon of the app on its navy plate (the
                      geometry and colours of ic_launcher_foreground.png); ic_launcher_moon_N (mipmap-*) is the pre-Android-8 square

Index 0..7 = new, waxing crescent, first quarter, waxing gibbous, full, waning gibbous, last quarter, waning crescent,
drawn as in the Northern Hemisphere (lit side right while waxing). The bridge asks for the mirrored index in the Southern one.
The geometry is the mark's own (docs/launch-screens): moon circle 39,25 r17; clouds are 7 wide strokes, the moon is cut around them 13 wide.
"""
import math, os
from PIL import Image, ImageDraw, ImageChops

RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')
SS = 8                      # supersampling
CX, CY, R = 39, 25, 17
CLOUDS = [((6, 37), (31, 37)), ((15, 47), (43, 47)), ((50, 47), (53, 47))]
CUTS = CLOUDS[:2]
TEAL = (20, 156, 124)


def lit_mask(i, size, scale, ox, oy):
    """Mask of the lit part of the moon for phase index i (canvas of size x size, unit -> pixel = scale, origin ox, oy)."""
    a = math.radians(i * 45)
    m = Image.new('L', (size, size), 0)
    px = m.load()
    for py_ in range(size):
        y = ((py_ + .5) - oy) / scale - CY
        if abs(y) >= R: continue
        half = math.sqrt(R * R - y * y)
        t = half * math.cos(a)
        x0 = int(math.floor(ox + (CX - half) * scale)); x1 = int(math.ceil(ox + (CX + half) * scale))
        for px_ in range(max(x0, 0), min(x1, size)):
            x = ((px_ + .5) - ox) / scale - CX
            if abs(x) > half: continue
            lit = x > t if i <= 4 else x < -t
            if i == 0: lit = False
            if i == 4: lit = True
            if lit: px[px_, py_] = 255
    return m


def stroke_mask(size, scale, ox, oy, segs, width):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    w = width * scale
    for (x0, y0), (x1, y1) in segs:
        p0 = (ox + x0 * scale, oy + y0 * scale); p1 = (ox + x1 * scale, oy + y1 * scale)
        d.line([p0, p1], fill=255, width=int(round(w)))
        for p in (p0, p1): d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=255)
    return m


def disc_mask(size, scale, ox, oy, r):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).ellipse([ox + (CX - r) * scale, oy + (CY - r) * scale, ox + (CX + r) * scale, oy + (CY + r) * scale], fill=255)
    return m


def compose(i, px, kind):
    size = px * SS
    # The mark spans x 2..56.5, y 7.5..51: fit it into a square, centred, with the requested fill of the canvas.
    fill = 0.95 if kind == 'stat' else 0.72
    scale = size * fill / 54.5
    ox = size / 2 - (29.25) * scale
    oy = size / 2 - (29.25) * scale
    ox = size / 2 - 29.25 * scale; oy = size / 2 - 29.25 * scale
    lit = lit_mask(i, size, scale, ox, oy)
    cut = stroke_mask(size, scale, ox, oy, CUTS, 13)
    clouds = stroke_mask(size, scale, ox, oy, CLOUDS, 7)
    whole = ImageChops.subtract(disc_mask(size, scale, ox, oy, R), cut)
    lit = ImageChops.subtract(lit, cut)
    if kind == 'stat':
        ring = ImageChops.subtract(disc_mask(size, scale, ox, oy, R), disc_mask(size, scale, ox, oy, R - 2.4))
        ring = ImageChops.subtract(ring, cut)
        alpha = ImageChops.lighter(ImageChops.lighter(lit, ring), clouds)
        out = Image.new('RGBA', (size, size), (255, 255, 255, 0))
        out.putalpha(alpha)
    else:
        bg = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(bg).ellipse([0, 0, size - 1, size - 1], fill=TEAL + (255,))
        faint = whole.point(lambda v: v * 0.28)
        white = ImageChops.lighter(ImageChops.lighter(lit, faint), clouds)
        layer = Image.new('RGBA', (size, size), (255, 255, 255, 0)); layer.putalpha(white)
        out = Image.alpha_composite(bg, layer)
    return out.resize((px, px), Image.LANCZOS)


def launcher(i, px, mono):
    """The adaptive icon's foreground layer (px = 108dp in pixels): the mark of ic_launcher_foreground.png, phase i."""
    size = px * SS
    scale = size * 0.010288
    ox, oy = size * 0.19884, size * 0.1977
    lit = lit_mask(i, size, scale, ox, oy)
    cut = stroke_mask(size, scale, ox, oy, CUTS, 13)
    clouds = stroke_mask(size, scale, ox, oy, CLOUDS, 7)
    lit = ImageChops.subtract(lit, cut)
    whole = ImageChops.subtract(disc_mask(size, scale, ox, oy, R), cut)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    if mono:
        for mask, a in ((whole, 0.30), (lit, 1), (clouds, 1)):
            layer = Image.new('RGBA', (size, size), (255, 255, 255, 0)); layer.putalpha(mask.point(lambda v, a=a: int(v * a)))
            out = Image.alpha_composite(out, layer)
    else:
        for mask, col, a in ((whole, MOON, 0.16), (lit, MOON, 1), (clouds, CLOUD, 1)):
            layer = Image.new('RGBA', (size, size), col + (0,)); layer.putalpha(mask.point(lambda v, a=a: int(v * a)))
            out = Image.alpha_composite(out, layer)
    return out.resize((px, px), Image.LANCZOS)


def legacy(i, px):
    """The same on its plate, as one square PNG with rounded corners (Android before 8 has no adaptive icons)."""
    plate = Image.new('RGBA', (px, px), PLATE + (255,))
    plate.alpha_composite(launcher(i, px, False))
    mask = Image.new('L', (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, px * 4 - 1, px * 4 - 1], radius=px * 4 * 22 // 100, fill=255)
    plate.putalpha(mask.resize((px, px), Image.LANCZOS))
    return plate


MOON, CLOUD, PLATE = (223, 232, 240), (159, 179, 198), (36, 52, 72)
DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
if __name__ == '__main__':
    for d, k in DENS.items():
        os.makedirs(os.path.join(RES, 'drawable-' + d), exist_ok=True)
        for i in range(8):
            compose(i, int(24 * k), 'stat').save(os.path.join(RES, 'drawable-' + d, 'ic_stat_moon_%d.png' % i))
            compose(i, int(48 * k), 'shortcut').save(os.path.join(RES, 'drawable-' + d, 'shortcut_moon_%d.png' % i))
            mm = os.path.join(RES, 'mipmap-' + d); os.makedirs(mm, exist_ok=True)
            launcher(i, int(108 * k), False).save(os.path.join(mm, 'ic_launcher_moon_%d_foreground.png' % i))
            launcher(i, int(108 * k), True).save(os.path.join(mm, 'ic_launcher_moon_%d_monochrome.png' % i))
            legacy(i, int(48 * k)).save(os.path.join(mm, 'ic_launcher_moon_%d.png' % i))
    print('ok')
