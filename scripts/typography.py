# -*- coding: utf-8 -*-
"""第二遍清晰度修复（整图锐化）+ 类样品图排版。文字全部由 Pillow 真实渲染。

用法:
    python typography.py --src 合成图.png --out 成品.png --palette dark --mode poster
mode=hero 只锐化不排字（产品占满、无文字，类样品图）；mode=poster 锐化 + 左栏文案。
"""
import argparse
import json
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_layouts():
    with open(os.path.join(ROOT, "references", "layouts.json"), encoding="utf-8") as f:
        return json.load(f)


def sp_text(d, xy, text, font, fill, spacing=0):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += font.getlength(ch) + spacing
    return x


def sharpen(im, cfg):
    return im.filter(ImageFilter.UnsharpMask(**cfg))


def layout(im, pal, copy, fonts):
    d = ImageDraw.Draw(im)
    # JSON 里颜色是 list，PIL 需要 tuple
    p = {k: (tuple(v) if isinstance(v, list) else v) for k, v in pal.items()}
    X = 118
    f_eye = ImageFont.truetype(fonts["regular"], 33)
    f_title = ImageFont.truetype(fonts["bold"], 196)
    f_sub = ImageFont.truetype(fonts["bold"], 56)
    f_adapt = ImageFont.truetype(fonts["regular"], 40)
    f_badge = ImageFont.truetype(fonts["bold"], 33)

    y = 402
    sp_text(d, (X, y), copy["eyebrow"], f_eye, p["dim"], spacing=11)
    y += 66

    d.text((X - 4, y), copy["title"], font=f_title, fill=p["fg"])
    y2 = y + 196 * 1.16 + 14
    d.rectangle([X, y2, X + 92, y2 + 6], fill=p["accent"])

    y = y2 + 44
    d.text((X, y), copy["sub"], font=f_sub, fill=p["sub"])

    y += 104
    d.line([X, y, X + 470, y], fill=p["rule"], width=2)

    y += 44
    for line in copy["adapt"]:
        d.text((X, y), line, font=f_adapt, fill=p["sub"])
        y += 58

    # 底部红底白字徽章（匹配已验收样片）
    by = 1246
    label = copy["badge"]
    bw = f_badge.getlength(label) + 60
    d.rounded_rectangle([X, by, X + bw, by + 68], radius=3, fill=(206, 46, 34))
    d.text((X + 30, by + 13), label, font=f_badge, fill=(255, 255, 255))
    return im


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--palette", choices=["dark", "light", "stone"], required=True)
    ap.add_argument("--mode", choices=["hero", "poster"], required=True)
    a = ap.parse_args()

    L = load_layouts()
    im = sharpen(Image.open(a.src).convert("RGB"), L["sharpen"])
    if a.mode == "poster":
        im = layout(im, L["palettes"][a.palette], L["copy"], L["fonts"])
    im.save(a.out)
    print("saved", a.out)
