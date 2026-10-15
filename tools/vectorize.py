"""コマ絵（背景を抜いた PNG）を、色ごとの SVG パス（横方向の連続画素をまとめた矩形）に変換する。
画像要素を使えない画面向け。使い方: python3 -I vectorize.py <入力png> <出力.paths> [高さpx] [色数]"""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
height = int(sys.argv[3]) if len(sys.argv) > 3 else 56
colors = int(sys.argv[4]) if len(sys.argv) > 4 else 24

img = Image.open(src).convert('RGBA')
img = img.resize((max(1, round(img.width * height / img.height)), height), Image.LANCZOS)
alpha = img.getchannel('A')
q = img.convert('RGB').quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
pal = q.getpalette()
w, h = img.size
runs = {}
for y in range(h):
    x = 0
    while x < w:
        if alpha.getpixel((x, y)) < 128:
            x += 1
            continue
        c = q.getpixel((x, y))
        x0 = x
        while x < w and alpha.getpixel((x, y)) >= 128 and q.getpixel((x, y)) == c:
            x += 1
        runs.setdefault(c, []).append(f'M{x0} {y}h{x - x0}v1h-{x - x0}z')
parts = []
for c, rs in runs.items():
    r, g, b = pal[c * 3:c * 3 + 3]
    parts.append(f'<path fill="#{r:02x}{g:02x}{b:02x}" d="{"".join(rs)}"/>')
open(dst, 'w').write(f'{w} {h}\n' + ''.join(parts))
print(dst, (w, h), sum(len(p) for p in parts), 'chars')
