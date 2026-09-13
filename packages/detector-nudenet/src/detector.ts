import * as ort from "onnxruntime-node";
import type { Detection, Detector, EncodedImage } from "@cam-guard/core";
import { NUDENET_LABELS } from "./labels.js";
import { ensureModel, MODELS, type NudeNetModel } from "./models.js";
import { decodeYolo, nms, toDetections } from "./postprocess.js";
import { prepare, type ChannelOrder } from "./preprocess.js";

export interface NudeNetOptions {
  /** `320n` (default, fast) or `640m` (slower, better on small details). */
  model?: NudeNetModel;
  /** Use this .onnx file instead of the managed cache (still hash-checked). */
  modelPath?: string;
  modelsDir?: string;
  /** Final score threshold (upstream: 0.25). Policies filter further. */
  scoreThreshold?: number;
  /** Pre-NMS candidate threshold (upstream: 0.2). */
  candidateThreshold?: number;
  iouThreshold?: number;
  /** `rgb` (default, what the model was trained on) or `bgr` (upstream NudeNet's scores). */
  channelOrder?: ChannelOrder;
  /** ONNX Runtime intra-op threads (default: let the runtime decide). */
  threads?: number;
  log?: (message: string) => void;
}

export interface Timings {
  /** Decode + orient + resize + pad (sharp). */
  preprocessMs: number;
  inferenceMs: number;
  postprocessMs: number;
  totalMs: number;
}

export interface TimedDetections {
  detections: Detection[];
  timings: Timings;
  width: number;
  height: number;
}

/** NudeNet v3 (YOLOv8) on ONNX Runtime, CPU, entirely local. */
export class NudeNetDetector implements Detector {
  readonly name: string;
  readonly labels = NUDENET_LABELS;
  private session: ort.InferenceSession | null = null;
  private loading: Promise<void> | null = null;
  private inputName = "";
  private outputName = "";
  private readonly model: NudeNetModel;
  private readonly inputSize: number;

  constructor(private readonly opts: NudeNetOptions = {}) {
    this.model = opts.model ?? "320n";
    this.inputSize = MODELS[this.model].inputSize;
    this.name = `nudenet-${this.model}`;
  }

  init(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    const path =
      this.opts.modelPath ??
      (await ensureModel(this.model, {
        ...(this.opts.modelsDir !== undefined ? { dir: this.opts.modelsDir } : {}),
        ...(this.opts.log ? { log: this.opts.log } : {}),
      }));
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    };
    if (this.opts.threads !== undefined) options.intraOpNumThreads = this.opts.threads;
    this.session = await ort.InferenceSession.create(path, options);
    this.inputName = this.session.inputNames[0]!;
    this.outputName = this.session.outputNames[0]!;
  }

  async detect(image: EncodedImage): Promise<Detection[]> {
    return (await this.detectTimed(image)).detections;
  }

  async detectTimed(image: EncodedImage): Promise<TimedDetections> {
    await this.init();
    const session = this.session!;
    const t0 = performance.now();
    const prepared = await prepare(image, this.inputSize, this.opts.channelOrder ?? "rgb");
    const t1 = performance.now();

    const input = new ort.Tensor("float32", prepared.tensor, [1, 3, this.inputSize, this.inputSize]);
    const results = await session.run({ [this.inputName]: input });
    const output = results[this.outputName]!;
    const t2 = performance.now();

    const candidates = decodeYolo(output.data as Float32Array, output.dims, {
      numClasses: NUDENET_LABELS.length,
      inputSize: this.inputSize,
      width: prepared.width,
      height: prepared.height,
      candidateThreshold: this.opts.candidateThreshold ?? 0.2,
    });
    const kept = nms(candidates, this.opts.iouThreshold ?? 0.45, this.opts.scoreThreshold ?? 0.25);
    const detections = toDetections(kept, NUDENET_LABELS, prepared.width, prepared.height);
    const t3 = performance.now();

    return {
      detections,
      width: prepared.width,
      height: prepared.height,
      timings: { preprocessMs: t1 - t0, inferenceMs: t2 - t1, postprocessMs: t3 - t2, totalMs: t3 - t0 },
    };
  }

  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = null;
    this.loading = null;
  }
}
