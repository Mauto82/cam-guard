# /// script
# requires-python = ">=3.10"
# dependencies = ["nudenet==3.4.2"]
# ///
"""Parity check: upstream NudeNet (Python) vs @cam-guard/detector-nudenet (Node).

Runs both on the same images and compares label, score and box. Python lives
only here, in tools/: the library itself never needs it.

    pnpm build
    uv run tools/verify_nudenet.py path/to/image.jpg [...]

Exit code 0 when every upstream detection has a match (same label, score
within --score-tol, box IoU >= --iou-min) and there are no extra ones.

Compared in BGR mode: upstream NudeNet 3.4.2 feeds the model BGR (a double
channel swap in its OpenCV preprocessing), while cam-guard defaults to RGB,
which is what the ultralytics-trained model expects. Same boxes, higher
scores in RGB — so parity is only meaningful with `--channels bgr`.

Even in BGR mode scores differ by a few hundredths: upstream downscales with
cv2 INTER_LINEAR (no antialiasing), cam-guard with sharp's antialiased linear
kernel — closer to ultralytics' own validation, which uses INTER_AREA when
shrinking. Hence the default --score-tol of 0.06; boxes must still overlap.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from nudenet import NudeDetector

ROOT = Path(__file__).resolve().parent.parent


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def ours(images):
    out = subprocess.run(
        ["node", str(ROOT / "apps/bot/dist/cli.js"), "detect", "--json", "--runs", "0", "--channels", "bgr", *images],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(out.stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--score-tol", type=float, default=0.06)
    ap.add_argument("--iou-min", type=float, default=0.85)
    args = ap.parse_args()

    upstream = NudeDetector()  # 320n, bundled in the wheel
    reports = ours(args.images)
    failures = 0

    for image, report in zip(args.images, reports):
        w, h = report["width"], report["height"]
        theirs = upstream.detect(image)
        mine = [
            {
                "class": d["label"],
                "score": d["score"],
                "box": [d["box"]["x"] * w, d["box"]["y"] * h, d["box"]["w"] * w, d["box"]["h"] * h],
            }
            for d in report["detections"]
        ]
        print(f"\n{image}  ({w}x{h})  upstream={len(theirs)}  cam-guard={len(mine)}")
        unmatched = list(mine)
        for t in sorted(theirs, key=lambda d: -d["score"]):
            best = max(
                (m for m in unmatched if m["class"] == t["class"]),
                key=lambda m: iou(m["box"], t["box"]),
                default=None,
            )
            ok = (
                best is not None
                and abs(best["score"] - t["score"]) <= args.score_tol
                and iou(best["box"], t["box"]) >= args.iou_min
            )
            if best is not None:
                unmatched.remove(best)
            detail = (
                f"score {t['score']:.3f}/{best['score']:.3f}  iou {iou(best['box'], t['box']):.3f}"
                if best
                else "missing in cam-guard"
            )
            print(f"  {'ok ' if ok else 'BAD'} {t['class']:<26} {detail}")
            failures += 0 if ok else 1
        for m in unmatched:
            # A box right at the threshold can land on either side of it.
            borderline = m["score"] < 0.25 + args.score_tol
            print(f"  {'~  ' if borderline else 'BAD'} {m['class']:<26} extra in cam-guard, score {m['score']:.3f}")
            failures += 0 if borderline else 1

    print(f"\n{'PASS' if failures == 0 else f'FAIL ({failures})'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
