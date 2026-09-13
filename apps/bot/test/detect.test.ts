import { describe, expect, it } from "vitest";
import { formatReport, stats, type DetectReport } from "../src/detect.js";

const t = (totalMs: number) => ({ preprocessMs: 1, inferenceMs: totalMs - 2, postprocessMs: 1, totalMs });

describe("stats", () => {
  it("means, median and max over runs", () => {
    const s = stats([t(30), t(10), t(20), t(100)]);
    expect(s.runs).toBe(4);
    expect(s.mean.totalMs).toBe(40);
    expect(s.p50TotalMs).toBe(20);
    expect(s.maxTotalMs).toBe(100);
  });
});

describe("formatReport", () => {
  const report: DetectReport = {
    file: "frame.jpg",
    model: "320n",
    width: 640,
    height: 480,
    detections: [{ label: "FACE_FEMALE", score: 0.912, box: { x: 0.25, y: 0.5, w: 0.1, h: 0.2 } }],
    loadMs: 120,
    firstRunMs: 80,
    timing: stats([t(40), t(42)]),
    withinBudget: true,
  };

  it("prints pixel boxes, timings and the budget verdict", () => {
    const out = formatReport(report);
    expect(out).toContain("frame.jpg  (640×480, nudenet-320n)");
    expect(out).toMatch(/FACE_FEMALE\s+0\.912\s+box x=160 y=240 w=64 h=96/);
    expect(out).toContain("total 41.0 ms");
    expect(out).toContain("✓ within the 100 ms budget");
  });

  it("flags a run over budget", () => {
    expect(formatReport({ ...report, withinBudget: false })).toContain("✗ OVER the 100 ms budget");
  });
});
