#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { NudeNetModel } from "@cam-guard/detector-nudenet";
import { loadBotConfig } from "./config.js";
import { detectFiles, formatReport } from "./detect.js";
import { formatSummary, runBot } from "./run.js";

const USAGE = `cam-guard — local webcam moderation

Usage:
  cam-guard run --config bot.yaml [--mode report|auto] [--dry-run] [--fast] [--once]
  cam-guard detect <image...> [--model 320n|640m] [--runs N] [--threads N] [--channels rgb|bgr] [--json]

Commands:
  run       Run the moderation loop described by a config file: source →
            detector → policy → evidence → actions. Stop with Ctrl-C.
  detect    Run NudeNet on still images and print detections and timings.
            The model is downloaded on first use and checked by sha256.

Options for run:
  --config    bot config (YAML/JSON); see examples/bot.yaml
  --mode      override the config: report (only report) or auto (call adapters)
  --dry-run   resolve every action as a dry run
  --fast      virtual clock: replay a folder source without real waiting
  --once      stop when no camera is left instead of waiting for new ones

Options for detect:
  --model     320n (default, fast) or 640m (needs GITHUB_TOKEN to download)
  --runs      timed runs per image after one warm-up run (default 5)
  --threads   ONNX Runtime intra-op threads (default: runtime decides)
  --channels  rgb (default, what the model was trained on) or bgr (same scores
              as the upstream Python package, which feeds BGR)
  --json      machine-readable output
  -h, --help  this help

Environment:
  CAM_GUARD_MODELS_DIR   where models are cached (default ~/.cache/cam-guard/models)
  GITHUB_TOKEN           needed only to download the 640m model
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  if (command === "run") return run(rest);
  if (command !== "detect") {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      model: { type: "string", default: "320n" },
      runs: { type: "string", default: "5" },
      threads: { type: "string" },
      channels: { type: "string", default: "rgb" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length === 0) {
    process.stderr.write("detect: give at least one image\n");
    return 1;
  }
  if (values.model !== "320n" && values.model !== "640m") {
    process.stderr.write(`detect: --model must be 320n or 640m, not "${values.model}"\n`);
    return 1;
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 0) {
    process.stderr.write("detect: --runs must be a non-negative integer\n");
    return 1;
  }
  const threads = values.threads !== undefined ? Number(values.threads) : undefined;
  if (threads !== undefined && (!Number.isInteger(threads) || threads < 1)) {
    process.stderr.write("detect: --threads must be a positive integer\n");
    return 1;
  }

  if (values.channels !== "rgb" && values.channels !== "bgr") {
    process.stderr.write(`detect: --channels must be rgb or bgr, not "${values.channels}"\n`);
    return 1;
  }

  const reports = await detectFiles(positionals, {
    model: values.model as NudeNetModel,
    runs,
    channelOrder: values.channels,
    ...(threads !== undefined ? { threads } : {}),
    log: (m) => process.stderr.write(`${m}\n`),
  });

  if (values.json) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  else process.stdout.write(`${reports.map(formatReport).join("\n\n")}\n`);
  return 0;
}

async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string", short: "c" },
      mode: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      fast: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.config) {
    process.stderr.write("run: --config is required\n");
    return 1;
  }
  if (values.mode !== undefined && values.mode !== "report" && values.mode !== "auto") {
    process.stderr.write(`run: --mode must be report or auto, not "${values.mode}"\n`);
    return 1;
  }

  const config = await loadBotConfig(values.config);
  const controller = new AbortController();
  let interrupts = 0;
  const stop = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130); // second Ctrl-C: don't wait for pending actions
    process.stderr.write("stopping… (Ctrl-C again to force)\n");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const summary = await runBot(config, {
    ...(values.mode ? { mode: values.mode as "report" | "auto" } : {}),
    ...(values["dry-run"] ? { dryRun: true } : {}),
    fast: values.fast,
    once: values.once,
    signal: controller.signal,
  });
  process.stderr.write(`\n${formatSummary(summary)}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`cam-guard: ${(err as Error).message ?? err}\n`);
    process.exitCode = 1;
  },
);
