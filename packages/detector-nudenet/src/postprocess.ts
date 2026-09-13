import type { Detection } from "@cam-guard/core";

/** A box in ORIGINAL-image pixels, before normalisation. */
export interface Candidate {
  classId: number;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DecodeOptions {
  numClasses: number;
  inputSize: number;
  width: number;
  height: number;
  /** Anchors whose best class scores below this are discarded (upstream: 0.2). */
  candidateThreshold: number;
}

/**
 * Decode a YOLOv8 head: output shape [1, 4 + C, N], channel-major, where the
 * first four channels are box centre x, centre y, width, height in model-input
 * pixels and the rest are per-class scores (already sigmoided in the export).
 */
export function decodeYolo(output: Float32Array, dims: readonly number[], o: DecodeOptions): Candidate[] {
  const [batch, channels, anchors] = dims;
  if (batch !== 1 || channels !== 4 + o.numClasses || anchors === undefined) {
    throw new Error(`unexpected output shape [${dims.join(", ")}], expected [1, ${4 + o.numClasses}, N]`);
  }
  // Model coordinates live in the padded square; one model pixel is `factor`
  // original pixels. Padding is on the right/bottom, so no offset to remove.
  const factor = Math.max(o.width, o.height) / o.inputSize;
  const at = (c: number, i: number) => output[c * anchors + i]!;

  const out: Candidate[] = [];
  for (let i = 0; i < anchors; i++) {
    let best = -1;
    let score = -Infinity;
    for (let c = 0; c < o.numClasses; c++) {
      const s = at(4 + c, i);
      if (s > score) {
        score = s;
        best = c;
      }
    }
    if (score < o.candidateThreshold) continue;

    const cx = at(0, i) * factor;
    const cy = at(1, i) * factor;
    const bw = at(2, i) * factor;
    const bh = at(3, i) * factor;
    const x = clamp(cx - bw / 2, 0, o.width);
    const y = clamp(cy - bh / 2, 0, o.height);
    const w = Math.min(bw, o.width - x);
    const h = Math.min(bh, o.height - y);
    if (w <= 0 || h <= 0) continue;
    out.push({ classId: best, score, x, y, w, h });
  }
  return out;
}

export function iou(a: Candidate, b: Candidate): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Greedy non-maximum suppression, class-agnostic like upstream NudeNet
 * (`cv2.dnn.NMSBoxes`): the strongest box wins an overlap regardless of class.
 * IoU is computed in pixels — in normalised coordinates a non-square frame
 * would distort it.
 */
export function nms(candidates: Candidate[], iouThreshold: number, scoreThreshold: number): Candidate[] {
  const sorted = candidates.filter((c) => c.score >= scoreThreshold).sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  for (const c of sorted) if (kept.every((k) => iou(k, c) <= iouThreshold)) kept.push(c);
  return kept;
}

export function toDetections(
  candidates: Candidate[],
  labels: readonly string[],
  width: number,
  height: number,
): Detection[] {
  return candidates.map((c) => ({
    label: labels[c.classId] ?? `CLASS_${c.classId}`,
    score: round(c.score, 4),
    box: { x: round(c.x / width, 5), y: round(c.y / height, 5), w: round(c.w / width, 5), h: round(c.h / height, 5) },
  }));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
