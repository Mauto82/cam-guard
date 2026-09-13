import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ActionSpec } from "../types.js";
import { parseDuration } from "./duration.js";

const ACTION_TYPES = ["report", "warn", "close_cam", "kick", "suspend"] as const;

const duration = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    try {
      return parseDuration(value);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
      return z.NEVER;
    }
  });

const score = z.number().min(0).max(1);

const actionObject = z
  .object({
    type: z.string(),
    delay: duration.optional(),
    message: z.string().optional(),
    hours: z.number().positive().optional(),
  })
  .strict();

/**
 * An action is either a bare name (`kick`) or an object
 * (`{ type: kick, delay: 5s }`). `ban` is refused here, at load time, rather
 * than silently ignored at run time: a config that asks for an automatic ban
 * is a config whose author misunderstands what the library will do.
 */
const action = z.union([z.string(), actionObject]).transform((raw, ctx): ActionSpec => {
  const obj = typeof raw === "string" ? { type: raw } : raw;
  if (obj.type === "ban") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`ban` cannot be automatic: permanent bans are taken by a human from the dashboard",
    });
    return z.NEVER;
  }
  if (!(ACTION_TYPES as readonly string[]).includes(obj.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unknown action "${obj.type}" (expected one of ${ACTION_TYPES.join(", ")})`,
    });
    return z.NEVER;
  }
  const spec: ActionSpec = { type: obj.type as ActionSpec["type"] };
  if ("delay" in obj && obj.delay !== undefined) spec.delayMs = obj.delay;
  if ("message" in obj && obj.message !== undefined) spec.message = obj.message;
  if ("hours" in obj && obj.hours !== undefined) spec.hours = obj.hours;
  if (spec.type === "suspend" && spec.hours === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`suspend` needs `hours`" });
    return z.NEVER;
  }
  return spec;
});

const actionList = z.array(action).min(1);

const ruleSchema = z
  .object({
    id: z.string().min(1),
    labels: z.array(z.string().min(1)).min(1),
    /** Smallest box that counts, as a fraction of the frame area (0..1). */
    minArea: score.default(0),
    /** Frames in a row that must hit before anything fires. Shorthand for `frames: { hits: N, of: N }`. */
    consecutiveFrames: z.number().int().min(1).optional(),
    /**
     * Fire when `hits` of the last `of` frames hit. Unlike consecutive frames
     * it tolerates gaps — someone walking in and out of shot, a detection
     * that flickers — without restarting the count.
     */
    frames: z
      .object({ hits: z.number().int().min(1), of: z.number().int().min(1) })
      .strict()
      .optional(),
    /**
     * Below the report threshold, a hint that something may be there: the
     * engine emits a `watch` decision so the scheduler samples this user more
     * often for `for`, and a real case is confirmed in seconds instead of
     * waiting for the next round.
     */
    watch: z
      .object({ threshold: score, for: duration.default(120_000) })
      .strict()
      .optional(),
    /**
     * While a streak keeps hitting after firing, fire again only after this
     * long. Without it a user who ignores a warning would never escalate,
     * because the streak that triggered the warning never ends.
     */
    rearmAfter: duration.default(60_000),
    report: z
      .object({
        threshold: score,
        actions: actionList.default(["report"]),
      })
      .strict()
      .optional(),
    act: z
      .object({
        threshold: score,
        /**
         * Offences are counted within this window to pick the escalation step.
         * Omitted: no escalation — every offence runs the first step, and the
         * count is only kept for moderators.
         */
        window: duration.optional(),
        /** steps[n] runs on the (n+1)-th offence in the window; the last repeats. */
        steps: z.array(actionList).min(1),
      })
      .strict()
      .optional(),
    /** Per-label overrides of the report/act thresholds. */
    perLabel: z
      .record(z.object({ report: score.optional(), act: score.optional() }).strict())
      .default({}),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.consecutiveFrames !== undefined && rule.frames) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `rule "${rule.id}": use \`consecutiveFrames\` or \`frames\`, not both` });
    }
    if (rule.frames && rule.frames.hits > rule.frames.of) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rule "${rule.id}": frames.hits (${rule.frames.hits}) cannot exceed frames.of (${rule.frames.of})`,
      });
    }
    const lowest = Math.min(rule.report?.threshold ?? 1, rule.act?.threshold ?? 1);
    if (rule.watch && rule.watch.threshold > lowest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rule "${rule.id}": watch threshold (${rule.watch.threshold}) is above the report/act threshold (${lowest})`,
      });
    }
    if (!rule.report && !rule.act) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `rule "${rule.id}" needs \`report\` and/or \`act\`` });
    }
    if (rule.report && rule.act && rule.act.threshold < rule.report.threshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rule "${rule.id}": act threshold (${rule.act.threshold}) is below report threshold (${rule.report.threshold})`,
      });
    }
    for (const label of Object.keys(rule.perLabel)) {
      if (!rule.labels.includes(label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rule "${rule.id}": perLabel "${label}" is not in labels`,
        });
      }
    }
  });
// No `.transform` here on purpose: a transform after a failed refinement makes
// zod abort the parent, and the config-level checks (unknown profiles,
// duplicate ids) would then go unreported. See `ruleFrames`.

/**
 * `report: null` / `act: null` mean "this rule does not do that here" — how a
 * profile switches off half of a rule it inherited through a YAML merge key.
 */
const ruleInput = z.preprocess((raw) => {
  if (raw && typeof raw === "object") {
    const copy = { ...(raw as Record<string, unknown>) };
    for (const k of ["report", "act"]) if (copy[k] === null) delete copy[k];
    return copy;
  }
  return raw;
}, ruleSchema);

const profileSchema = z.object({ rules: z.array(ruleInput) }).strict();

export const policyConfigSchema = z
  .object({
    version: z.literal(1),
    profiles: z.record(profileSchema),
    rooms: z
      .object({
        /** Profile for rooms not matched below. `off` disables moderation. */
        default: z.string(),
        /** Room id (or `prefix*` glob) → profile name or `off`. */
        overrides: z.record(z.string()).default({}),
      })
      .strict(),
    memory: z
      .object({
        /** Forget users not seen for this long (never before their window expires). */
        idleTtl: duration.default(48 * 3_600_000),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const known = (name: string) => name === "off" || name in cfg.profiles;
    if (!known(cfg.rooms.default)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `rooms.default: unknown profile "${cfg.rooms.default}"` });
    }
    for (const [room, profile] of Object.entries(cfg.rooms.overrides)) {
      if (!known(profile)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `rooms.overrides["${room}"]: unknown profile "${profile}"` });
      }
    }
    for (const [name, profile] of Object.entries(cfg.profiles)) {
      const ids = profile.rules.map((r) => r.id);
      const dup = ids.find((id, i) => ids.indexOf(id) !== i);
      if (dup) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `profile "${name}": duplicate rule id "${dup}"` });
    }
  });

export type PolicyConfig = z.output<typeof policyConfigSchema>;
export type PolicyConfigInput = z.input<typeof policyConfigSchema>;
export type Rule = z.output<typeof ruleSchema>;

/** The frame window a rule needs: `frames`, or `consecutiveFrames` as N of N (default 1 of 1). */
export function ruleFrames(rule: Rule): { hits: number; of: number } {
  if (rule.frames) return rule.frames;
  const n = rule.consecutiveFrames ?? 1;
  return { hits: n, of: n };
}

export class PolicyConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid policy config:\n  - ${issues.join("\n  - ")}`);
    this.name = "PolicyConfigError";
  }
}

/** Validate an already-parsed object. */
export function parsePolicyConfig(input: unknown): PolicyConfig {
  const result = policyConfigSchema.safeParse(stripExtensions(input));
  if (!result.success) {
    throw new PolicyConfigError(
      result.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)),
    );
  }
  return result.data;
}

/** Top-level `x-*` keys are free-form (anchors live there), as in docker compose. */
function stripExtensions(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([k]) => !k.startsWith("x-")));
}

/** Load a policy from a `.yaml`/`.yml` or `.json` file. */
export async function loadPolicyConfig(path: string): Promise<PolicyConfig> {
  const text = await readFile(path, "utf8");
  const ext = extname(path).toLowerCase();
  // `merge: true` enables YAML `<<:` merge keys, how profiles reuse rules.
  const raw: unknown = ext === ".json" ? JSON.parse(text) : parseYaml(text, { merge: true });
  return parsePolicyConfig(raw);
}

/**
 * Labels referenced by the policy that no configured detector can emit.
 * A typo in a label name otherwise disables that rule without a word.
 */
export function unknownLabels(config: PolicyConfig, knownLabels: Iterable<string>): string[] {
  const known = new Set(knownLabels);
  const missing = new Set<string>();
  for (const profile of Object.values(config.profiles)) {
    for (const rule of profile.rules) {
      for (const label of rule.labels) if (!known.has(label)) missing.add(label);
    }
  }
  return [...missing].sort();
}
