#!/usr/bin/env python3
"""Enhance Stream Deck game icons: blurred art backdrop + crisp centered app icon."""
import argparse
import json
import os
import sys

from PIL import Image, ImageFilter, ImageEnhance, ImageOps

CANVAS = 144
ICON_DRAW = 112


def dominant_color(im):
    small = ImageOps.fit(im, (1, 1))
    return small.getpixel((0, 0))[:3]


def build_background(art_path, icon_im):
    if art_path and os.path.exists(art_path):
        try:
            bg = Image.open(art_path).convert("RGB")
        except Exception:
            bg = None
        if bg is not None:
            bg = ImageOps.fit(bg, (CANVAS, CANVAS), method=Image.Resampling.LANCZOS)
            return ImageEnhance.Brightness(bg.filter(ImageFilter.GaussianBlur(14))).enhance(0.45)
    r, g, b = dominant_color(icon_im)
    return Image.new("RGB", (CANVAS, CANVAS), (max(int(r * 0.28), 0), max(int(g * 0.28), 0), max(int(b * 0.28), 0)))


def build_icon(icon_path):
    im = Image.open(icon_path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
    else:
        im = im.convert("RGB")
    target = ImageOps.contain(im, (ICON_DRAW, ICON_DRAW), method=Image.Resampling.LANCZOS)
    if target.size != (ICON_DRAW, ICON_DRAW):
        canvas = Image.new("RGBA" if im.mode == "RGBA" else "RGB", (ICON_DRAW, ICON_DRAW))
        canvas.paste(target, ((ICON_DRAW - target.size[0]) // 2, (ICON_DRAW - target.size[1]) // 2))
        target = canvas
    return target.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--infile", required=True)
    parser.add_argument("--outdir", required=True)
    args = parser.parse_args()

    with open(args.infile, "r", encoding="utf-8") as fh:
        raw = fh.read().strip()
    try:
        jobs = json.loads(raw).get("jobs", [])
    except ValueError:
        jobs = []
        for ln in raw.splitlines():
            if not ln.strip():
                continue
            parts = ln.split("\t")
            if len(parts) >= 2:
                jobs.append({"appid": int(parts[0]), "icon": parts[1], "art": (parts[2] if len(parts) > 2 and parts[2] else None)})

    os.makedirs(args.outdir, exist_ok=True)
    done = []
    for job in jobs:
        appid = str(job["appid"])
        out = os.path.join(args.outdir, f"{appid}.png")
        try:
            icon = build_icon(job["icon"])
            bg = build_background(job.get("art"), icon)
            if icon.mode == "RGBA":
                bg = bg.convert("RGBA")
            result = bg.copy()
            result.paste(icon, ((CANVAS - icon.width) // 2, (CANVAS - icon.height) // 2), icon if icon.mode == "RGBA" else None)
            result.save(out, "PNG")
            done.append(appid)
        except Exception as exc:
            sys.stderr.write(f"enhance {appid}: {exc}\n")

    print(json.dumps({"done": done}))


if __name__ == "__main__":
    main()