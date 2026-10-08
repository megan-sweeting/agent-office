#!/usr/bin/env python3
"""Make critter mood pictures with the Gemini API.

  python3 app/gemini.py <mood> [critter ...] [--redo] [--yes]
  python3 app/gemini.py fix <critter> <normal|mood> "<change>"
  e.g. python3 app/gemini.py focused forest-bunny
       python3 app/gemini.py curious --yes        (all 16 hireable critters)
       python3 app/gemini.py fix cottage-kitten needs "remove the pencil behind its ear"

Sends assets/critters/<critter>.png and the mood's prompt to Gemini, keeps the raw
result in .gemini-raw/, then cuts and places it with mood.py so it lands in
assets/critters/moods/<critter>-<mood>.png. Skips pictures that already exist
unless --redo. More than 2 pictures asks for --yes first. Ends by saving a
contact sheet (original | new) to .gemini-raw/sheet-<mood>.png for checking.

The API key comes from GEMINI_API_KEY or ~/.config/agent-office/gemini-key.
"""
import base64
import http.client
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mood import cut, place  # noqa: E402

# Nano Banana 2 Lite: the cheapest Flash image model that takes an input picture.
MODEL = 'gemini-3.1-flash-lite-image'
PRICE = 0.034  # US dollars per picture (1K output), Oct 2026
URL = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent'

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / '.gemini-raw'

MOODS = {
    'focused': 'Show it concentrating hard on its work: eyebrows drawn down slightly in concentration '
               'and a tiny tongue poking out of the corner of its mouth',
    'curious': 'Show it curious and intrigued: head tilted a little to one side, eyebrows raised, '
               'a small round "ooh" mouth, leaning in slightly as if it just spotted something interesting',
    'proud': 'Show it proud and beaming after finishing a job: a big happy smile, chin lifted, chest '
             'puffed out, rosy cheeks, and one small sparkle in the air beside its head',
    'stuck': 'Show it gently puzzled and stuck on a problem, cute and never scary or angry: a small '
             'unsure wobbly mouth, a little sweat drop beside its head, and a small scribbly tangle '
             'inside a thought bubble that floats clearly above its head, not touching it',
    # Shown on a snack break, so the critter swaps its work prop for a snack.
    'relaxed': 'Show it happily on a snack break: a gentle contented smile and rosy cheeks, eyes fully '
               'open, about to take a happy bite',
}
PROMPT = ('Create an image of this exact same {animal} character: same watercolor style, same outfit, '
          'accessories and props, same proportions and colors, same framing, on a plain white background. '
          '{mood}. Keep the same pose and stance as the original. {extra}{props} Same number of arms and '
          'legs as the original, no extra limbs. Keep the eyes exactly like the original: solid dark round '
          'eyes with only small white shine dots, no whites of the eyes.')
PROPS = ('Every prop must be held, never floating. Do not add any new objects: only the props in the '
         'original, and paws that are empty in the original stay empty.')
# Moods that change what the critter holds.
PROPS_FOR = {
    'relaxed': 'Put away whatever it was holding in its paws (keep clothes, hats, headphones, glasses and '
               'backpacks on) and instead it holds one small snack that suits a {animal}, like a cookie, '
               'berry or tiny sandwich. The snack is held, never floating. No other new objects.',
}
# Per-critter additions to the prompt. A "<critter>-<mood>" entry replaces the critter's own for that mood.
EXTRA = {
    'meadow-fawn': 'She stands on three legs and holds the tablet with her fourth leg; keep exactly that '
                   'pose and never raise another hoof. ',
    'meadow-fawn-relaxed': 'She stands on three legs and holds the snack with her fourth leg instead of the '
                           'tablet; never raise another hoof. ',
    'meadow-redpanda': 'Its paws hold its backpack straps and nothing else: no map, paper or book. ',
    'meadow-redpanda-relaxed': 'It keeps its backpack on. ',
    'cottage-hedgehog': 'It keeps holding its paintbrush. ',
    'cottage-hedgehog-relaxed': 'It wears nothing at all, exactly like the original: no hat, glasses, '
                                'headphones or bag. ',
    'forest-frog-relaxed': 'The laptop and its little wooden desk are both put away, nothing in front of it. ',
    'cottage-kitten': 'It has no pencil anywhere. ',
    'garden-turtle': 'It keeps its round glasses on. ',
    'garden-mole': 'It is seen from the side, so only ONE eye shows, exactly like the original. ',
    'forest-owl-stuck': 'No eyebrows or frown lines at all: show the puzzlement with a slight head tilt '
                        'and a small unsure beak. ',
    'cottage-hedgehog-curious': 'Wide open friendly face, eyebrows raised high, absolutely not frowning. '
                                'It keeps holding its paintbrush. ',
    'garden-lamb-stuck': 'Keep its face sweet and soft like the original: just slightly worried eyebrows '
                         'and a tiny wobbly mouth. ',
}
FIX = ('Edit this image of a {animal} character: {change}. Change nothing else: same watercolor style, '
       'pose, outfit, colors, proportions and framing, on a plain white background. Keep the eyes exactly '
       'as they are.')


def critters():
    """The hireable critters and their animals, from the hiring pool in server.mjs."""
    src = (ROOT / 'server.mjs').read_text()
    pool = src[src.index('const CRITTERS = ['):]
    return dict(re.findall(r"^\s*\['([a-z-]+)', '[^']*', '([^']+)'", pool, re.M))


def api_key():
    key = os.environ.get('GEMINI_API_KEY')
    if not key:
        f = Path.home() / '.config/agent-office/gemini-key'
        key = f.read_text().strip() if f.exists() else ''
    if not key:
        sys.exit('No Gemini key: set GEMINI_API_KEY or put it in ~/.config/agent-office/gemini-key')
    return key


def mood_prompt(critter, animal, mood):
    extra = EXTRA.get(f'{critter}-{mood}', EXTRA.get(critter, ''))
    props = PROPS_FOR.get(mood, PROPS).format(animal=animal)
    return PROMPT.format(animal=animal, mood=MOODS[mood], extra=extra, props=props)


def on_white(path):
    """The picture as PNG bytes on a white background, so see-through parts don't read as black."""
    im = Image.open(path).convert('RGBA')
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    buf = io.BytesIO()
    bg.convert('RGB').save(buf, 'PNG')
    return buf.getvalue()


def generate(key, png, prompt):
    """Ask Gemini for the picture; returns the image bytes."""
    body = json.dumps({
        'contents': [{'parts': [
            {'inline_data': {'mime_type': 'image/png', 'data': base64.b64encode(png).decode()}},
            {'text': prompt},
        ]}],
        'generationConfig': {'responseModalities': ['IMAGE'], 'imageConfig': {'aspectRatio': '1:1'}},
    }).encode()
    req = urllib.request.Request(URL, body, {'Content-Type': 'application/json', 'x-goog-api-key': key})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                res = json.load(r)
            break
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors='replace')[:300]
            if e.code in (429, 500, 503) and attempt < 2:
                time.sleep(10 * (attempt + 1))
                continue
            raise RuntimeError(f'HTTP {e.code}: {msg}') from None
        except (http.client.IncompleteRead, ConnectionError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(5)
    for cand in res.get('candidates', []):
        for part in cand.get('content', {}).get('parts', []):
            data = (part.get('inline_data') or part.get('inlineData') or {}).get('data')
            if data:
                return base64.b64decode(data)
    why = res.get('promptFeedback') or [c.get('finishReason') for c in res.get('candidates', [])]
    raise RuntimeError(f'no image came back ({why})')


def sheet(mood, names):
    """Original | new, one row per critter."""
    rows = [n for n in names if (ROOT / 'assets/critters/moods' / f'{n}-{mood}.png').exists()]
    if not rows:
        return None
    S, LABEL = 256, 22
    out = Image.new('RGB', (S * 2, (S + LABEL) * len(rows)), (238, 236, 230))
    draw = ImageDraw.Draw(out)
    for i, n in enumerate(rows):
        y = i * (S + LABEL)
        draw.text((6, y + 5), f'{n}  |  {mood}', fill=(60, 60, 60))
        for j, f in enumerate((ROOT / 'assets/critters' / f'{n}.png', ROOT / 'assets/critters/moods' / f'{n}-{mood}.png')):
            out.paste(Image.open(f).convert('RGBA'), (j * S, y + LABEL), Image.open(f).convert('RGBA'))
    dest = RAW / f'sheet-{mood}.png'
    out.save(dest)
    return dest


def fix(args):
    """Edit one existing picture: fix <critter> <normal|mood> "<change>"."""
    if len(args) != 3:
        sys.exit(__doc__)
    critter, mood, change = args
    pool = critters()
    if critter not in pool:
        sys.exit('Unknown critter: ' + critter)
    ref_path = ROOT / 'assets/critters' / f'{critter}.png'
    dest = ref_path if mood == 'normal' else ROOT / 'assets/critters/moods' / f'{critter}-{mood}.png'
    if not dest.exists():
        sys.exit(f'No picture yet: {dest.relative_to(ROOT)}')
    RAW.mkdir(exist_ok=True)
    raw = RAW / f'{critter}-{mood}-fix.png'
    raw.write_bytes(generate(api_key(), on_white(dest), FIX.format(animal=pool[critter], change=change)))
    ref = Image.open(ref_path).convert('RGBA')
    place(cut(raw), ref).save(dest, optimize=True)
    print('Saved', dest.relative_to(ROOT))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    redo, yes = '--redo' in sys.argv, '--yes' in sys.argv
    if args and args[0] == 'fix':
        return fix(args[1:])
    if not args or args[0] not in MOODS:
        sys.exit(__doc__ + '\nMoods: ' + ', '.join(MOODS))
    mood, pool = args[0], critters()
    names = args[1:] or list(pool)
    unknown = [n for n in names if n not in pool]
    if unknown:
        sys.exit('Unknown critter: ' + ', '.join(unknown) + '\nCritters: ' + ', '.join(pool))
    todo = [n for n in names if redo or not (ROOT / 'assets/critters/moods' / f'{n}-{mood}.png').exists()]
    if len(todo) > 2 and not yes:
        sys.exit(f'{len(todo)} pictures, about ${len(todo) * PRICE:.2f} with {MODEL}. Add --yes to go ahead.')
    key = api_key()
    RAW.mkdir(exist_ok=True)
    failed = []
    for n in todo:
        print(f'{n} {mood}…', end=' ', flush=True)
        try:
            raw = RAW / f'{n}-{mood}.png'
            png = (ROOT / 'assets/critters' / f'{n}.png').read_bytes()
            raw.write_bytes(generate(key, png, mood_prompt(n, pool[n], mood)))
            ref = Image.open(ROOT / 'assets/critters' / f'{n}.png').convert('RGBA')
            dest = ROOT / 'assets/critters/moods' / f'{n}-{mood}.png'
            dest.parent.mkdir(exist_ok=True)
            place(cut(raw), ref, by_height=mood in PROPS_FOR).save(dest, optimize=True)
            print('saved')
        except Exception as e:  # keep going so one bad picture doesn't stop the batch
            print('failed:', e)
            failed.append(n)
    s = sheet(mood, list(pool))  # every critter with this mood, so a redo doesn't shrink the sheet
    if s:
        print('Contact sheet:', s.relative_to(ROOT))
    if failed:
        sys.exit('Failed: ' + ' '.join(failed))


if __name__ == '__main__':
    main()
