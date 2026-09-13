import type { ActionSpec, Detection, Subject } from "../types.js";
import type { PolicyConfig, Rule } from "./config.js";

export type DecisionLevel = "report" | "act";

/** What the policy wants done about one frame. Pure data: nothing is executed here. */
export interface Decision {
  ruleId: string;
  profile: string;
  level: DecisionLevel;
  subject: Subject;
  actions: ActionSpec[];
  /** 1-based offence number within the rule's window (act level only; 0 for reports). */
  offence: number;
  /** Detections that satisfied the rule on the deciding frame. */
  evidence: Detection[];
  topScore: number;
  /** Consecutive frames that led here. */
  frames: number;
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
  count: number;
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
}

interface UserMemory {
  lastSeen: number;
  rules: Map<string, RuleMemory>;
}

const OFF = "off";

function newStreak(): Streak {
  return { count: 0, fired: false, firedAt: 0 };
}

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
 * A streak fires once when it reaches `need` frames, then stays quiet while it
 * keeps hitting — firing every frame would warn someone ten times in ten
 * seconds. After `rearmAfter` it re-arms and needs `need` fresh frames again,
 * so persisting after a warning does eventually escalate.
 */
function step(streak: Streak, hit: boolean, need: number, rearmAfter: number, now: number): boolean {
  if (!hit) {
    streak.count = 0;
    streak.fired = false;
    return false;
  }
  if (streak.fired && now - streak.firedAt >= rearmAfter) {
    streak.fired = false;
    streak.count = 0;
  }
  streak.count += 1;
  if (!streak.fired && streak.count >= need) {
    streak.fired = true;
    streak.firedAt = now;
    return true;
  }
  return false;
}

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
    return decisions.sort((a, b) => (a.level === b.level ? 0 : a.level === "act" ? -1 : 1));
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

    const threshold = (d: Detection, level: DecisionLevel): number | undefined =>
      rule.perLabel[d.label]?.[level] ?? rule[level]?.threshold;
    const hitsAt = (level: DecisionLevel) =>
      rule[level]
        ? candidates.filter((d) => {
            const t = threshold(d, level);
            return t !== undefined && d.score >= t;
          })
        : [];

    const actHits = hitsAt("act");
    const reportHits = hitsAt("report");
    const need = rule.consecutiveFrames;

    const actFires = step(mem.act, actHits.length > 0, need, rule.rearmAfter, now);
    const reportFires = step(mem.report, reportHits.length > 0, need, rule.rearmAfter, now);

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
      return this.decision(rule, profile, "act", subject, actions, offence, actHits, mem.act.count, now);
    }

    if (reportFires && rule.report) {
      mem.reports += 1;
      return this.decision(rule, profile, "report", subject, rule.report.actions, 0, reportHits, mem.report.count, now);
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
    frames: number,
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
      frames,
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
      mem = { report: newStreak(), act: newStreak(), window: undefined, offences: [], reports: 0, acts: 0, warnings: 0 };
      user.rules.set(ruleId, mem);
    }
    return mem;
  }
}
