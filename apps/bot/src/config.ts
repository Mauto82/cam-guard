import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseDuration } from "@cam-guard/core";

const duration = z.union([z.number(), z.string()]).transform((value, ctx) => {
  try {
    return parseDuration(value);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
    return z.NEVER;
  }
});

const folderSource = z
  .object({
    folder: z.object({ dir: z.string(), loop: z.boolean().default(false) }).strict(),
  })
  .strict();

/** Any module whose default export is `(options) => Source | Promise<Source>`. */
const moduleSource = z
  .object({
    module: z.string(),
    options: z.record(z.unknown()).default({}),
  })
  .strict();

export const botConfigSchema = z
  .object({
    /** `report`: nothing is done to users, only reported. `auto`: adapters are called. */
    mode: z.enum(["report", "auto"]).default("report"),
    dryRun: z.boolean().default(false),
    /** Policy file (YAML/JSON), relative to this config. */
    policy: z.string(),
    evidence: z
      .object({
        dir: z.string(),
        retention: duration.default("30d"),
        confirmedRetention: duration.default("365d"),
      })
      .strict(),
    detector: z
      .object({
        nudenet: z
          .object({
            model: z.enum(["320n", "640m"]).default("320n"),
            channels: z.enum(["rgb", "bgr"]).default("rgb"),
            threads: z.number().int().positive().optional(),
            modelsDir: z.string().optional(),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    scheduler: z
      .object({
        interval: duration.default("10s"),
        priorityInterval: duration.default("2s"),
        refresh: duration.optional(),
      })
      .strict()
      .default({}),
    source: z.union([folderSource, moduleSource]),
    /**
     * Module exporting the platform adapters (`warn`, `closeCam`, `kick`,
     * `suspend`) as default export or named exports. Needed only in `auto`.
     */
    adapters: z.string().optional(),
    log: z
      .object({
        format: z.enum(["text", "json"]).default("text"),
        /** Also log every analysed frame, not only decisions. */
        detections: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();

export type BotConfig = z.output<typeof botConfigSchema>;

export class BotConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid bot config:\n  - ${issues.join("\n  - ")}`);
    this.name = "BotConfigError";
  }
}

/** Validate, and resolve every path against `baseDir` (the config file's folder). */
export function parseBotConfig(input: unknown, baseDir: string): BotConfig {
  const result = botConfigSchema.safeParse(input);
  if (!result.success) {
    throw new BotConfigError(result.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)));
  }
  const cfg = result.data;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  cfg.policy = abs(cfg.policy);
  cfg.evidence.dir = abs(cfg.evidence.dir);
  if (cfg.detector.nudenet.modelsDir) cfg.detector.nudenet.modelsDir = abs(cfg.detector.nudenet.modelsDir);
  if ("folder" in cfg.source) cfg.source.folder.dir = abs(cfg.source.folder.dir);
  else cfg.source.module = abs(cfg.source.module);
  if (cfg.adapters) cfg.adapters = abs(cfg.adapters);
  return cfg;
}

export async function loadBotConfig(path: string): Promise<BotConfig> {
  const text = await readFile(path, "utf8");
  const raw: unknown = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
  return parseBotConfig(raw, dirname(resolve(path)));
}
