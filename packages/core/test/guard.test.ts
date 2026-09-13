import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CamGuard,
  EvidenceStore,
  loadPolicyConfig,
  PolicyEngine,
  type ActionEvent,
  type Detection,
  type Detector,
  type ReportEvent,
  type Subject,
} from "../src/index.js";
import { det, frame, SEC, subject } from "./helpers.js";

const EXAMPLE = resolve(import.meta.dirname, "../../../policy.example.yaml");

/** Returns whatever the test puts in `next`. */
class ScriptedDetector implements Detector {
  readonly name = "scripted";
  readonly labels = ["FEMALE_BREAST_EXPOSED", "CHILD_PRESENT"];
  next: Detection[] = [];
  async detect() {
    return this.next;
  }
}

describe("CamGuard pipeline", () => {
  let dir: string;
  let detector: ScriptedDetector;
  let calls: string[];
  let timers: { fn: () => void; ms: number }[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cam-guard-guard-"));
    detector = new ScriptedDetector();
    calls = [];
    timers = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const adapters = {
    warn: async (s: Subject, text: string) => void calls.push(`warn ${s.userId} ${text.slice(0, 10)}`),
    closeCam: async (s: Subject) => void calls.push(`closeCam ${s.userId}`),
    kick: async (s: Subject) => void calls.push(`kick ${s.userId}`),
    suspend: async (s: Subject, hours: number) => void calls.push(`suspend ${s.userId} ${hours}h`),
  };

  async function make(mode: "report" | "auto", extra: { dryRun?: boolean } = {}) {
    const guard = new CamGuard({
      detectors: [detector],
      policy: new PolicyEngine(await loadPolicyConfig(EXAMPLE)),
      evidence: new EvidenceStore({ dir }),
      actions: adapters,
      mode,
      ...extra,
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        timers = timers.filter((t) => t !== h);
      },
    });
    const reports: ReportEvent[] = [];
    const actions: ActionEvent[] = [];
    guard.on("report", (e) => reports.push(e));
    guard.on("action", (e) => actions.push(e));
    return { guard, reports, actions };
  }

  const run = async (guard: CamGuard, n: number, s = subject(), t0 = 0) => {
    for (let i = 0; i < n; i++) await guard.process(frame(s, t0 + i * SEC));
  };

  it("auto mode: reports, calls adapters, saves the streak as evidence", async () => {
    const { guard, reports, actions } = await make("auto");
    detector.next = [det("FEMALE_BREAST_EXPOSED", 0.95)];
    await run(guard, 3);

    expect(calls).toEqual(["closeCam u1", "warn u1 La tua web"]);
    expect(reports).toHaveLength(1);
    expect(actions.map((a) => `${a.action.type}:${a.result.outcome}`)).toEqual(["close_cam:done", "warn:done"]);

    const record = reports[0]!.evidence!;
    expect(record.frames).toHaveLength(3); // the whole 3-frame streak
    const stored = await new EvidenceStore({ dir }).get(record.id);
    expect(stored!.actions.map((a) => a.outcome)).toEqual(["done", "done"]);
    expect(stored!.detectors).toEqual(["scripted"]);
  });

  it("report mode: nothing is executed, actions are recorded as report_only", async () => {
    const { guard, actions } = await make("report");
    detector.next = [det("FEMALE_BREAST_EXPOSED", 0.95)];
    await run(guard, 3);
    expect(calls).toEqual([]);
    expect(actions.map((a) => a.result.outcome)).toEqual(["report_only", "report_only"]);
  });

  it("dry run wins over auto", async () => {
    const { guard, actions } = await make("auto", { dryRun: true });
    detector.next = [det("FEMALE_BREAST_EXPOSED", 0.95)];
    await run(guard, 3);
    expect(calls).toEqual([]);
    expect(actions.every((a) => a.result.outcome === "dry_run")).toBe(true);
  });

  it("delayed actions: warn now, kick after 5 s; close() cancels pending ones", async () => {
    const { guard, actions } = await make("auto");
    detector.next = [det("CHILD_PRESENT", 0.9)];
    await run(guard, 3);
    expect(calls).toEqual(["warn u1 Non è cons"]);
    expect(timers.map((t) => t.ms)).toEqual([5_000]);
    expect(guard.pendingActions).toBe(1);

    timers[0]!.fn();
    await guard.idle();
    expect(calls).toEqual(["warn u1 Non è cons", "kick u1"]);
    expect(actions.map((a) => a.action.type)).toEqual(["warn", "kick"]);
    expect(guard.pendingActions).toBe(0);

    // A second case, then close() before the delay elapses.
    detector.next = [];
    await run(guard, 1, subject(), 10 * SEC);
    detector.next = [det("CHILD_PRESENT", 0.9)];
    await run(guard, 3, subject(), 20 * SEC);
    expect(guard.pendingActions).toBe(1);
    await guard.close();
    expect(guard.pendingActions).toBe(0);
  });

  it("a missing adapter is skipped, a throwing one is recorded as failed", async () => {
    const guard = new CamGuard({
      detectors: [detector],
      policy: new PolicyEngine(await loadPolicyConfig(EXAMPLE)),
      mode: "auto",
      actions: {
        closeCam: async () => {
          throw new Error("platform down");
        },
      },
    });
    const outcomes: string[] = [];
    guard.on("action", (e) => outcomes.push(`${e.action.type}:${e.result.outcome}:${e.result.error ?? ""}`));
    detector.next = [det("FEMALE_BREAST_EXPOSED", 0.95)];
    await run(guard, 3);
    expect(outcomes).toEqual(["close_cam:failed:platform down", "warn:skipped:"]);
  });

  it("prune drops idle buffers, so the next streak's evidence starts fresh", async () => {
    const { guard, reports } = await make("report");
    detector.next = [det("FEMALE_BREAST_EXPOSED", 0.7)];
    await run(guard, 2); // two frames buffered, no decision yet
    guard.prune(20 * 60 * SEC);
    detector.next = [];
    await run(guard, 1, subject(), 21 * 60 * SEC);
    detector.next = [det("FEMALE_BREAST_EXPOSED", 0.7)];
    await run(guard, 3, subject(), 22 * 60 * SEC);
    expect(reports[0]!.evidence!.frames.map((f) => f.capturedAt)).toEqual([
      22 * 60 * SEC,
      22 * 60 * SEC + SEC,
      22 * 60 * SEC + 2 * SEC,
    ]);
  });

  it("emits detection for every frame, decisions or not", async () => {
    const { guard } = await make("report");
    let n = 0;
    guard.on("detection", () => void n++);
    await run(guard, 4);
    expect(n).toBe(4);
  });
});
