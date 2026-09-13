import { describe, expect, it } from "vitest";
import { decodeYolo, iou, nms, NUDENET_LABELS, toDetections, type Candidate } from "../src/index.js";

const C = NUDENET_LABELS.length;

/**
 * Build a [1, 4 + C, N] output from per-anchor rows, the way the model lays
 * it out: channel-major.
 */
function tensor(rows: { cx: number; cy: number; w: number; h: number; scores: Record<number, number> }[]) {
  const n = rows.length;
  const data = new Float32Array((4 + C) * n);
  rows.forEach((r, i) => {
    data[0 * n + i] = r.cx;
    data[1 * n + i] = r.cy;
    data[2 * n + i] = r.w;
    data[3 * n + i] = r.h;
    for (const [c, s] of Object.entries(r.scores)) data[(4 + Number(c)) * n + i] = s;
  });
  return { data, dims: [1, 4 + C, n] };
}

const cand = (x: number, y: number, w: number, h: number, score: number, classId = 0): Candidate => ({
  x,
  y,
  w,
  h,
  score,
  classId,
});

describe("decodeYolo", () => {
  it("maps model-square coordinates back to a non-square original", () => {
    // 640×320 original, 320 input: the image fills the top half of the square
    // (padding at the bottom), one model pixel = 2 original pixels.
    const { data, dims } = tensor([{ cx: 160, cy: 80, w: 100, h: 40, scores: { 3: 0.9 } }]);
    const [c] = decodeYolo(data, dims, { numClasses: C, inputSize: 320, width: 640, height: 320, candidateThreshold: 0.2 });
    expect(c).toEqual({ classId: 3, score: expect.closeTo(0.9, 5), x: 220, y: 120, w: 200, h: 80 });
  });

  it("picks the best class per anchor and drops weak anchors", () => {
    const { data, dims } = tensor([
      { cx: 50, cy: 50, w: 20, h: 20, scores: { 1: 0.3, 12: 0.6 } },
      { cx: 50, cy: 50, w: 20, h: 20, scores: { 4: 0.15 } },
    ]);
    const out = decodeYolo(data, dims, { numClasses: C, inputSize: 320, width: 320, height: 320, candidateThreshold: 0.2 });
    expect(out).toHaveLength(1);
    expect(NUDENET_LABELS[out[0]!.classId]).toBe("FACE_MALE");
  });

  it("clips boxes that spill outside the image", () => {
    const { data, dims } = tensor([{ cx: 5, cy: 310, w: 40, h: 40, scores: { 0: 0.9 } }]);
    const [c] = decodeYolo(data, dims, { numClasses: C, inputSize: 320, width: 320, height: 320, candidateThreshold: 0.2 });
    expect(c!.x).toBe(0);
    expect(c!.y + c!.h).toBeLessThanOrEqual(320);
    expect(c!.w).toBe(40);
  });

  it("refuses an output of the wrong shape", () => {
    expect(() =>
      decodeYolo(new Float32Array(10), [1, 10, 1], { numClasses: C, inputSize: 320, width: 1, height: 1, candidateThreshold: 0 }),
    ).toThrow(/unexpected output shape/);
  });
});

describe("nms", () => {
  it("keeps the strongest of overlapping boxes, regardless of class", () => {
    const kept = nms([cand(0, 0, 100, 100, 0.8, 2), cand(5, 5, 100, 100, 0.9, 3), cand(300, 300, 50, 50, 0.5, 2)], 0.45, 0.25);
    expect(kept.map((k) => k.score)).toEqual([0.9, 0.5]);
  });

  it("drops boxes under the score threshold", () => {
    expect(nms([cand(0, 0, 10, 10, 0.24)], 0.45, 0.25)).toEqual([]);
  });

  it("iou of identical / disjoint / half-overlapping boxes", () => {
    expect(iou(cand(0, 0, 10, 10, 1), cand(0, 0, 10, 10, 1))).toBe(1);
    expect(iou(cand(0, 0, 10, 10, 1), cand(20, 20, 10, 10, 1))).toBe(0);
    expect(iou(cand(0, 0, 10, 10, 1), cand(5, 0, 10, 10, 1))).toBeCloseTo(50 / 150);
  });
});

describe("toDetections", () => {
  it("normalises boxes to 0..1 and names the label", () => {
    const [d] = toDetections([cand(64, 32, 128, 64, 0.87654321, 3)], NUDENET_LABELS, 640, 320);
    expect(d).toEqual({ label: "FEMALE_BREAST_EXPOSED", score: 0.8765, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
  });
});

describe("labels", () => {
  it("has the 18 upstream classes in upstream order", () => {
    expect(NUDENET_LABELS).toHaveLength(18);
    expect(NUDENET_LABELS[0]).toBe("FEMALE_GENITALIA_COVERED");
    expect(NUDENET_LABELS[17]).toBe("BUTTOCKS_COVERED");
  });
});
