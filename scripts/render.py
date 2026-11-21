# -*- coding: utf-8 -*-
"""product-shot 统一合成器：把白底产品图贴到预置场景上，支持 5 种角度族。

用法（相对本脚本所在 bundle 根目录解析 assets/references）:
    python render.py --product <rgba.png> --scene E --angle vertical --out out.png
    python render.py --product <rgba.png> --scene J --angle lie --out out.png

参数全部来自 references/scenes.json（场景+合成参数）、angles.json（角度目录）。
"""
import argparse
import json
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENES_DIR = os.path.join(ROOT, "assets", "scenes")
REF_DIR = os.path.join(ROOT, "references")
W = H = 1600


# ---------------- shared helpers ----------------
def coeffs_for(dst_quad, src_quad):
    A, B = [], []
    for (x, y), (u, v) in zip(dst_quad, src_quad):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    return np.linalg.solve(np.array(A, dtype=np.float64), np.array(B, dtype=np.float64))


def relight(img, direction=(1.0, -0.3), amount=0.03, temp=0.0, lift=1.0):
    arr = np.asarray(img).astype(np.float32)
    rgb, al = arr[..., :3], arr[..., 3:]
    h, w = rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = xx / w - 0.5, yy / h - 0.5
    g = 1.0 + amount * 2.0 * (nx * direction[0] + ny * direction[1])
    rgb = rgb * g[..., None] * lift
    if temp:
        rgb = rgb * np.array([1.0 + temp, 1.0, 1.0 - temp], dtype=np.float32)
    return Image.fromarray(np.dstack([np.clip(rgb, 0, 255), al]).astype(np.uint8), "RGBA")


def ground_window(top, bottom, feather=40):
    y = np.arange(H, dtype=np.float32)
    up = np.clip((y - (top - feather)) / feather, 0, 1)
    dn = np.clip(((bottom + feather) - y) / feather, 0, 1)
    return np.clip(np.minimum(up, dn), 0, 1)


# ---------------- vertical（竖放，正面） ----------------
def compose_vertical(bg_path, prod, c):
    cx = c.get("product_cx") or c["cx"]
    scale = c.get("scale", 1.0)
    p = prod if scale == 1.0 else prod.resize(
        (int(prod.width * scale), int(prod.height * scale)), Image.LANCZOS)
    if c.get("relight"):
        p = relight(p, **c["relight"])
    PW, PH = p.size
    pa = p.split()[-1]
    base_y = c["base_y"]
    x0 = int(cx - PW / 2); y0 = int(base_y - PH)

    bg = Image.open(bg_path).convert("RGB").resize((W, H), Image.LANCZOS).convert("RGBA")
    win = ground_window(*c["ground"])

    if c.get("refl_op", 0) > 0:
        ref = p.transpose(Image.FLIP_TOP_BOTTOM)
        gh = min(c.get("refl_h", 150), PH)
        ref = ref.crop((0, 0, PW, gh))
        t = np.linspace(0.0, 1.0, gh)[:, None]
        ga = np.clip(1.0 - t, 0, 1) ** 2.4
        ra = np.asarray(ref.split()[-1]).astype(np.float32) * ga * c["refl_op"]
        ref.putalpha(Image.fromarray(ra.astype(np.uint8)))
        ref = ref.filter(ImageFilter.GaussianBlur(c.get("refl_blur", 5)))
        tmp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        tmp.alpha_composite(ref, (x0, base_y - 3))
        ta = np.asarray(tmp.split()[-1]).astype(np.float32) * win[:, None]
        tmp.putalpha(Image.fromarray(ta.astype(np.uint8)))
        bg.alpha_composite(tmp)

    body = pa.resize((PW, max(10, c["shadow_len"])), Image.LANCZOS)
    sh = Image.new("L", (W, H), 0)
    sh.paste(body, (x0, base_y - c["shadow_len"] + int(c["shadow_len"] * 0.15)))
    sh = sh.transform((W, H), Image.AFFINE, (1, 0.55, -0.55 * base_y, 0, 1, 0),
                      resample=Image.BICUBIC).filter(ImageFilter.GaussianBlur(c["shadow_blur"]))
    sa = np.asarray(sh).astype(np.float32) * c["shadow_op"] * win[:, None]
    lay = Image.new("RGBA", (W, H), tuple(c["shadow_rgb"]) + (255,))
    lay.putalpha(Image.fromarray(sa.astype(np.uint8)))
    bg.alpha_composite(lay)

    cw, ch, cblur, cstr = c["contact"]
    cc = Image.new("L", (W, H), 0)
    ImageDraw.Draw(cc).ellipse([cx - cw / 2, base_y - ch * 0.55,
                                cx + cw / 2, base_y + ch * 0.45], fill=255)
    cc = cc.filter(ImageFilter.GaussianBlur(cblur))
    ca = np.asarray(cc).astype(np.float32) * cstr * win[:, None]
    cimg = Image.new("RGBA", (W, H), tuple(c["shadow_rgb"]) + (255,))
    cimg.putalpha(Image.fromarray(ca.astype(np.uint8)))
    bg.alpha_composite(cimg)

    bg.alpha_composite(p, (x0, y0))
    return bg.convert("RGB")


# ---------------- flat / diag（横放·斜放，俯视台面） ----------------
def lay_down(prod, squash=0.72, persp=0.022, angle=0.0):
    rot = prod.rotate(-90, expand=True)
    rw, rh = rot.size
    oh = rh * squash
    sw = rw * persp
    ow = rw + 2 * sw
    src = [(0, 0), (rw, 0), (rw, rh), (0, rh)]
    dst = [(sw, 0), (rw + sw, 0), (rw + 2 * sw, oh), (0, oh)]
    warped = rot.transform((int(ow), int(oh)), Image.PERSPECTIVE,
                           coeffs_for(dst, src), resample=Image.BICUBIC)
    if angle:
        warped = warped.rotate(angle, expand=True, resample=Image.BICUBIC)
    return warped


def compose_flat(bg_path, prod, c):
    p = lay_down(prod, squash=c["squash"], angle=c["angle"])
    if c.get("scale", 1.0) != 1.0:
        p = p.resize((int(p.width * c["scale"]), int(p.height * c["scale"])), Image.LANCZOS)
    if c.get("relight"):
        p = relight(p, **c["relight"])

    canvas = Image.open(bg_path).convert("RGB").resize((W, H), Image.LANCZOS).convert("RGBA")
    PW, PH = p.size
    cx, cy = c["center"]
    x0 = int(cx - PW / 2); y0 = int(cy - PH / 2)
    pa = p.split()[-1]

    shw, shh = int(PW * 1.0), max(20, int(PH * 0.86))
    body = pa.resize((shw, shh), Image.LANCZOS)
    sl = Image.new("L", (W, H), 0)
    sl.paste(body, (x0 + c["shadow"][0], y0 + c["shadow"][1]))
    sl = sl.filter(ImageFilter.GaussianBlur(c["shadow_blur"]))
    sa = np.asarray(sl).astype(np.float32) * c["shadow_op"]
    lay = Image.new("RGBA", (W, H), tuple(c["shadow_rgb"]) + (255,))
    lay.putalpha(Image.fromarray(sa.astype(np.uint8)))
    canvas.alpha_composite(lay)

    cl = Image.new("L", (W, H), 0)
    cl.paste(pa, (x0 + 6, y0 + 9))
    cl = cl.filter(ImageFilter.GaussianBlur(8))
    ca = np.asarray(cl).astype(np.float32) * 0.62
    clay = Image.new("RGBA", (W, H), tuple(c["shadow_rgb"]) + (255,))
    clay.putalpha(Image.fromarray(ca.astype(np.uint8)))
    canvas.alpha_composite(clay)

    canvas.alpha_composite(p, (x0, y0))
    return canvas.convert("RGB")


# ---------------- tilt（斜立，正面朝向镜头） ----------------
def lean(prod, tilt_back=0.055, narrow_top=0.045):
    pw, ph = prod.size
    oh = ph * (1 - tilt_back)
    sw = pw * narrow_top
    ow = pw + 2 * sw
    src = [(0, 0), (pw, 0), (pw, ph), (0, ph)]
    dst = [(sw, 0), (pw + sw, 0), (pw + 2 * sw, oh), (0, oh)]
    return prod.transform((int(ow), int(oh)), Image.PERSPECTIVE,
                          coeffs_for(dst, src), resample=Image.BICUBIC)


def compose_tilt(bg_path, prod, c):
    p = lean(prod, tilt_back=c["tilt_back"])
    p = p.rotate(c["angle"], expand=True, resample=Image.BICUBIC)
    if c.get("scale", 1.0) != 1.0:
        p = p.resize((int(p.width * c["scale"]), int(p.height * c["scale"])), Image.LANCZOS)
    if c.get("relight"):
        p = relight(p, **c["relight"])

    canvas = Image.open(bg_path).convert("RGB").resize((W, H), Image.LANCZOS).convert("RGBA")
    pw, ph = p.size
    cx, cy = c["center"]
    x0 = int(cx - pw / 2); y0 = int(cy - ph / 2)
    pa = p.split()[-1]

    sw, sh = int(pw * 1.15), max(18, int(ph * 0.30))
    body = pa.resize((sw, sh), Image.LANCZOS)
    sl = Image.new("L", (W, H), 0)
    sl.paste(body, (int(x0 + c["shadow"][0] - (sw - pw) / 2),
                    int(y0 + ph - sh * 0.55 + c["shadow"][1])))
    sl = sl.filter(ImageFilter.GaussianBlur(c["shadow_blur"]))
    sa = np.asarray(sl).astype(np.float32) * c["shadow_op"]
    if c.get("floor_y") is not None:
        fw = np.clip((np.arange(H, dtype=np.float32) - (c["floor_y"] - 40)) / 40.0, 0, 1)
        sa = sa * fw[:, None]
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    lay.putalpha(Image.fromarray(sa.astype(np.uint8)))
    canvas.alpha_composite(lay)

    if c.get("refl", 0) > 0:
        ref = p.transpose(Image.FLIP_TOP_BOTTOM)
        gh = int(ph * 0.45)
        ref = ref.crop((0, 0, pw, gh)).filter(ImageFilter.GaussianBlur(7))
        t = np.linspace(0, 1, gh)[:, None]
        ga = (np.clip(1 - t, 0, 1) ** 2.2) * c["refl"]
        ra = np.asarray(ref.split()[-1]).astype(np.float32) * ga
        ref.putalpha(Image.fromarray(ra.astype(np.uint8)))
        canvas.alpha_composite(ref, (x0, y0 + ph - 2))

    canvas.alpha_composite(p, (x0, y0))
    return canvas.convert("RGB")


# ---------------- lie（躺放，短轴压缩） ----------------
def keystone(img, k=0.035):
    w, h = img.size
    ins = w * k
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [(ins, 0), (w + ins, 0), (w + 2 * ins, h), (0, h)]
    return img.transform((int(w + 2 * ins), h), Image.PERSPECTIVE,
                         coeffs_for(dst, src), resample=Image.BICUBIC)


def compose_lie(bg_path, prod, c):
    rot = prod.rotate(90, expand=True)
    rw, rh = rot.size
    flat = rot.resize((rw, int(rh * c["squash"])), Image.LANCZOS)
    tilted = flat.rotate(c["tilt"], expand=True, resample=Image.BICUBIC)
    p = keystone(tilted, c["k"])
    s = c["target_long"] / p.width
    p = p.resize((int(p.width * s), int(p.height * s)), Image.LANCZOS)
    if c.get("relight"):
        p = relight(p, **c["relight"])

    bg = Image.open(bg_path).convert("RGB")
    if c.get("mirror"):
        bg = ImageOps.mirror(bg)
    canvas = bg.resize((W, H), Image.LANCZOS).convert("RGBA")
    pw, ph = p.size
    cx, cy = c["center"]
    x0 = int(cx - pw / 2); y0 = int(cy - ph / 2)
    pa = p.split()[-1]

    sl = Image.new("L", (W, H), 0)
    sl.paste(pa, (x0 + 28, y0 + 36))
    sl = sl.filter(ImageFilter.GaussianBlur(28))
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    lay.putalpha(Image.fromarray((np.asarray(sl).astype(np.float32) * 0.55).astype(np.uint8)))
    canvas.alpha_composite(lay)

    cl = Image.new("L", (W, H), 0)
    cl.paste(pa, (x0 + 6, y0 + 9))
    cl = cl.filter(ImageFilter.GaussianBlur(9))
    clay = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    clay.putalpha(Image.fromarray((np.asarray(cl).astype(np.float32) * 0.7).astype(np.uint8)))
    canvas.alpha_composite(clay)

    if c.get("refl", 0) > 0:
        ref = p.transpose(Image.FLIP_TOP_BOTTOM)
        gh = int(ph * 0.5)
        ref = ref.crop((0, 0, pw, gh)).filter(ImageFilter.GaussianBlur(5))
        t = np.linspace(0, 1, gh)[:, None]
        ga = (np.clip(1 - t, 0, 1) ** 1.15) * c["refl"]
        ra = np.asarray(ref.split()[-1]).astype(np.float32) * ga
        ref.putalpha(Image.fromarray(ra.astype(np.uint8)))
        canvas.alpha_composite(ref, (x0, y0 + ph - 10))

    canvas.alpha_composite(p, (x0, y0))
    return canvas.convert("RGB")


RENDERERS = {
    "vertical": compose_vertical,
    "flat": compose_flat,
    "tilt": compose_tilt,
    "lie": compose_lie,
}


def load_scene(scene_id):
    with open(os.path.join(REF_DIR, "scenes.json"), encoding="utf-8") as f:
        scenes = json.load(f)["scenes"]
    for s in scenes:
        if s["id"] == scene_id:
            return s
    raise KeyError(f"未知场景 {scene_id!r}，可用：{[s['id'] for s in scenes]}")


def render(scene_id, angle, product_path, layout=None, out_path=None):
    scene = load_scene(scene_id)
    # flat/diag 共用 flat 渲染器；diag 的几何参数已在 scenes.json 里单独列了
    key = "diag" if angle == "diag" else angle
    renderer = RENDERERS["flat" if angle == "diag" else angle]
    c = dict(scene[key])
    c["relight"] = scene.get("relight")
    if layout == "poster" and angle == "vertical":
        c["product_cx"] = 1078
        if "contact" in c:
            c["contact"] = [440, c["contact"][1], c["contact"][2], c["contact"][3]]
        if scene_id == "E":
            c["shadow_len"] = 84

    prod = Image.open(product_path).convert("RGBA")
    bg_path = os.path.join(SCENES_DIR, scene["bg"])
    im = renderer(bg_path, prod, c)
    if out_path:
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        im.save(out_path)
    return im


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--product", required=True, help="抠图+放大后的 RGBA 产品图（product_2x.png）")
    ap.add_argument("--scene", required=True, help="场景 id：E/F/G/H/I/J")
    ap.add_argument("--angle", required=True, choices=list(RENDERERS) + ["diag"],
                    help="角度族：vertical/flat/diag/tilt/lie")
    ap.add_argument("--layout", choices=["hero", "poster"], default="hero")
    ap.add_argument("--out", required=True, help="输出 PNG 路径")
    a = ap.parse_args()
    render(a.scene, a.angle, a.product, a.layout, a.out)
    print("saved", a.out)
