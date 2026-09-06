#!/opt/hermes/.venv/bin/python3
"""Turn the captured phone shots into landing-page assets (WebP, exact sizes)."""
from PIL import Image, features
import os
SRC = '/opt/data/convoy/scripts/landing-shots/out'
DST = '/opt/data/convoy/landing/img'
os.makedirs(DST, exist_ok=True)
assert features.check('webp'), 'PIL lacks webp'

def save(im, name, q=82):
    p = os.path.join(DST, name)
    im.save(p, 'WEBP', quality=q, method=6)
    print(name, im.size, os.path.getsize(p) // 1024, 'KB')

full = {
    'map-riders': '10-map-riders.png',
    'nearby': '11-nearby.png',
    'convoy': '12-convoy.png',
    'convoy-map': '13-convoy-map.png',
    'radar': '14-radar.png',
    'garage': '16-garage.png',
    'route': '17-route.png',
    'trip': '18-trip.png',
    'globe': '02-map.png',
    'signin': '00-login.png',
}
for key, f in full.items():
    im = Image.open(os.path.join(SRC, f)).convert('RGB')
    save(im, key + '.webp')

# Landscape crop of the garage car card for the wide bento tile (source is 780x1688 @2x).
g = Image.open(os.path.join(SRC, '16-garage.png')).convert('RGB')
card = g.crop((40, 690, 740, 1000))  # the "2022 Alfa Romeo Giulietta / Velocity Blue / chips" card
save(card, 'garage-card.webp', q=86)

# Square-ish crop of the radar HUD instruments (bottom-left cards + bar) for an OG/inline detail.
r = Image.open(os.path.join(SRC, '14-radar.png')).convert('RGB')
save(r.crop((0, 1130, 780, 1688)), 'radar-detail.webp', q=84)
