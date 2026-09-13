import { describe, expect, it } from "vitest";
import { Scheduler, type Frame, type Source, type Subject } from "../src/index.js";
import { frame } from "./helpers.js";

class FakeSource implements Source {
  captured: string[] = [];
  failCapture = new Set<string>();
  failList = false;
  constructor(
    readonly id: string,
    public subjects: Subject[],
    private readonly clock: { t: number },
  ) {}
  async listActive() {
    if (this.failList) throw new Error("list failed");
    return this.subjects;
  }
  async capture(s: Subject): Promise<Frame | null> {
    this.captured.push(s.userId);
    if (this.failCapture.has(s.userId)) throw new Error(`capture ${s.userId} failed`);
    return frame(s, this.clock.t);
  }
}

function setup(users: string[], opts: { intervalMs?: number; priorityIntervalMs?: number } = {}) {
  const clock = { t: 0 };
  const source = new FakeSource("s1", users.map((u) => ({ userId: u, roomId: "r" })), clock);
  const frames: string[] = [];
  const errors: string[] = [];
  const scheduler = new Scheduler({
    sources: [source],
    intervalMs: opts.intervalMs ?? 10_000,
    ...(opts.priorityIntervalMs !== undefined ? { priorityIntervalMs: opts.priorityIntervalMs } : {}),
    onFrame: async (f) => {
      frames.push(f.subject.userId);
    },
    onError: (e) => errors.push((e as Error).message),
    now: () => clock.t,
  });
  /** Advance time in steps, ticking once per step. */
  const run = async (untilMs: number, stepMs = 1_000) => {
    while (clock.t <= untilMs) {
      while (await scheduler.tick()) {
        /* drain everything due at this instant */
      }
      clock.t += stepMs;
    }
  };
  return { clock, source, frames, errors, scheduler, run };
}

describe("Scheduler", () => {
  it("visits every active subject once per interval, round-robin", async () => {
    const { frames, run } = setup(["a", "b", "c"]);
    await run(25_000);
    // t=0 all three, t=10s all three, t=20s all three
    expect(frames).toEqual(["a", "b", "c", "a", "b", "c", "a", "b", "c"]);
  });

  it("nobody is sampled faster than the interval", async () => {
    const { frames, run } = setup(["a"]);
    await run(9_000);
    expect(frames).toEqual(["a"]);
  });

  it("prioritised subjects go first and more often", async () => {
    const { frames, scheduler, run, clock } = setup(["a", "b", "c"], { priorityIntervalMs: 3_000 });
    scheduler.prioritize("c", 60_000);
    await run(9_000);
    // c first at t=0, then every 3 s; a and b once.
    expect(frames).toEqual(["c", "a", "b", "c", "c", "c"]);
    expect(clock.t).toBe(10_000);
  });

  it("priority expires", async () => {
    const { frames, scheduler, run } = setup(["a", "b"], { priorityIntervalMs: 2_000 });
    scheduler.prioritize("b", 5_000);
    await run(15_000);
    // b: 0, 2, 4 (priority), then back to the 10 s cadence from its last capture: 14.
    expect(frames.filter((f) => f === "b")).toHaveLength(4);
    expect(scheduler.isPrioritized("b")).toBe(false);
  });

  it("subjects that turn off their camera are dropped; new ones are picked up", async () => {
    const { frames, source, run, clock } = setup(["a", "b"]);
    await run(0);
    source.subjects = [{ userId: "b", roomId: "r" }, { userId: "z", roomId: "r" }];
    clock.t = 10_000;
    await run(10_000);
    // z has never been sampled, so it is the most overdue and goes before b.
    expect(frames).toEqual(["a", "b", "z", "b"]);
  });

  it("a failing capture does not starve the others", async () => {
    const { frames, source, errors, run } = setup(["bad", "ok"]);
    source.failCapture.add("bad");
    await run(20_000);
    expect(frames).toEqual(["ok", "ok", "ok"]);
    expect(errors).toEqual(["capture bad failed", "capture bad failed", "capture bad failed"]);
  });

  it("a failing listing keeps the subjects already known", async () => {
    const { frames, source, errors, run, clock } = setup(["a"]);
    await run(0);
    source.failList = true;
    clock.t = 10_000;
    await run(10_000);
    expect(frames).toEqual(["a", "a"]);
    expect(errors).toContain("list failed");
  });

  it("an onFrame error is reported and the loop goes on", async () => {
    const clock = { t: 0 };
    const errors: string[] = [];
    const source = new FakeSource("s", [{ userId: "a", roomId: "r" }], clock);
    const scheduler = new Scheduler({
      sources: [source],
      intervalMs: 1_000,
      onFrame: async () => {
        throw new Error("boom");
      },
      onError: (e) => errors.push((e as Error).message),
      now: () => clock.t,
    });
    expect(await scheduler.tick()).toBe(true);
    expect(errors).toEqual(["boom"]);
  });

  it("start/stop runs the loop with the injected sleep", async () => {
    const clock = { t: 0 };
    const seen: string[] = [];
    const source = new FakeSource("s", [{ userId: "a", roomId: "r" }], clock);
    let scheduler!: Scheduler;
    scheduler = new Scheduler({
      sources: [source],
      intervalMs: 1_000,
      onFrame: async (f) => {
        seen.push(f.subject.userId);
        if (seen.length === 3) scheduler.stop();
      },
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
    });
    await scheduler.start();
    expect(seen).toEqual(["a", "a", "a"]);
    expect(clock.t).toBe(2_000);
  });
});
