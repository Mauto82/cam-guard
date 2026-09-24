import { pathToFileURL } from "node:url";
import {
  CamGuard,
  EvidenceStore,
  loadPolicyConfig,
  PolicyEngine,
  Scheduler,
  unknownLabels,
  type ActionAdapters,
  type ActionOutcome,
  type Detector,
  type Source,
  type Subject,
} from "@cam-guard/core";
import { NudeNetDetector } from "@cam-guard/detector-nudenet";
import type { BotConfig } from "./config.js";
import { FolderSource } from "./sources/folder.js";

export interface RunOptions {
  /** Replace the configured detectors (tests, custom setups). */
  detectors?: Detector[];
  /** Replace the configured source. */
  source?: Source;
  /**
   * Virtual clock: no real waiting between frames, delayed actions run at
   * once. For replaying a folder in seconds; decisions are the same because
   * the policy takes time from the frames, not from the wall clock.
   */
  fast?: boolean;
  /** Stop when no camera is left instead of waiting for new ones. */
  once?: boolean;
  mode?: BotConfig["mode"];
  dryRun?: boolean;
  write?: (line: string) => void;
  signal?: AbortSignal;
}

export interface RunSummary {
  frames: number;
  watches: number;
  reports: number;
  actions: Partial<Record<ActionOutcome, number>>;
  evidence: string[];
  meanDetectMs: number;
  /** Delayed actions still pending when the run stopped, cancelled. */
  cancelledActions: number;
}

const HOUSEKEEPING_MS = 3_600_000;

async function importModule(path: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

async function loadAdapters(path: string): Promise<ActionAdapters> {
  const mod = await importModule(path);
  const candidate = (mod.default ?? mod) as Record<string, unknown>;
  const adapters: ActionAdapters = {};
  for (const name of ["warn", "closeCam", "kick", "suspend", "ban"] as const) {
    const fn = candidate[name];
    if (fn === undefined) continue;
    if (typeof fn !== "function") throw new Error(`adapters ${path}: \`${name}\` is not a function`);
    (adapters as Record<string, unknown>)[name] = fn;
  }
  if (Object.keys(adapters).length === 0) throw new Error(`adapters ${path}: exports none of warn, closeCam, kick, suspend`);
  return adapters;
}

/**
 * What an optional `report` export of the adapters module receives: every
 * decision at report or act level, in any mode — telling the platform's staff
 * is not an action on the user, so `report` mode calls it too.
 */
export interface ReportNotice {
  ruleId: string;
  level: string;
  /** 1-based offence number at act level, 0 otherwise. */
  offence: number;
  topScore: number;
  label: string | null;
  hits: number;
  frames: number;
  evidenceId: string | null;
  /** The frame that tipped the decision. */
  image: { bytes: Uint8Array; mime: string };
  capturedAt: number;
}
export type ReportHook = (subject: Subject, notice: ReportNotice) => Promise<void> | void;

async function loadReportHook(path: string): Promise<ReportHook | undefined> {
  const mod = await importModule(path);
  const candidate = (mod.default ?? mod) as Record<string, unknown>;
  const fn = candidate.report;
  if (fn === undefined) return undefined;
  if (typeof fn !== "function") throw new Error(`adapters ${path}: \`report\` is not a function`);
  return fn as ReportHook;
}

async function loadSource(cfg: BotConfig, now: () => number): Promise<Source> {
  if ("folder" in cfg.source) return new FolderSource({ dir: cfg.source.folder.dir, loop: cfg.source.folder.loop, now });
  const mod = await importModule(cfg.source.module);
  const factory = mod.default;
  if (typeof factory !== "function") throw new Error(`source ${cfg.source.module}: default export must be a function returning a Source`);
  return (await factory(cfg.source.options, { now })) as Source;
}

/** Wait `ms`, or less if the run is aborted meanwhile. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runBot(cfg: BotConfig, opts: RunOptions = {}): Promise<RunSummary> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const mode = opts.mode ?? cfg.mode;
  const dryRun = opts.dryRun ?? cfg.dryRun;

  // ── clock ─────────────────────────────────────────────────────────────────
  let virtual = Date.now();
  const now = opts.fast ? () => virtual : Date.now;
  const wait = opts.fast
    ? async (ms: number) => {
        virtual += ms;
      }
    : (ms: number) => sleep(ms, opts.signal);

  // ── logging ───────────────────────────────────────────────────────────────
  const log = (event: string, fields: Record<string, unknown>, text: string) => {
    const t = new Date(now()).toISOString();
    if (cfg.log.format === "json") write(JSON.stringify({ t, event, ...fields }));
    else write(`${t} ${event.toUpperCase().padEnd(6)} ${text}`);
  };

  // ── pieces ────────────────────────────────────────────────────────────────
  const policyConfig = await loadPolicyConfig(cfg.policy);
  const detectors =
    opts.detectors ??
    [
      new NudeNetDetector({
        model: cfg.detector.nudenet.model,
        channelOrder: cfg.detector.nudenet.channels,
        ...(cfg.detector.nudenet.threads !== undefined ? { threads: cfg.detector.nudenet.threads } : {}),
        ...(cfg.detector.nudenet.modelsDir !== undefined ? { modelsDir: cfg.detector.nudenet.modelsDir } : {}),
        log: (m) => log("info", { message: m }, m),
      }),
    ];

  const missing = unknownLabels(policyConfig, detectors.flatMap((d) => d.labels));
  if (missing.length) {
    log("warn", { unknownLabels: missing }, `policy uses labels no detector emits, those rules will never fire: ${missing.join(", ")}`);
  }

  const reportHook = cfg.adapters ? await loadReportHook(cfg.adapters) : undefined;

  let adapters: ActionAdapters | undefined;
  if (mode === "auto" && !dryRun) {
    if (!cfg.adapters) throw new Error("mode `auto` needs `adapters` (a module exporting warn/closeCam/kick/suspend), or use --dry-run");
    adapters = await loadAdapters(cfg.adapters);
  }

  const evidence = new EvidenceStore({
    dir: cfg.evidence.dir,
    retentionMs: cfg.evidence.retention,
    confirmedRetentionMs: cfg.evidence.confirmedRetention,
  });
  const source = opts.source ?? (await loadSource(cfg, now));

  const guard = new CamGuard({
    detectors,
    policy: new PolicyEngine(policyConfig),
    evidence,
    mode,
    dryRun,
    ...(adapters ? { actions: adapters } : {}),
    // In fast mode there is no real time to wait: "kick 5 s later" happens now.
    ...(opts.fast
      ? {
          setTimer: (fn: () => void) => {
            const handle = {};
            queueMicrotask(fn);
            return handle;
          },
          clearTimer: () => {},
        }
      : {}),
  });

  const summary: RunSummary = { frames: 0, watches: 0, reports: 0, actions: {}, evidence: [], meanDetectMs: 0, cancelledActions: 0 };
  let detectMsTotal = 0;
  const who = (s: { userId: string; roomId: string }) => `${s.userId}@${s.roomId}`;

  guard.on("detection", ({ frame, detections, ms }) => {
    summary.frames += 1;
    detectMsTotal += ms;
    if (!cfg.log.detections) return;
    const found = detections.map((d) => `${d.label} ${d.score.toFixed(2)}`).join(", ") || "nothing";
    log("frame", { subject: frame.subject, detections, ms }, `${who(frame.subject)} ${ms.toFixed(0)} ms: ${found}`);
  });

  const scheduler = new Scheduler({
    sources: [source],
    intervalMs: cfg.scheduler.interval,
    priorityIntervalMs: cfg.scheduler.priorityInterval,
    ...(cfg.scheduler.refresh !== undefined ? { refreshMs: cfg.scheduler.refresh } : {}),
    onFrame: async (frame) => {
      await guard.process(frame);
    },
    onError: (err, ctx) => {
      const message = (err as Error).message ?? String(err);
      log("error", { message, ...ctx }, `${ctx.subject ? who(ctx.subject) : ctx.sourceId}: ${message}`);
    },
    now,
    sleep: wait,
  });

  guard.on("watch", ({ decision, forMs }) => {
    summary.watches += 1;
    scheduler.prioritize(decision.subject.userId, forMs);
    log(
      "watch",
      { subject: decision.subject, rule: decision.ruleId, top: decision.topScore, forMs },
      `${who(decision.subject)} ${decision.ruleId} top=${decision.topScore.toFixed(2)} → sampling faster for ${Math.round(forMs / 1000)} s`,
    );
  });

  guard.on("report", ({ decision, evidence: record, frame }) => {
    summary.reports += 1;
    if (reportHook) {
      const notice: ReportNotice = {
        ruleId: decision.ruleId,
        level: decision.level,
        offence: decision.offence,
        topScore: decision.topScore,
        label: decision.evidence[0]?.label ?? null,
        hits: decision.hits,
        frames: decision.frames,
        evidenceId: record?.id ?? null,
        image: { bytes: frame.image.bytes, mime: frame.image.mime },
        capturedAt: frame.capturedAt,
      };
      // Never blocks the loop, never takes the bot down.
      Promise.resolve()
        .then(() => reportHook(decision.subject, notice))
        .catch((err: unknown) => log("error", { message: `report hook: ${(err as Error).message ?? err}` }, `report hook failed: ${(err as Error).message ?? err}`));
    }
    if (record) summary.evidence.push(record.id);
    // Whoever was just reported is worth a closer look for a while.
    scheduler.prioritize(decision.subject.userId, 5 * 60_000);
    log(
      "report",
      { decision, evidence: record?.id ?? null },
      `${who(decision.subject)} ${decision.ruleId} ${decision.level}` +
        (decision.offence ? ` offence=${decision.offence}` : "") +
        ` top=${decision.topScore.toFixed(2)} (${decision.evidence[0]?.label ?? "?"}) hits=${decision.hits}/${decision.frames}` +
        (record ? ` evidence=${record.id}` : ""),
    );
  });

  guard.on("action", ({ decision, action, result }) => {
    summary.actions[result.outcome] = (summary.actions[result.outcome] ?? 0) + 1;
    log(
      "action",
      { subject: decision.subject, rule: decision.ruleId, action, result },
      `${who(decision.subject)} ${action.type} → ${result.outcome}${result.error ? ` (${result.error})` : ""}`,
    );
  });

  guard.on("error", (err) => log("error", { message: err.message }, err.message));

  // ── loop ──────────────────────────────────────────────────────────────────
  await guard.init();
  log(
    "start",
    { mode, dryRun, detectors: detectors.map((d) => d.name), source: source.id, fast: Boolean(opts.fast) },
    `mode=${mode}${dryRun ? " (dry run)" : ""} detectors=${detectors.map((d) => d.name).join(",")} source=${source.id}${opts.fast ? " clock=virtual" : ""}`,
  );

  let lastHousekeeping = now();
  try {
    while (!opts.signal?.aborted) {
      const worked = await scheduler.tick();
      if (opts.signal?.aborted) break;
      if (now() - lastHousekeeping >= HOUSEKEEPING_MS) {
        lastHousekeeping = now();
        guard.prune(now());
        const pruned = await evidence.prune(now());
        if (pruned) log("info", { prunedEvidence: pruned }, `evidence retention: removed ${pruned} record(s)`);
      }
      if (worked) continue;
      if (opts.once) {
        await scheduler.refresh();
        if (scheduler.active.length === 0) break;
      }
      await wait(Math.max(10, scheduler.nextDueIn()));
    }
  } finally {
    summary.cancelledActions = guard.pendingActions;
    await guard.close();
    await source.close?.();
  }

  summary.meanDetectMs = summary.frames ? detectMsTotal / summary.frames : 0;
  return summary;
}

export function formatSummary(s: RunSummary): string {
  const actions = Object.entries(s.actions)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `frames analysed: ${s.frames} (mean ${s.meanDetectMs.toFixed(1)} ms each)`,
    `watch hints: ${s.watches}`,
    `reports: ${s.reports}`,
    `actions: ${actions || "none"}`,
    `evidence saved: ${s.evidence.length}`,
    ...(s.cancelledActions ? [`delayed actions cancelled at stop: ${s.cancelledActions}`] : []),
  ].join("\n");
}
