#!/opt/hermes/.venv/bin/python3
"""Contact sheet of captured shots so they can be reviewed in one image."""
from PIL import Image, ImageDraw
import glob, os
files = sorted(glob.glob('/opt/data/convoy/scripts/landing-shots/out/1*.png')) + sorted(glob.glob('/opt/data/convoy/scripts/landing-shots/out/0*.png'))
th = 520
tw = 240
cols = 6
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * (tw + 10) + 10, rows * (th + 30) + 10), (30, 30, 34))
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB')
    im.thumbnail((tw, th))
    x = 10 + (i % cols) * (tw + 10)
    y = 10 + (i // cols) * (th + 30)
    sheet.paste(im, (x, y))
    d.text((x, y + th + 4), os.path.basename(f), fill=(230, 230, 230))
sheet.save('/tmp/contact.png')
print('/tmp/contact.png', sheet.size, len(files))
