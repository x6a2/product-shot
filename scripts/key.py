# -*- coding: utf-8 -*-
"""白底产品抠图：距离白场 + 中心连通域 + 补洞 + 腐蚀去白边 + 反预乘。

用法:
    python key.py --src <产品图> --out <product_rgba.png> [--threshold 7]
"""
import argparse
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def key(src_path, out_path, threshold=7, feather=0.7):
    im = Image.open(src_path).convert("RGB")
    arr = np.asarray(im).astype(np.float32)
    H, W = arr.shape[:2]

    d = 255.0 - arr.min(axis=2)
    mask = (d >= threshold).astype(np.uint8) * 255
    mi = Image.fromarray(mask)

    # 产品中心作为种子（产品通常居中）
    ff = mi.copy()
    ImageDraw.floodfill(ff, (W // 2, H // 2), 128, thresh=0)
    comp = (np.asarray(ff) == 128)

    # 补内部高光洞
    inv = Image.fromarray(((~comp) * 255).astype(np.uint8))
    ff2 = inv.copy()
    ImageDraw.floodfill(ff2, (0, 0), 64, thresh=0)
    holes = (np.asarray(ff2) == 255)
    m_final = comp | holes

    # 腐蚀 1px 去白边
    m_final = np.asarray(Image.fromarray((m_final * 255).astype(np.uint8))
                         .filter(ImageFilter.MinFilter(3))) > 127
    alpha = Image.fromarray((m_final * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(feather))
    al = np.asarray(alpha).astype(np.float32) / 255.0
    a3 = al[..., None]
    # 反预乘：把边缘白晕按 alpha 去除
    un = np.clip((arr - (1 - a3) * 255.0) / np.maximum(a3, 0.02), 0, 255)
    rgba = Image.fromarray(np.dstack([un, al[..., None] * 255]).astype(np.uint8), "RGBA")

    ys, xs = np.where(m_final)
    bbox = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    crop = rgba.crop(bbox)
    crop.save(out_path)
    return {"bbox": list(bbox), "size": list(crop.size),
            "edge_soft_ratio": float(((al > 0) & (al < 0.99)).mean())}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threshold", type=int, default=7)
    a = ap.parse_args()
    r = key(a.src, a.out, a.threshold)
    print(json if False else "key ok", r)
