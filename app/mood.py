#!/usr/bin/env python3
"""Turn a Gemini mood picture into an office critter PNG.

  python3 app/mood.py <gemini.jpeg> <critter> <mood>
  e.g. python3 app/mood.py ~/Downloads/Gemini_x.jpeg forest-fox needs

Cuts away the white background, then scales the critter to match its
normal picture in assets/critters (same width and feet line), so it does
not grow or shrink when its mood changes. Saves assets/critters/moods/<critter>-<mood>.png.

Gemini prompt tip: upload the critter's normal picture and add "keep the eyes
exactly like the original, solid dark round eyes with only small white shine
dots. No whites of the eyes showing. Show the worry only with the eyebrows and
mouth." Without it, Gemini tends to add eye whites, which looks off-model.
"""
import sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
WORK = 512        # cut the background at this size; the final picture is 256
WHITE = 232       # brighter than this on every channel counts as paper


def lower_width(alpha):
    """Width of the critter's lower 35%: feet, belly and held props, not raised paws or the floating ? or zzz."""
    l, t, r, b = alpha.getbbox()
    return alpha.crop((l, t + (b - t) * 13 // 20, r, b)).getbbox(), (l, t, r, b)


def cut(src):
    im = Image.open(src).convert('RGB').resize((WORK, WORK), Image.LANCZOS)
    light = ImageChops.darker(ImageChops.darker(*im.split()[:2]), im.split()[2])
    paper = light.point(lambda v: 255 if v >= WHITE else 0)
    # Only paper that touches the edge is background; the white belly and eye glints stay.
    for i in range(0, WORK, 4):
        for xy in ((i, 0), (i, WORK - 1), (0, i), (WORK - 1, i)):
            if paper.getpixel(xy) == 255:
                ImageDraw.floodfill(paper, xy, 128)
    bg = paper.point(lambda v: 255 if v == 128 else 0)
    alpha = ImageChops.invert(bg)
    # Soft edge: near the background, lighter pixels fade out instead of leaving a white halo.
    ring = ImageChops.subtract(bg.filter(ImageFilter.MaxFilter(5)), bg)
    fade = light.point(lambda v: max(0, min(255, (255 - v) * 4)))
    alpha = Image.composite(ImageChops.darker(alpha, fade), alpha, ring)
    im.putalpha(alpha.filter(ImageFilter.GaussianBlur(0.6)))
    return im


def place(im, ref):
    """Scale and position to match the normal picture's width and feet line."""
    (rl, _, rr, _), (_, _, _, rb) = lower_width(ref.split()[3])
    (ml, _, mr, _), (l, t, r, b) = lower_width(im.split()[3])
    k = (rr - rl) / (mr - ml)
    im = im.crop((l, t, r, b))
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    out = Image.new('RGBA', ref.size, (0, 0, 0, 0))
    left = round((rl + rr) / 2 - ((ml - l) + (mr - l)) / 2 * k)
    out.alpha_composite(im, (max(0, left), max(0, rb - im.height)))
    return out


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    src, critter, mood = sys.argv[1:]
    ref = Image.open(ROOT / 'assets/critters' / f'{critter}.png').convert('RGBA')
    dest = ROOT / 'assets/critters/moods' / f'{critter}-{mood}.png'
    dest.parent.mkdir(exist_ok=True)
    place(cut(src), ref).save(dest, optimize=True)
    print('Saved', dest.relative_to(ROOT))
