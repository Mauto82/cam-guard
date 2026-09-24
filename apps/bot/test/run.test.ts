import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceStore } from "@cam-guard/core";
import { BotConfigError, parseBotConfig } from "../src/config.js";
import { runBot } from "../src/run.js";
import { camera, nude, ScriptedDetector, solidPng } from "./helpers.js";

const POLICY = resolve(import.meta.dirname, "../../../policy.example.yaml");

describe("bot config", () => {
  it("fills defaults and resolves paths against the config folder", () => {
    const cfg = parseBotConfig(
      { policy: "../policy.yaml", evidence: { dir: "evidence" }, source: { folder: { dir: "frames" } } },
      "/srv/cam-guard/conf",
    );
    expect(cfg).toMatchObject({
      mode: "report",
      dryRun: false,
      policy: "/srv/cam-guard/policy.yaml",
      evidence: { dir: "/srv/cam-guard/conf/evidence", retention: 30 * 86_400_000 },
      detector: { nudenet: { model: "320n", channels: "rgb" } },
      scheduler: { interval: 10_000, priorityInterval: 2_000 },
      source: { folder: { dir: "/srv/cam-guard/conf/frames", loop: false } },
    });
  });

  it("reports every problem at once", () => {
    try {
      parseBotConfig({ mode: "yolo", evidence: {}, source: {}, extra: 1 }, "/");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BotConfigError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/mode/);
      expect(msg).toMatch(/policy/);
      expect(msg).toMatch(/evidence\.dir/);
      expect(msg).toMatch(/extra/);
    }
  });
});

describe("runBot on a folder source", () => {
  let dir: string;
  let detector: ScriptedDetector;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cam-guard-bot-"));
    detector = new ScriptedDetector();
    lines = [];
    const hot = await solidPng(255, 0, 0);
    const warm = await solidPng(0, 255, 0);
    const cold = await solidPng(0, 0, 255);
    detector.register(hot, nude(0.95));
    detector.register(warm, nude(0.5)); // above watch, below report
    // alice: a clear case in a strict room. bob: nothing. carol: same as
    // alice but in a room where adult nudity is allowed. dave: only hints.
    await camera(join(dir, "frames"), "lobby", "alice", [cold, hot, hot, hot, hot, cold]);
    await camera(join(dir, "frames"), "lobby", "bob", [cold, cold, cold, cold]);
    await camera(join(dir, "frames"), "adults-1", "carol", [hot, hot, hot]);
    await camera(join(dir, "frames"), "lobby", "dave", [warm, warm, cold]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const config = (over: Record<string, unknown> = {}) =>
    parseBotConfig(
      {
        policy: POLICY,
        evidence: { dir: "evidence" },
        source: { folder: { dir: "frames" } },
        scheduler: { interval: "10s", priorityInterval: "2s" },
        ...over,
      },
      dir,
    );

  const run = (over: Record<string, unknown> = {}, opts: Parameters<typeof runBot>[1] = {}) =>
    runBot(config(over), { detectors: [detector], fast: true, once: true, write: (l) => lines.push(l), ...opts });

  it("report mode: the whole flow, nothing done to anyone", async () => {
    const summary = await run();

    expect(summary.frames).toBe(16);
    expect(summary.reports).toBe(2); // alice (act-level) and carol (report only)
    expect(summary.actions).toEqual({ report_only: 2 }); // alice's close_cam and warn
    expect(summary.watches).toBeGreaterThanOrEqual(1); // dave, at least

    const text = lines.join("\n");
    expect(text).toMatch(/REPORT alice@lobby explicit-nudity act offence=1 top=0\.95/);
    expect(text).toMatch(/REPORT carol@adults-1 explicit-nudity report/);
    expect(text).toMatch(/ACTION alice@lobby close_cam → report_only/);
    expect(text).toMatch(/WATCH  dave@lobby/);
    expect(text).not.toMatch(/bob@lobby/);

    const saved = await new EvidenceStore({ dir: join(dir, "evidence") }).list();
    expect(saved.map((r) => r.decision.subject.userId).sort()).toEqual(["alice", "carol"]);
    const alice = saved.find((r) => r.decision.subject.userId === "alice")!;
    expect(alice.frames).toHaveLength(3); // the streak, not the clean frames around it
    expect(alice.actions.map((a) => `${a.type}:${a.outcome}`)).toEqual(["close_cam:report_only", "warn:report_only"]);
  });

  it("a watched user is sampled faster, so the case is confirmed sooner", async () => {
    await run({ log: { format: "json" } });
    const events = lines.map((l) => JSON.parse(l) as { t: string; event: string; subject?: { userId: string } });
    const alice = events.filter((e) => e.subject?.userId === "alice");
    const firstHint = alice.find((e) => e.event === "watch")!;
    const report = events.find((e) => e.event === "report" && (e as { decision?: { subject: { userId: string } } }).decision?.subject.userId === "alice")!;
    // Hint on frame 2, then frames every 2 s instead of every 10 s.
    expect(Date.parse(report.t) - Date.parse(firstHint.t)).toBeLessThanOrEqual(6_000);
  });

  it("auto mode calls the adapters from the configured module", async () => {
    const adapters = join(dir, "adapters.mjs");
    await writeFile(
      adapters,
      `const calls = (globalThis.__camGuardCalls ??= []);
       export const closeCam = async (u) => { calls.push("closeCam " + u.userId); };
       export const warn = async (u, text) => { calls.push("warn " + u.userId); };`,
    );
    (globalThis as { __camGuardCalls?: string[] }).__camGuardCalls = [];
    const summary = await run({ mode: "auto", adapters: "adapters.mjs" });
    expect((globalThis as { __camGuardCalls?: string[] }).__camGuardCalls).toEqual(["closeCam alice", "warn alice"]);
    expect(summary.actions).toEqual({ done: 2 });
  });

  it("an adapters `report` export hears every report, with the frame, even in report mode", async () => {
    const adapters = join(dir, "adapters.mjs");
    await writeFile(
      adapters,
      `const seen = (globalThis.__camGuardReports ??= []);
       export const report = async (u, n) => { seen.push([u.userId, n.level, n.topScore, n.image.bytes.length > 0, n.image.mime]); };`,
    );
    (globalThis as { __camGuardReports?: unknown[] }).__camGuardReports = [];
    const summary = await run({ adapters: "adapters.mjs" });
    await new Promise((r) => setTimeout(r, 0)); // the hook runs off the loop
    const seen = (globalThis as { __camGuardReports?: unknown[][] }).__camGuardReports!;
    expect(seen.map((x) => x.slice(0, 2)).sort()).toEqual([["alice", "act"], ["carol", "report"]]);
    expect(seen.every((x) => x[3] === true && x[4] === "image/png")).toBe(true);
    expect(summary.actions).toEqual({ report_only: 2 }); // still nothing done to anyone
  });

  it("a failing report hook is logged, the bot goes on", async () => {
    const adapters = join(dir, "adapters.mjs");
    await writeFile(adapters, `export const report = async () => { throw new Error("platform down"); };`);
    const summary = await run({ adapters: "adapters.mjs" });
    await new Promise((r) => setTimeout(r, 0));
    expect(summary.reports).toBe(2);
    expect(lines.join("\n")).toMatch(/report hook failed: platform down/);
  });

  it("auto mode without adapters refuses to start, unless it is a dry run", async () => {
    await expect(run({ mode: "auto" })).rejects.toThrow(/needs `adapters`/);
    const summary = await run({ mode: "auto", dryRun: true });
    expect(summary.actions).toEqual({ dry_run: 2 });
  });

  it("warns about policy labels no detector can emit", async () => {
    detector.labels.splice(detector.labels.indexOf("ANUS_EXPOSED"), 1);
    await run();
    expect(lines.join("\n")).toMatch(/WARN .*never fire: ANUS_EXPOSED/);
  });

  it("stops on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const summary = await run({}, { signal: controller.signal, once: false });
    expect(summary.frames).toBe(0);
  });
});
