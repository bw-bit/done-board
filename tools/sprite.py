"""生成したコマ絵のマゼンタ背景を透明にし、余白を切って小さな PNG にする。
使い方: python3 -I sprite.py <入力png> <出力png> [高さpx]"""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
height = int(sys.argv[3]) if len(sys.argv) > 3 else 96

img = Image.open(src).convert('RGBA')
px = img.load()
w, h = img.size
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        # マゼンタらしさ: 赤と青が強く、緑が弱い
        mag = min(r, b) - g
        if mag > 120:
            px[x, y] = (0, 0, 0, 0)
        elif mag > 50:
            # 縁は半透明にし、マゼンタのにじみを抜く
            alpha = int(255 * (120 - mag) / 70)
            ng = g
            px[x, y] = (min(r, ng + 40), ng, min(b, ng + 40), alpha)
bbox = img.getbbox()
if bbox is None:
    sys.exit('empty sprite')
img = img.crop(bbox)
scale = height / img.height
img = img.resize((max(1, round(img.width * scale)), height), Image.LANCZOS)
# 色数を 128 に減らして軽くする（透明度は保つ）
img = img.quantize(colors=128, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
img.save(dst, optimize=True)
print(dst, img.size)
