# Resize + WebP-encode the textures dumped by `node tools/optimize.mjs dump`.
import json, os, sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
WORK = sys.argv[1] if len(sys.argv) > 1 else "work"
OUT = os.path.join(WORK, "tex_out")
os.makedirs(OUT, exist_ok=True)
items = json.load(open(os.path.join(WORK, "tex.json"), encoding="utf-8"))
before = after = 0
for e in items:
    src = e["file"]; dst = os.path.join(OUT, "%d.webp" % e["i"])
    im = Image.open(src)
    before += os.path.getsize(src)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if ("A" in im.getbands() or im.mode == "P") else "RGB")
    if im.mode == "RGBA" and im.getchannel("A").getextrema() == (255, 255):
        im = im.convert("RGB")
    m = e["max"]
    if max(im.size) > m:
        im.thumbnail((m, m), Image.LANCZOS)
    im.save(dst, "WEBP", quality=88 if m > 1024 else 85, method=6)
    after += os.path.getsize(dst)
print("textures", len(items), "MB", round(before / 1e6), "->", round(after / 1e6))
