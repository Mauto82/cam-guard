import type { ActionResult, EvidenceFrame, EvidenceRecord, EvidenceStore } from "./evidence.js";
import { TypedEmitter } from "./events.js";
import type { Decision, PolicyEngine } from "./policy/engine.js";
import type { ActionAdapters, ActionSpec, Detection, Detector, Frame } from "./types.js";

/**
 * `report`: decisions are only reported; kicks and suspensions are recorded as
 * what WOULD have happened. `auto`: platform adapters are called.
 */
export type GuardMode = "report" | "auto";

export interface DetectionEvent {
  frame: Frame;
  detections: Detection[];
  ms: number;
}

export interface ReportEvent {
  decision: Decision;
  evidence: EvidenceRecord | null;
  /** The frame that tipped the decision, for notifiers that attach an image. */
  frame: Frame;
}

export interface ActionEvent {
  decision: Decision;
  action: ActionSpec;
  result: ActionResult;
}

export interface CamGuardEvents {
  detection: [DetectionEvent];
  report: [ReportEvent];
  action: [ActionEvent];
  error: [Error];
}

export interface CamGuardOptions {
  detectors: Detector[];
  policy: PolicyEngine;
  evidence?: EvidenceStore;
  actions?: ActionAdapters;
  mode?: GuardMode;
  /** Resolve every action as `dry_run`, even in `auto` mode. */
  dryRun?: boolean;
  /** Frames kept per user so evidence shows the whole streak (default 5). */
  bufferFrames?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The pipeline: frame → detectors → policy → evidence → actions, with events
 * at each step. Platform-agnostic: it only ever talks to the adapters it is
 * given.
 */
export class CamGuard extends TypedEmitter<CamGuardEvents> {
  private readonly buffers = new Map<string, EvidenceFrame[]>();
  private readonly timers = new Set<unknown>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly mode: GuardMode;
  private readonly bufferFrames: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: CamGuardOptions) {
    super();
    if (opts.detectors.length === 0) throw new Error("at least one detector is required");
    this.mode = opts.mode ?? "report";
    this.bufferFrames = Math.max(1, opts.bufferFrames ?? 5);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  async init(): Promise<void> {
    for (const d of this.opts.detectors) await d.init?.();
  }

  async process(frame: Frame): Promise<Decision[]> {
    const started = performance.now();
    const detections: Detection[] = [];
    for (const detector of this.opts.detectors) detections.push(...(await detector.detect(frame.image)));
    this.emit("detection", { frame, detections, ms: performance.now() - started });

    const buffer = this.buffer(frame.subject.userId);
    buffer.push({ image: frame.image, capturedAt: frame.capturedAt, detections });
    if (buffer.length > this.bufferFrames) buffer.shift();

    const decisions = this.opts.policy.evaluate(frame.subject, detections, frame.capturedAt);
    for (const decision of decisions) await this.handle(decision, frame, buffer.slice(-decision.frames));
    return decisions;
  }

  /**
   * Drop frame buffers of users not seen for `idleMs` (default 10 min) and let
   * the policy forget idle users. Frames are the only images held in memory;
   * without this, everyone who ever switched a camera on stays buffered.
   */
  prune(now: number, idleMs = 10 * 60_000): void {
    for (const [userId, buffer] of this.buffers) {
      const last = buffer.at(-1)?.capturedAt ?? 0;
      if (now - last >= idleMs) this.buffers.delete(userId);
    }
    this.opts.policy.prune(now);
  }

  /** Resolves once every delayed action that already started has finished. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /**
   * Cancel delayed actions not yet started, wait for those already running,
   * release detectors.
   */
  async close(): Promise<void> {
    for (const t of this.timers) this.clearTimer(t);
    this.timers.clear();
    await this.idle();
    for (const d of this.opts.detectors) await d.dispose?.();
  }

  get pendingActions(): number {
    return this.timers.size;
  }

  private async handle(decision: Decision, frame: Frame, frames: EvidenceFrame[]): Promise<void> {
    let record: EvidenceRecord | null = null;
    if (this.opts.evidence) {
      record = await this.opts.evidence.save({
        decision,
        frames,
        detectors: this.opts.detectors.map((d) => d.name),
        createdAt: decision.decidedAt,
      });
    }

    for (const action of decision.actions) {
      if (action.type === "report") {
        this.emit("report", { decision, evidence: record, frame });
        continue;
      }
      if (action.delayMs && action.delayMs > 0) {
        const handle = this.setTimer(() => {
          this.timers.delete(handle);
          const running = this.execute(decision, action, record).finally(() => this.inFlight.delete(running));
          this.inFlight.add(running);
        }, action.delayMs);
        this.timers.add(handle);
      } else {
        await this.execute(decision, action, record);
      }
    }
  }

  private async execute(decision: Decision, action: ActionSpec, record: EvidenceRecord | null): Promise<void> {
    const result = await this.run(decision, action);
    if (record && this.opts.evidence) {
      try {
        await this.opts.evidence.appendActions(record.id, [result]);
      } catch (err) {
        this.fail(err);
      }
    }
    this.emit("action", { decision, action, result });
  }

  private async run(decision: Decision, action: ActionSpec): Promise<ActionResult> {
    const at = Date.now();
    if (this.opts.dryRun) return { type: action.type, outcome: "dry_run", at };
    if (this.mode === "report") return { type: action.type, outcome: "report_only", at };

    const a = this.opts.actions ?? {};
    const subject = decision.subject;
    const reason = action.message ?? `cam-guard: ${decision.ruleId}`;
    try {
      switch (action.type) {
        case "warn":
          if (!a.warn) return { type: action.type, outcome: "skipped", at };
          await a.warn(subject, action.message ?? reason);
          break;
        case "close_cam":
          if (!a.closeCam) return { type: action.type, outcome: "skipped", at };
          await a.closeCam(subject);
          break;
        case "kick":
          if (!a.kick) return { type: action.type, outcome: "skipped", at };
          await a.kick(subject, reason);
          break;
        case "suspend":
          if (!a.suspend) return { type: action.type, outcome: "skipped", at };
          await a.suspend(subject, action.hours ?? 24, reason);
          break;
        case "report":
          break;
      }
      return { type: action.type, outcome: "done", at };
    } catch (err) {
      return { type: action.type, outcome: "failed", at, error: (err as Error).message ?? String(err) };
    }
  }

  private buffer(userId: string): EvidenceFrame[] {
    let b = this.buffers.get(userId);
    if (!b) {
      b = [];
      this.buffers.set(userId, b);
    }
    return b;
  }

  private fail(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.listenerCount("error") > 0) this.emit("error", error);
    else throw error;
  }
}
