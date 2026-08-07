#!/usr/bin/env python3
"""
Generate PWA icons for pAInapple Code.

A clean low-poly pineapple — a symmetric gold triangle-mesh barrel with a
pointed base and a fan of angular green crown blades, over the app's dark
gradient. A ">" prompt + cursor in the accent color sits on the fruit's face
(64px and up) to keep the terminal identity, haloed by a dark tint of that
same accent; the tiny favicons render as the pure fruit.

`create_icon(size)` is the shared primitive: it feeds both the static PWA
icon set (via main()) and the runtime per-instance icons that server.py
overlays with an accent banner. Editing it propagates everywhere.
"""

from PIL import Image, ImageDraw
import math
import os

# Icon sizes needed for PWA
SIZES = [72, 96, 128, 144, 152, 180, 192, 384, 512]

# Background gradient + prompt colors (app theme)
BG_COLOR_TOP = (26, 26, 46)      # #1a1a2e
BG_COLOR_BOTTOM = (30, 35, 50)   # #1e2332
# The prompt glyph — chevron AND cursor share this one color, and its own
# dark tint (see PROMPT_SHADE) forms the halo that lifts it off the gold.
ACCENT_COLOR = (34, 197, 94)     # #22c55e (app --accent-green)
PROMPT_SHADE = 0.30              # halo = ACCENT_COLOR scaled to this brightness
PROMPT_HALO = 0.008              # halo thickness as a fraction of icon size;
                                 # one value drives BOTH strokes, so the
                                 # chevron's border always matches the cursor's
PROMPT_SCALE = 1.20              # overall size of the ">|" mark (1.0 = original);
                                 # scales extents, strokes and halo together

# Fruit body — a single warm gold, shaded per-facet by _shade().
GOLD = (240, 196, 52)

# ---- body geometry (fractions of the icon size) ----------------------------
CX = 0.5           # horizontal center
BODY_TOP = 0.46    # y of the topmost row
BODY_H = 0.485     # vertical extent of the body
BW = 0.205         # half-width fraction at the widest row

# Clean SYMMETRIC rows: (y 0..1 within the body, width-scale, [x in -1..1]).
# Rows alternate between having a center vertex and not, so the diagonals
# zigzag into a diamond lattice instead of stacking into a vertical seam.
ROWS = [
    (0.00, 0.52, [-1.0, 0.0, 1.0]),
    (0.19, 0.90, [-1.0, -0.45, 0.45, 1.0]),
    (0.40, 1.00, [-1.0, -0.50, 0.0, 0.50, 1.0]),
    (0.62, 0.98, [-1.0, -0.45, 0.45, 1.0]),
    (0.82, 0.84, [-1.0, -0.50, 0.0, 0.50, 1.0]),
    (0.95, 0.52, [-1.0, 0.0, 1.0]),
    (1.00, 0.00, [0.0]),                     # bottom point
]

# ---- crown: clean fan of separated blades ----------------------------------
#   (angle_from_vertical_deg, length_frac, base_halfwidth_frac, green_key)
BLADES = [
    (0,   0.44, 0.060, 'lime'),
    (-17, 0.39, 0.056, 'bright'),
    (17,  0.39, 0.056, 'bright'),
    (-36, 0.32, 0.052, 'mid'),
    (36,  0.32, 0.052, 'mid'),
    (-58, 0.25, 0.048, 'dark'),
    (58,  0.25, 0.048, 'dark'),
    (-82, 0.17, 0.042, 'deep'),
    (82,  0.17, 0.042, 'deep'),
]
GREENS = {           # (light-half, dark-half) for the two-tone spine split
    'lime':   ((150, 214, 84), (104, 180, 68)),
    'bright': ((112, 194, 80), (74, 162, 70)),
    'mid':    ((72, 158, 78),  (48, 130, 66)),
    'dark':   ((44, 124, 66),  (30, 100, 56)),
    'deep':   ((30, 96, 58),   (20, 74, 48)),
}


def create_gradient(size, top=BG_COLOR_TOP, bot=BG_COLOR_BOTTOM):
    """Create a vertical gradient background."""
    img = Image.new('RGB', (size, size), top)
    draw = ImageDraw.Draw(img)
    for y in range(size):
        r = y / size
        draw.line([(0, y), (size, y)],
                  fill=tuple(int(top[i] + (bot[i] - top[i]) * r) for i in range(3)))
    return img


def _row_pts(size, i):
    """Pixel points for mesh row i."""
    ry, sw, xs = ROWS[i]
    return [((CX + f * sw * BW) * size, (BODY_TOP + ry * BODY_H) * size) for f in xs]


def _strip(top, bottom):
    """Zigzag triangulation between two symmetric rows of any length."""
    if len(bottom) == 1:
        return [(top[k], bottom[0], top[k + 1]) for k in range(len(top) - 1)]
    if len(top) == 1:
        return [(top[0], bottom[k], bottom[k + 1]) for k in range(len(bottom) - 1)]
    tris, i, j = [], 0, 0
    while i < len(top) - 1 or j < len(bottom) - 1:
        if i >= len(top) - 1:
            tris.append((top[i], bottom[j], bottom[j + 1])); j += 1
        elif j >= len(bottom) - 1:
            tris.append((top[i], bottom[j], top[i + 1])); i += 1
        elif top[i + 1][0] <= bottom[j + 1][0]:
            tris.append((top[i], bottom[j], top[i + 1])); i += 1
        else:
            tris.append((top[i], bottom[j], bottom[j + 1])); j += 1
    return tris


def build_mesh(size):
    """The full list of body triangles."""
    rows = [_row_pts(size, i) for i in range(len(ROWS))]
    tris = []
    for i in range(len(rows) - 1):
        tris += _strip(rows[i], rows[i + 1])
    return tris


def _centroid(tri):
    return (sum(p[0] for p in tri) / 3, sum(p[1] for p in tri) / 3)


def _shade(base, cxp, cyp, size, spread=1.35):
    """Backlit shade: brightest near an upper-center highlight, darker at rim."""
    hx, hy = CX * size, (BODY_TOP + 0.34 * BODY_H) * size
    dx = (cxp - hx) / (BW * size * spread)
    dy = (cyp - hy) / (BODY_H * size * 0.8)
    dist = math.sqrt(dx * dx + dy * dy)
    f = max(0.60, 1.20 - 0.52 * dist)
    return tuple(min(255, int(c * f)) for c in base)


def draw_crown(draw, size):
    """Draw the angular fan of green crown blades above the body."""
    cx = CX * size
    base_y = (BODY_TOP + 0.05) * size
    for ang, length, hw, key in BLADES:
        rad = math.radians(ang)
        bx = cx + math.sin(rad) * 0.075 * size             # bases fan into a rosette
        apex = (cx + math.sin(rad) * length * size,
                base_y - math.cos(rad) * length * size)
        # base edge perpendicular to the blade so wide leaves stay leaf-shaped
        px, py = math.cos(rad), math.sin(rad)
        bl = (bx - px * hw * size, base_y + 0.02 * size - py * hw * size)
        br = (bx + px * hw * size, base_y + 0.02 * size + py * hw * size)
        bc = (bx, base_y + 0.04 * size)
        cl, cr = GREENS[key]
        draw.polygon((bl, apex, bc), fill=cl)
        draw.polygon((bc, apex, br), fill=cr)


def _darken(color, factor=PROMPT_SHADE):
    """A darker tint of `color` — used for the prompt's halo."""
    return tuple(max(0, int(c * factor)) for c in color)


def draw_terminal_prompt(draw, size):
    """Draw the ">" prompt + cursor sticker on the pineapple's face.

    Chevron and cursor are both ACCENT_COLOR; a dark tint of that same color
    haloes them so the glyph reads against the gold facets without introducing
    an unrelated hue.
    """
    pcx = CX * size
    pcy = (BODY_TOP + 0.52 * BODY_H) * size
    # Every glyph metric is measured off `gs`, so PROMPT_SCALE resizes the
    # whole mark uniformly — strokes and halo grow with it, not just the extents.
    gs = size * PROMPT_SCALE
    ps = gs * 0.17
    pts = [(pcx - ps * 0.46, pcy - ps * 0.42), (pcx + ps * 0.16, pcy),
           (pcx - ps * 0.46, pcy + ps * 0.42)]
    lw = max(2, int(gs * 0.044))
    halo = _darken(ACCENT_COLOR)
    cw = max(2, int(gs * 0.036))
    pad = max(1, int(gs * PROMPT_HALO))
    # Dark-tint halo so the glyph reads on the gold facets. Both strokes are
    # inset by `pad` on every side, so the chevron's border matches the cursor's.
    draw.line(pts, fill=halo, width=lw + 2 * pad, joint="curve")
    draw.rectangle([(pcx + ps * 0.36 - pad, pcy - ps * 0.34 - pad),
                    (pcx + ps * 0.36 + cw + pad, pcy + ps * 0.34 + pad)], fill=halo)
    # Chevron + cursor, both in the accent color
    draw.line(pts, fill=ACCENT_COLOR, width=lw, joint="curve")
    draw.rectangle([(pcx + ps * 0.36, pcy - ps * 0.34),
                    (pcx + ps * 0.36 + cw, pcy + ps * 0.34)], fill=ACCENT_COLOR)


def create_icon(size):
    """Create a single icon at the specified size."""
    img = create_gradient(size)
    draw = ImageDraw.Draw(img)

    draw_crown(draw, size)
    for tri in build_mesh(size):
        cxp, cyp = _centroid(tri)
        draw.polygon(tri, fill=_shade(GOLD, cxp, cyp, size))
    # Prompt on the fruit's face — legible from ~64px up; tiny favicons stay pure fruit
    if size >= 64:
        draw_terminal_prompt(draw, size)

    return img


def create_rounded_icon(size, radius_ratio=0.2):
    """Create icon with rounded corners (for iOS)."""
    img = create_icon(size)
    mask = Image.new('L', (size, size), 0)
    radius = int(size * radius_ratio)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (size, size)], radius=radius, fill=255)
    output = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    output.paste(img, mask=mask)
    return output


def main():
    output_dir = 'static/icons'
    os.makedirs(output_dir, exist_ok=True)

    print("Generating PWA icons...")

    for size in SIZES:
        img = create_icon(size)
        path = f'{output_dir}/icon-{size}.png'
        img.save(path, 'PNG')
        print(f"  Created: {path}")

    apple_icon = create_icon(180)
    apple_path = f'{output_dir}/apple-touch-icon.png'
    apple_icon.save(apple_path, 'PNG')
    print(f"  Created: {apple_path}")

    favicon = create_icon(32)
    favicon_path = f'{output_dir}/favicon-32.png'
    favicon.save(favicon_path, 'PNG')
    print(f"  Created: {favicon_path}")

    favicon_16 = create_icon(16)
    ico_path = f'{output_dir}/favicon.ico'
    favicon_16.save(ico_path, format='ICO', sizes=[(16, 16), (32, 32)])
    print(f"  Created: {ico_path}")

    print("\nDone! Icons generated in", output_dir)


if __name__ == '__main__':
    main()
