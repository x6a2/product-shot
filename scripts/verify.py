# -*- coding: utf-8 -*-
"""质量门：在交付前自动断言关键失败模式。

用法:
    python verify.py --matte product_2x.png --final 成品.png
检查:
  1) matte 软边占比（crisp 边缘，软边太多=白边残留风险）
  2) matte 透明区白晕（反预乘失败=透明区 RGB 接近白）
  3) final 尺寸=1600 且非空白
退出码: 0=通过, 1=失败(打印 JSON 报告)
"""
import argparse
import json
import sys
import numpy as np
from PIL import Image


def check_matte(path):
    im = Image.open(path).convert("RGBA")
    arr = np.asarray(im).astype(np.float32) / 255.0
    rgb, al = arr[..., :3], arr[..., 3]
    soft = float(((al > 0) & (al < 0.99)).mean())
    # 透明区（alpha≈0）不应残留白色 RGB（说明反预乘没生效）
    trans = al < 0.05
    halo = float(rgb[trans].mean()) if trans.sum() else 0.0
    return {"soft_ratio": round(soft, 4), "transparent_rgb_mean": round(halo, 3),
            "soft_ok": soft <= 0.05, "halo_ok": halo <= 0.15}


def check_final(path):
    im = Image.open(path).convert("RGB")
    arr = np.asarray(im).astype(np.float32)
    h, w = arr.shape[:2]
    ok_dims = (w == 1600 and h == 1600)
    std = float(arr.std())
    return {"size": [w, h], "std": round(std, 1),
            "dims_ok": ok_dims, "blank_ok": std > 5.0}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--matte", help="product_2x.png（放大后的 RGBA）")
    ap.add_argument("--final", help="成品 PNG")
    a = ap.parse_args()
    rep = {}
    if a.matte:
        rep["matte"] = check_matte(a.matte)
    if a.final:
        rep["final"] = check_final(a.final)
    print(json.dumps(rep, ensure_ascii=False))
    fails = []
    if "matte" in rep and not (rep["matte"]["soft_ok"] and rep["matte"]["halo_ok"]):
        fails.append("matte")
    if "final" in rep and not (rep["final"]["dims_ok"] and rep["final"]["blank_ok"]):
        fails.append("final")
    sys.exit(1 if fails else 0)
