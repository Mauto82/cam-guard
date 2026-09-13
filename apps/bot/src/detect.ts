import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { EncodedImage, ImageMime } from "@cam-guard/core";
import {
  NudeNetDetector,
  type ChannelOrder,
  type NudeNetModel,
  type TimedDetections,
  type Timings,
} from "@cam-guard/detector-nudenet";

/** CPU budget per frame for the 320 model, from the project's requirements. */
export const BUDGET_320_MS = 100;

const MIME: Record<string, ImageMime> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export async function readImage(path: string): Promise<EncodedImage> {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`${path}: unsupported extension (jpg, png, webp)`);
  return { bytes: new Uint8Array(await readFile(path)), mime };
}

export interface TimingStats {
  runs: number;
  mean: Timings;
  p50TotalMs: number;
  maxTotalMs: number;
}

export function stats(samples: Timings[]): TimingStats {
  const n = samples.length;
  const mean = (k: keyof Timings) => samples.reduce((s, t) => s + t[k], 0) / n;
  const totals = samples.map((t) => t.totalMs).sort((a, b) => a - b);
  return {
    runs: n,
    mean: {
      preprocessMs: mean("preprocessMs"),
      inferenceMs: mean("inferenceMs"),
      postprocessMs: mean("postprocessMs"),
      totalMs: mean("totalMs"),
    },
    p50TotalMs: totals[Math.floor((n - 1) / 2)]!,
    maxTotalMs: totals[n - 1]!,
  };
}

export interface DetectReport {
  file: string;
  model: NudeNetModel;
  width: number;
  height: number;
  detections: TimedDetections["detections"];
  loadMs: number;
  /** First inference, excluded from the stats: it pays for graph warm-up. */
  firstRunMs: number;
  timing: TimingStats;
  withinBudget: boolean | null;
}

export async function detectFiles(
  files: string[],
  opts: { model: NudeNetModel; runs: number; threads?: number; channelOrder?: ChannelOrder; log?: (m: string) => void },
): Promise<DetectReport[]> {
  const detector = new NudeNetDetector({
    model: opts.model,
    ...(opts.threads !== undefined ? { threads: opts.threads } : {}),
    ...(opts.channelOrder ? { channelOrder: opts.channelOrder } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  const t0 = performance.now();
  await detector.init();
  const loadMs = performance.now() - t0;

  const reports: DetectReport[] = [];
  try {
    for (const file of files) {
      const image = await readImage(file);
      const first = await detector.detectTimed(image);
      const samples: Timings[] = [];
      let last = first;
      for (let i = 0; i < opts.runs; i++) {
        last = await detector.detectTimed(image);
        samples.push(last.timings);
      }
      const timing = stats(samples.length ? samples : [first.timings]);
      reports.push({
        file,
        model: opts.model,
        width: last.width,
        height: last.height,
        detections: last.detections,
        loadMs,
        firstRunMs: first.timings.totalMs,
        timing,
        withinBudget: opts.model === "320n" ? timing.p50TotalMs < BUDGET_320_MS : null,
      });
    }
  } finally {
    await detector.dispose();
  }
  return reports;
}

const ms = (v: number) => `${v.toFixed(1)} ms`;

export function formatReport(r: DetectReport): string {
  const lines = [`${r.file}  (${r.width}×${r.height}, nudenet-${r.model})`];
  if (r.detections.length === 0) lines.push("  no detections");
  for (const d of r.detections) {
    const px = [d.box.x * r.width, d.box.y * r.height, d.box.w * r.width, d.box.h * r.height].map((v) => Math.round(v));
    lines.push(`  ${d.label.padEnd(26)} ${d.score.toFixed(3)}  box x=${px[0]} y=${px[1]} w=${px[2]} h=${px[3]}`);
  }
  const t = r.timing;
  lines.push(
    `  timing over ${t.runs} run(s): preprocess ${ms(t.mean.preprocessMs)} · inference ${ms(t.mean.inferenceMs)} · ` +
      `postprocess ${ms(t.mean.postprocessMs)} · total ${ms(t.mean.totalMs)} (p50 ${ms(t.p50TotalMs)}, max ${ms(t.maxTotalMs)})`,
    `  model load ${ms(r.loadMs)} · first run ${ms(r.firstRunMs)} (warm-up, not counted)`,
  );
  if (r.withinBudget === true) lines.push(`  ✓ within the ${BUDGET_320_MS} ms budget`);
  if (r.withinBudget === false) lines.push(`  ✗ OVER the ${BUDGET_320_MS} ms budget`);
  return lines.join("\n");
}
