"""Generate extension icons with red-pink gradient, book + download arrow."""
from PIL import Image, ImageDraw, ImageFont
import os

SIZES = [16, 48, 128]
SCALE = 4  # supersampling

def make_icon(size):
    s = size * SCALE
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded rect background (red-pink gradient approximation)
    r = s // 5
    for y in range(s):
        t = y / s
        red = int(233 + (194 - 233) * t)
        green = int(69 + (49 - 69) * t)
        blue = int(96 + (82 - 96) * t)
        draw.rectangle([0, y, s, y], fill=(red, green, blue, 255))

    # Round corners by masking
    mask = Image.new('L', (s, s), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=255)
    img.putalpha(mask)

    # Book icon (white)
    cx, cy = s // 2, s // 2 - s // 10
    bw = s * 35 // 100
    bh = s * 40 // 100
    lw = max(s // 20, 2)

    # Book left page
    draw.rectangle([cx - bw, cy - bh // 2, cx - lw // 2, cy + bh // 2], fill=(255, 255, 255, 230))
    # Book right page
    draw.rectangle([cx + lw // 2, cy - bh // 2, cx + bw, cy + bh // 2], fill=(255, 255, 255, 230))
    # Spine
    draw.rectangle([cx - lw, cy - bh // 2, cx + lw, cy + bh // 2], fill=(255, 255, 255, 180))

    # Download arrow below book
    ay = cy + bh // 2 + s // 8
    aw = s // 6
    ah = s // 8
    # Arrow stem
    draw.rectangle([cx - lw, cy + bh // 2 + s // 20, cx + lw, ay], fill=(255, 255, 255, 220))
    # Arrow head
    draw.polygon([
        (cx - aw, ay),
        (cx + aw, ay),
        (cx, ay + ah)
    ], fill=(255, 255, 255, 220))

    # Downsample with LANCZOS
    img = img.resize((size, size), Image.LANCZOS)
    return img

if __name__ == '__main__':
    out_dir = os.path.dirname(os.path.abspath(__file__))
    for sz in SIZES:
        icon = make_icon(sz)
        path = os.path.join(out_dir, f'icon{sz}.png')
        icon.save(path)
        print(f'Generated {path}')
