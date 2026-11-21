# -*- coding: utf-8 -*-
"""素材预检：在生成前拒绝不合格源图，输出 JSON 报告。

用法:
    python preflight.py --src <产品图>
退出码: 0=通过, 1=拒绝(打印原因)
"""
import argparse
import json
import sys
import numpy as np
from PIL import Image


def preflight(src_path):
    im = Image.open(src_path).convert("RGB")
    W, H = im.size
    arr = np.asarray(im).astype(np.float32)
    errs, warns = [], []

    if W < 800 or H < 800:
        errs.append(f"分辨率 {W}x{H} < 800，过小无法保证丝印清晰，请提供更高清的原图")
    elif W < 1200 or H < 1200:
        warns.append(f"分辨率 {W}x{H} < 1200，放大后文字清晰度会略降，建议尽量提供 ≥1200px 原图")

    # 贴边检查：产品 bbox 不应贴到画布边缘
    d = 255.0 - arr.min(axis=2)
    fg = d >= 7
    if fg.sum() == 0:
        errs.append("未检测到产品前景（可能不是白底图）")
    else:
        ys, xs = np.where(fg)
        bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
        pad = 6
        if bbox[0] <= pad or bbox[1] <= pad or bbox[2] >= W - 1 - pad or bbox[3] >= H - 1 - pad:
            errs.append(f"产品贴边（bbox={bbox}，需四周留白）")

    # 白底检查：四角应接近纯白
    corners = np.array([arr[5, 5], arr[5, W - 6], arr[H - 6, 5], arr[H - 6, W - 6]])
    if corners.min() < 235:
        warns.append(f"四角非纯白（min={corners.min():.0f}），可能是带底色/渐变的图，抠图质量会下降")

    # 原投影检查：背景里是否有明显非白阴影块
    bg = ~fg
    if bg.sum() > 0:
        bg_mean = arr[bg].mean()
        if bg_mean < 220:
            warns.append(f"背景平均亮度 {bg_mean:.0f} < 220，疑似带原投影/阴影，需留意")

    report = {"src": src_path, "size": [W, H], "bbox": None,
              "errors": errs, "warnings": warns}
    if "bbox" in locals():
        report["bbox"] = bbox
    print(json.dumps(report, ensure_ascii=True))
    return 1 if errs else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    a = ap.parse_args()
    sys.exit(preflight(a.src))
