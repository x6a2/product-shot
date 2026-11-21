# -*- coding: utf-8 -*-
"""预乘 alpha 放大 2x + 边缘安全锐化。

用法:
    python upscale.py --src product_rgba.png --out product_2x.png [--scale 2]
"""
import argparse
import numpy as np
from PIL import Image, ImageFilter


def upscale(src_path, out_path, scale=2):
    im = Image.open(src_path).convert("RGBA")
    W, H = im.size
    NW, NH = int(W * scale), int(H * scale)
    arr = np.asarray(im).astype(np.float32) / 255.0
    rgb = arr[..., :3]          # (H, W, 3)
    al = arr[..., 3]            # (H, W)

    # 预乘：先乘 alpha 再放大，避免半透明边缘暗边
    pm = rgb * al[..., None]
    pm_up = np.asarray(Image.fromarray((pm * 255).astype(np.uint8), "RGB")
                       .resize((NW, NH), Image.LANCZOS)).astype(np.float32) / 255.0
    # alpha 单独放大 + 轻微模糊
    a_up = np.asarray(Image.fromarray((al * 255).astype(np.uint8), "L")
                      .resize((NW, NH), Image.LANCZOS)
                      .filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32) / 255.0
    # 反预乘
    rgb_up = pm_up / np.maximum(a_up[..., None], 1e-3)
    # 只锐化不透明区（避开软边带）
    mask = np.clip((a_up[..., None] - 0.80) / 0.18, 0, 1)
    sharp = np.asarray(Image.fromarray((np.clip(rgb_up, 0, 1) * 255).astype(np.uint8), "RGB")
                       .filter(ImageFilter.UnsharpMask(radius=1.15, percent=110, threshold=2))
                       ).astype(np.float32) / 255.0
    rgb_final = rgb_up * (1 - mask) + sharp * mask
    out = np.dstack([np.clip(rgb_final, 0, 1), a_up]) * 255.0
    Image.fromarray(out.astype(np.uint8), "RGBA").save(out_path)
    return {"in": [W, H], "out": [NW, NH]}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=float, default=2)
    a = ap.parse_args()
    print("upscale ok", upscale(a.src, a.out, a.scale))
