#!/usr/bin/env python3
"""Build data/items.json (and optionally icons/) from a gtnh-craft-monitor-data release.

Usage:
  python3 build/build_data.py --tag gtnh-data-2.9.0
  python3 build/build_data.py --tag gtnh-data-2.9.0 --images images.zip
  python3 build/build_data.py --src ./downloaded-json --images images.zip

Only items that have at least one ore dictionary name are kept, since nothing else
can be matched by an oredict card. Icons are copied from the zip; a .webp next to
the .png path is preferred when the zip has one. Large animated icons (some are
160 px, 400 frames) are re-encoded at 32 px and half the frame rate when Pillow is
installed; pass --no-shrink to copy them as they are.
"""
import argparse
import io
import json
import os
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor
import urllib.request
import zipfile

REPO = "Maselkov/gtnh-craft-monitor-data"
ASSETS = ["ore_dict.json", "icons_lookup.json", "item_info.json", "data.json"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHRINK_OVER = 20_000  # bytes; smaller icons are left alone
SHRINK_SIZE = 32      # px, the size the page shows icons at
SHRINK_STEP = 2       # keep every 2nd frame, doubling its duration


def frame_durations(raw):
    """Per-frame durations (ms) from the WebP ANMF chunks; Pillow drops some of them."""
    out, i = [], 12
    while i + 8 <= len(raw):
        cid, size = raw[i:i + 4], int.from_bytes(raw[i + 4:i + 8], "little")
        if cid == b"ANMF":
            out.append(int.from_bytes(raw[i + 20:i + 23], "little"))
        i += 8 + size + (size & 1)
    return out


def shrink(raw):
    """Downscale an animated WebP and drop every other frame. Returns the smaller bytes."""
    from PIL import Image
    im = Image.open(io.BytesIO(raw))
    n = getattr(im, "n_frames", 1)
    if n < 2 and im.width <= SHRINK_SIZE:
        return raw
    src_durs = frame_durations(raw)
    if len(src_durs) != n:
        src_durs = [50] * n
    frames, durs = [], []
    for i in range(0, n, SHRINK_STEP):
        im.seek(i)
        f = im.convert("RGBA")
        if f.width > SHRINK_SIZE:
            # source icons are pixel art at whole multiples of 16 px, so nearest stays crisp
            f = f.resize((SHRINK_SIZE, SHRINK_SIZE * f.height // f.width), Image.NEAREST)
        frames.append(f)
        # each kept frame lasts as long as the frames it replaces
        durs.append(sum(src_durs[i:i + SHRINK_STEP]))
    buf = io.BytesIO()
    frames[0].save(buf, "WEBP", save_all=len(frames) > 1, append_images=frames[1:], duration=durs,
                   loop=0, lossless=True, quality=100, method=6)
    out = buf.getvalue()
    return out if len(out) < len(raw) else raw


def write_icon(job):
    dest, raw, do_shrink = job
    if do_shrink and len(raw) > SHRINK_OVER:
        raw = shrink(raw)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(raw)
    return len(raw)


def load_assets(args):
    out = {}
    for name in ASSETS:
        if args.src:
            with open(os.path.join(args.src, name), encoding="utf-8") as f:
                out[name] = json.load(f)
        else:
            url = f"https://github.com/{REPO}/releases/download/{args.tag}/{name}"
            print("fetching", url, file=sys.stderr)
            with urllib.request.urlopen(url) as r:
                out[name] = json.load(r)
    return out


def pick_labels(lookup):
    """key -> label. by_label maps label -> icon path, so invert it through the key's icon;
    by_key_label fills in keys whose icon is shared or missing."""
    by_key = lookup["by_key"]
    path_label = {}
    for label, path in lookup["by_label"].items():
        path_label.setdefault(path, label)
    labels = {k: path_label[p] for k, p in by_key.items() if p in path_label}
    for kl, path in lookup["by_key_label"].items():
        key, _, label = kl.partition("|")
        if key not in labels or path == by_key.get(key):
            labels[key] = label
    return labels


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", help="release tag, e.g. gtnh-data-2.9.0")
    ap.add_argument("--src", help="folder with already-downloaded JSON assets")
    ap.add_argument("--images", help="images zip to extract icons from")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "items.json"))
    ap.add_argument("--icons-out", default=os.path.join(ROOT, "icons"))
    ap.add_argument("--no-shrink", action="store_true", help="copy animated icons unchanged")
    args = ap.parse_args()
    if not args.tag and not args.src:
        ap.error("pass --tag or --src")

    a = load_assets(args)
    ore_dict, lookup, info, meta = a["ore_dict.json"], a["icons_lookup.json"], a["item_info.json"], a["data.json"]

    names = sorted(ore_dict)
    name_idx = {n: i for i, n in enumerate(names)}
    item_names = {}
    for n, keys in ore_dict.items():
        for k in keys:
            item_names.setdefault(k, []).append(name_idx[n])

    labels = pick_labels(lookup)
    by_key = lookup["by_key"]

    zf = zipfile.ZipFile(args.images) if args.images else None
    zip_names = set(zf.namelist()) if zf else set()

    def icon_for(key):
        path = by_key.get(key)
        if not path:
            return None
        if zf is None:
            return path
        cands = (path[:-4] + ".webp", path) if path.endswith(".png") else (path,)
        for cand in cands:
            if cand in zip_names:
                return cand
        return None

    items = []
    icons = []
    for key in sorted(item_names):
        icon = icon_for(key)
        if icon:
            icons.append(icon)
        items.append([key, labels.get(key, key), sorted(item_names[key]), icon or 0])

    if zf:
        do_shrink = not args.no_shrink
        if do_shrink:
            try:
                import PIL  # noqa: F401
            except ImportError:
                print("Pillow not installed; copying icons without shrinking", file=sys.stderr)
                do_shrink = False
        shutil.rmtree(args.icons_out, ignore_errors=True)
        jobs = ((os.path.join(args.icons_out, p), zf.read(p), do_shrink) for p in icons)
        with ProcessPoolExecutor() as pool:
            total = sum(pool.map(write_icon, jobs, chunksize=64))
        print(f"icons: {total / 1e6:.1f} MB", file=sys.stderr)

    mods = sorted({k.split(":", 1)[0] for k in item_names})
    out = {
        "format": 1,
        "gtnh_version": meta.get("gtnh_version"),
        "source": args.tag or meta.get("generated_at"),
        "names": names,
        "mods": {m: info.get("mods", {}).get(m, m) for m in mods},
        "items": items,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(items)} items, {len(names)} ore names, {len(icons)} icons -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
