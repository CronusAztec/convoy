#!/opt/hermes/.venv/bin/python3
"""1200x630 Open Graph card: headline + two real screenshots on the app's near-black."""
from PIL import Image, ImageDraw, ImageFont
import os
ROOT = '/opt/data/convoy'
SRC = f'{ROOT}/scripts/landing-shots/out'
OUT = f'{ROOT}/landing/img/og.png'
W, H = 1200, 630
bg = (12, 13, 15)
im = Image.new('RGB', (W, H), bg)
d = ImageDraw.Draw(im)

# Fonts: the app's own Chakra Petch (woff2 can't be read by PIL) -> use the TTF if available, else DejaVu.
def font(size, bold=True):
    for p in [f'{ROOT}/scripts/landing-shots/ChakraPetch-Bold.ttf' if bold else f'{ROOT}/scripts/landing-shots/ChakraPetch-Regular.ttf',
              '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def phone(src, w):
    s = Image.open(src).convert('RGB')
    s = s.resize((w, int(w * 1688 / 780)), Image.LANCZOS)
    r = 26
    frame = Image.new('RGB', (w + 12, s.height + 12), (10, 11, 13))
    mask = Image.new('L', frame.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, frame.width - 1, frame.height - 1), radius=r + 6, fill=255)
    inner = Image.new('L', s.size, 0)
    ImageDraw.Draw(inner).rounded_rectangle((0, 0, s.width - 1, s.height - 1), radius=r, fill=255)
    frame.paste(s, (6, 6), inner)
    return frame, mask

# Left: text
x0 = 72
d.text((x0, 64), 'CONVOY', font=font(22), fill=(139, 146, 157), spacing=4)
title = font(64)
d.text((x0, 120), 'The passenger', font=title, fill=(221, 225, 231))
d.text((x0, 194), 'runs the map.', font=title, fill=(221, 225, 231))
body = font(24, bold=False)
lines = ['Live riders around you, convoys with chat and', 'walkie-talkie, routes with an ETA, and a radar HUD.', 'The driver drives.']
y = 300
for ln in lines:
    d.text((x0, y), ln, font=body, fill=(139, 146, 157)); y += 34
# CTA pill
d.rectangle((x0, 440, x0 + 300, 440 + 56), fill=(47, 109, 246))
d.text((x0 + 26, 454), 'Download for Android', font=font(21), fill=(255, 255, 255))
d.text((x0, 560), 'odoreeci.tech', font=font(18, bold=False), fill=(139, 146, 157))

# Right: two phones
p1, m1 = phone(f'{SRC}/10-map-riders.png', 250)
p2, m2 = phone(f'{SRC}/12-convoy.png', 200)
im.paste(p2, (960, 120), m2)
im.paste(p1, (720, 60), m1)
im.save(OUT, optimize=True)
print(OUT, os.path.getsize(OUT) // 1024, 'KB')
