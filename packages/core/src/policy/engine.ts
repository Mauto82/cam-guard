import type { ActionSpec, Detection, Subject } from "../types.js";
import { ruleFrames, type PolicyConfig, type Rule } from "./config.js";

/**
 * `act` and `report` are verdicts. `watch` is only a hint — something scored
 * above the rule's watch threshold — asking the scheduler to look again soon.
 */
export type DecisionLevel = "watch" | "report" | "act";

/** What the policy wants done about one frame. Pure data: nothing is executed here. */
export interface Decision {
  ruleId: string;
  profile: string;
  level: DecisionLevel;
  subject: Subject;
  actions: ActionSpec[];
  /** 1-based offence number within the rule's window (act level only; 0 otherwise). */
  offence: number;
  /** Detections that satisfied the rule on the deciding frame. */
  evidence: Detection[];
  topScore: number;
  /** Frames in the window that led here (hits and misses). */
  frames: number;
  /** How many of those frames hit. */
  hits: number;
  /** Only on `watch`: how long the user should be sampled more often. */
  watchForMs?: number;
  decidedAt: number;
}

export interface RuleCounters {
  reports: number;
  acts: number;
  warnings: number;
  /** Act-level offences still inside the window (all of them if the rule has none). */
  offencesInWindow: number;
  lastOffenceAt: number | null;
}

/** What moderators see about one user. */
export interface UserState {
  userId: string;
  lastSeen: number;
  rules: Record<string, RuleCounters>;
}

interface Streak {
  /** Hit/miss of the last `of` frames, oldest first. */
  ring: boolean[];
  /** Clean frames in a row, to tell when an episode is over. */
  missRun: number;
  fired: boolean;
  firedAt: number;
}

interface RuleMemory {
  report: Streak;
  act: Streak;
  /** Window of the rule as last evaluated; rule ids may repeat across profiles. */
  window: number | undefined;
  offences: number[];
  reports: number;
  acts: number;
  warnings: number;
  /** No `watch` hint before this time: one per half watch period is enough. */
  watchQuietUntil: number;
}

interface UserMemory {
  lastSeen: number;
  rules: Map<string, RuleMemory>;
}

const OFF = "off";

function newStreak(): Streak {
  return { ring: [], missRun: 0, fired: false, firedAt: 0 };
}

const hitCount = (s: Streak) => s.ring.reduce((n, h) => n + (h ? 1 : 0), 0);

function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function area(d: Detection): number {
  return Math.max(0, d.box.w) * Math.max(0, d.box.h);
}

/**
 * Advance a streak by one frame and say whether it fires now.
 *
 * Fires once when `hits` of the last `of` frames hit, then stays quiet while
 * the episode goes on — firing every frame would warn someone ten times in ten
 * seconds. The episode is over after `of - hits + 1` clean frames in a row
 * (for "3 consecutive" that is a single clean frame): past that, no window can
 * still be counting its hits. If it never ends, it re-arms after
 * `rearmAfter` and needs fresh hits, so ignoring a warning still escalates.
 */
function step(streak: Streak, hit: boolean, hits: number, of: number, rearmAfter: number, now: number): boolean {
  if (hit && streak.fired && now - streak.firedAt >= rearmAfter) {
    streak.fired = false;
    streak.ring = [];
    streak.missRun = 0;
  }
  streak.ring.push(hit);
  if (streak.ring.length > of) streak.ring.shift();
  streak.missRun = hit ? 0 : streak.missRun + 1;
  if (streak.fired && streak.missRun >= of - hits + 1) streak.fired = false;

  if (hit && !streak.fired && hitCount(streak) >= hits) {
    streak.fired = true;
    streak.firedAt = now;
    return true;
  }
  return false;
}

const LEVEL_ORDER: Record<DecisionLevel, number> = { act: 0, report: 1, watch: 2 };

/**
 * Turns detections into decisions, remembering per user what happened before.
 *
 * Deterministic: time comes from the frame (`capturedAt`), never from the
 * clock, so a replay of the same frames gives the same decisions.
 */
export class PolicyEngine {
  private readonly users = new Map<string, UserMemory>();
  private readonly overrides: [string, string][];

  constructor(private readonly config: PolicyConfig) {
    // Exact ids win over globs; among globs, the longest (most specific) wins.
    this.overrides = Object.entries(config.rooms.overrides).sort(([a], [b]) => {
      const aGlob = a.includes("*") ? 1 : 0;
      const bGlob = b.includes("*") ? 1 : 0;
      return aGlob - bGlob || b.length - a.length;
    });
  }

  /** Profile name that applies to a room, or null when moderation is off there. */
  profileFor(roomId: string): string | null {
    const hit = this.overrides.find(([pattern]) => globMatch(pattern, roomId));
    const name = hit ? hit[1] : this.config.rooms.default;
    return name === OFF ? null : name;
  }

  evaluate(subject: Subject, detections: readonly Detection[], capturedAt: number): Decision[] {
    const profileName = this.profileFor(subject.roomId);
    const user = this.user(subject.userId);
    user.lastSeen = Math.max(user.lastSeen, capturedAt);
    if (!profileName) return [];
    const profile = this.config.profiles[profileName];
    if (!profile) return [];

    const decisions: Decision[] = [];
    for (const rule of profile.rules) {
      const decision = this.evaluateRule(rule, profileName, subject, detections, capturedAt, user);
      if (decision) decisions.push(decision);
    }
    // Act-level first: an executor that stops at the first kick should not
    // have spent its time on a report about the same frame.
    return decisions.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  }

  private evaluateRule(
    rule: Rule,
    profile: string,
    subject: Subject,
    detections: readonly Detection[],
    now: number,
    user: UserMemory,
  ): Decision | null {
    const mem = this.ruleMemory(user, rule.id);
    mem.window = rule.act?.window;
    const candidates = detections.filter((d) => rule.labels.includes(d.label) && area(d) >= rule.minArea);

    const threshold = (d: Detection, level: "report" | "act"): number | undefined =>
      rule.perLabel[d.label]?.[level] ?? rule[level]?.threshold;
    const hitsAt = (level: "report" | "act") =>
      rule[level]
        ? candidates.filter((d) => {
            const t = threshold(d, level);
            return t !== undefined && d.score >= t;
          })
        : [];

    const actHits = hitsAt("act");
    const reportHits = hitsAt("report");
    const { hits, of } = ruleFrames(rule);

    const actFires = step(mem.act, actHits.length > 0, hits, of, rule.rearmAfter, now);
    const reportFires = step(mem.report, reportHits.length > 0, hits, of, rule.rearmAfter, now);

    if (actFires && rule.act) {
      const window = rule.act.window;
      if (window !== undefined) mem.offences = mem.offences.filter((t) => now - t < window);
      mem.offences.push(now);
      const offence = mem.offences.length;
      // Without a window there is no escalation: the count grows for the
      // moderators, the response stays the first step.
      const stepIndex = window === undefined ? 0 : Math.min(offence, rule.act.steps.length) - 1;
      const actions = rule.act.steps[stepIndex]!;
      mem.acts += 1;
      mem.warnings += actions.filter((a) => a.type === "warn").length;
      // The same streak must not also produce a separate report.
      mem.report.fired = true;
      mem.report.firedAt = now;
      return this.decision(rule, profile, "act", subject, actions, offence, actHits, mem.act, now);
    }

    if (reportFires && rule.report) {
      mem.reports += 1;
      return this.decision(rule, profile, "report", subject, rule.report.actions, 0, reportHits, mem.report, now);
    }

    if (rule.watch && now >= mem.watchQuietUntil) {
      const watchThreshold = rule.watch.threshold;
      const watchHits = candidates.filter((d) => d.score >= watchThreshold);
      if (watchHits.length > 0) {
        mem.watchQuietUntil = now + rule.watch.for / 2;
        const d = this.decision(rule, profile, "watch", subject, [], 0, watchHits, mem.report, now);
        d.watchForMs = rule.watch.for;
        return d;
      }
    }
    return null;
  }

  private decision(
    rule: Rule,
    profile: string,
    level: DecisionLevel,
    subject: Subject,
    actions: ActionSpec[],
    offence: number,
    evidence: Detection[],
    streak: Streak,
    now: number,
  ): Decision {
    const sorted = [...evidence].sort((a, b) => b.score - a.score);
    return {
      ruleId: rule.id,
      profile,
      level,
      subject,
      actions: actions.map((a) => ({ ...a })),
      offence,
      evidence: sorted,
      topScore: sorted[0]?.score ?? 0,
      frames: Math.max(1, streak.ring.length),
      hits: Math.max(1, hitCount(streak)),
      decidedAt: now,
    };
  }

  /** Counters for the moderators' view. */
  userState(userId: string, now?: number): UserState | null {
    const user = this.users.get(userId);
    if (!user) return null;
    const at = now ?? user.lastSeen;
    const rules: Record<string, RuleCounters> = {};
    for (const [ruleId, mem] of user.rules) {
      const window = mem.window;
      const inWindow = window === undefined ? mem.offences : mem.offences.filter((t) => at - t < window);
      rules[ruleId] = {
        reports: mem.reports,
        acts: mem.acts,
        warnings: mem.warnings,
        offencesInWindow: inWindow.length,
        lastOffenceAt: mem.offences.at(-1) ?? null,
      };
    }
    return { userId, lastSeen: user.lastSeen, rules };
  }

  /** Drop the whole memory of a user (e.g. after a moderator cleared them). */
  forget(userId: string): void {
    this.users.delete(userId);
  }

  /**
   * Forget users idle longer than `memory.idleTtl`, unless an offence of theirs
   * is still inside its window — forgetting it would reset their escalation.
   * Returns how many were dropped.
   */
  prune(now: number): number {
    const ttl = this.config.memory.idleTtl;
    let dropped = 0;
    for (const [userId, user] of this.users) {
      if (now - user.lastSeen < ttl) continue;
      const stillCounting = [...user.rules.values()].some(
        (mem) => mem.window !== undefined && mem.offences.some((t) => now - t < mem.window!),
      );
      if (stillCounting) continue;
      this.users.delete(userId);
      dropped += 1;
    }
    return dropped;
  }

  get trackedUsers(): number {
    return this.users.size;
  }

  private user(userId: string): UserMemory {
    let user = this.users.get(userId);
    if (!user) {
      user = { lastSeen: 0, rules: new Map() };
      this.users.set(userId, user);
    }
    return user;
  }

  private ruleMemory(user: UserMemory, ruleId: string): RuleMemory {
    let mem = user.rules.get(ruleId);
    if (!mem) {
      mem = {
        report: newStreak(),
        act: newStreak(),
        window: undefined,
        offences: [],
        reports: 0,
        acts: 0,
        warnings: 0,
        watchQuietUntil: Number.NEGATIVE_INFINITY,
      };
      user.rules.set(ruleId, mem);
    }
    return mem;
  }
}
