import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadPolicyConfig,
  parseDuration,
  parsePolicyConfig,
  PolicyConfigError,
  PolicyEngine,
  unknownLabels,
  type PolicyConfig,
} from "../src/index.js";
import { det, HOUR, MIN, SEC, subject } from "./helpers.js";

const EXAMPLE = resolve(import.meta.dirname, "../../../policy.example.yaml");

const NUDITY = "FEMALE_BREAST_EXPOSED";

/** Feed `n` identical frames one second apart, starting at `t`. Returns all decisions. */
function feed(engine: PolicyEngine, n: number, t: number, detections = [det(NUDITY, 0.9)], s = subject()) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(...engine.evaluate(s, detections, t + i * SEC));
  return out;
}

describe("parseDuration", () => {
  it("parses units and plain numbers", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("5s")).toBe(5_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("1.5d")).toBe(129_600_000);
    expect(parseDuration(42)).toBe(42);
  });

  it("rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
    expect(() => parseDuration(-1)).toThrow();
  });
});

describe("policy config", () => {
  it("loads the example policy shipped in the README", async () => {
    const cfg = await loadPolicyConfig(EXAMPLE);
    expect(Object.keys(cfg.profiles)).toEqual(["strict", "adults"]);
    const adultsNudity = cfg.profiles.adults!.rules[0]!;
    expect(adultsNudity.act).toBeUndefined();
    expect(adultsNudity.report?.threshold).toBe(0.85);
    // The merge key kept everything else from the shared rule.
    expect(adultsNudity.consecutiveFrames).toBe(3);
    const child = cfg.profiles.strict!.rules[1]!;
    expect(child.act?.steps[0]).toContainEqual({ type: "kick", delayMs: 5_000, message: expect.any(String) });
  });

  it("refuses an automatic ban", () => {
    expect(() =>
      parsePolicyConfig({
        version: 1,
        profiles: { p: { rules: [{ id: "r", labels: ["X"], act: { threshold: 0.9, steps: [["ban"]] } }] } },
        rooms: { default: "p" },
      }),
    ).toThrow(/ban.*cannot be automatic/);
  });

  it("collects every problem in one error", () => {
    try {
      parsePolicyConfig({
        version: 1,
        profiles: {
          p: {
            rules: [
              { id: "r", labels: ["X"], report: { threshold: 0.9 }, act: { threshold: 0.5, steps: [["kick"]] } },
              { id: "r", labels: ["Y"] },
            ],
          },
        },
        rooms: { default: "nope" },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyConfigError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/act threshold \(0.5\) is below report threshold/);
      expect(msg).toMatch(/needs `report` and\/or `act`/);
      expect(msg).toMatch(/unknown profile "nope"/);
      expect(msg).toMatch(/duplicate rule id "r"/);
    }
  });

  it("requires hours on suspend", () => {
    expect(() =>
      parsePolicyConfig({
        version: 1,
        profiles: { p: { rules: [{ id: "r", labels: ["X"], act: { threshold: 0.9, steps: [["suspend"]] } }] } },
        rooms: { default: "p" },
      }),
    ).toThrow(/suspend.*needs `hours`/);
  });

  it("reports labels no detector knows", async () => {
    const cfg = await loadPolicyConfig(EXAMPLE);
    expect(unknownLabels(cfg, ["FEMALE_BREAST_EXPOSED", "CHILD_PRESENT"])).toEqual([
      "ANUS_EXPOSED",
      "BUTTOCKS_EXPOSED",
      "FEMALE_GENITALIA_EXPOSED",
      "MALE_GENITALIA_EXPOSED",
    ]);
  });
});

describe("PolicyEngine", () => {
  let cfg: PolicyConfig;
  const engine = () => new PolicyEngine(cfg);

  beforeAll(async () => {
    cfg = await loadPolicyConfig(EXAMPLE);
  });

  describe("room profiles", () => {
    it("resolves exact ids, globs and the default", () => {
      const e = engine();
      expect(e.profileFor("lobby")).toBe("strict");
      expect(e.profileFor("adults-late-night")).toBe("adults");
      expect(e.profileFor("test-room")).toBeNull();
    });

    it("does nothing in rooms where moderation is off", () => {
      expect(feed(engine(), 5, 0, [det(NUDITY, 0.99)], subject("u", "test-room"))).toEqual([]);
    });
  });

  describe("consecutive frames", () => {
    it("fires only on the third frame in a row", () => {
      const e = engine();
      expect(e.evaluate(subject(), [det(NUDITY, 0.9)], 0)).toEqual([]);
      expect(e.evaluate(subject(), [det(NUDITY, 0.9)], SEC)).toEqual([]);
      const [d] = e.evaluate(subject(), [det(NUDITY, 0.9)], 2 * SEC);
      expect(d).toMatchObject({ ruleId: "explicit-nudity", level: "act", offence: 1, frames: 3 });
    });

    it("a clean frame resets the streak", () => {
      const e = engine();
      feed(e, 2, 0);
      e.evaluate(subject(), [], 2 * SEC);
      expect(feed(e, 2, 3 * SEC)).toEqual([]);
      expect(feed(e, 1, 5 * SEC)).toHaveLength(1);
    });

    it("streaks are per user", () => {
      const e = engine();
      feed(e, 2, 0, undefined, subject("alice"));
      expect(feed(e, 2, 10 * SEC, undefined, subject("bob"))).toEqual([]);
    });
  });

  describe("thresholds and area", () => {
    it("between report and act thresholds: report only", () => {
      const decisions = feed(engine(), 3, 0, [det(NUDITY, 0.7)]);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ level: "report", actions: [{ type: "report" }], offence: 0 });
    });

    it("below report threshold: nothing", () => {
      expect(feed(engine(), 5, 0, [det(NUDITY, 0.59)])).toEqual([]);
    });

    it("boxes under minArea do not count", () => {
      // 0.04 × 0.04 = 0.0016 < minArea 0.002
      expect(feed(engine(), 5, 0, [det(NUDITY, 0.99, 0.04, 0.04)])).toEqual([]);
    });

    it("labels outside the rule do not count", () => {
      expect(feed(engine(), 5, 0, [det("FACE_FEMALE", 0.99), det("FEMALE_BREAST_COVERED", 0.99)])).toEqual([]);
    });

    it("perLabel overrides the rule threshold", () => {
      const e = new PolicyEngine(
        parsePolicyConfig({
          version: 1,
          profiles: {
            p: {
              rules: [
                {
                  id: "r",
                  labels: ["A", "B"],
                  report: { threshold: 0.5 },
                  perLabel: { B: { report: 0.95 } },
                },
              ],
            },
          },
          rooms: { default: "p" },
        }),
      );
      expect(e.evaluate(subject(), [det("B", 0.9)], 0)).toEqual([]);
      expect(e.evaluate(subject(), [det("A", 0.9)], SEC)).toHaveLength(1);
    });

    it("evidence is sorted by score and topScore is the best one", () => {
      const [d] = feed(engine(), 3, 0, [det(NUDITY, 0.86), det("BUTTOCKS_EXPOSED", 0.97)]);
      expect(d!.topScore).toBe(0.97);
      expect(d!.evidence.map((x) => x.label)).toEqual(["BUTTOCKS_EXPOSED", NUDITY]);
    });
  });

  describe("firing and re-arming", () => {
    it("fires once per streak, not on every frame", () => {
      expect(feed(engine(), 30, 0)).toHaveLength(1);
    });

    it("an act does not also produce a report for the same streak", () => {
      const decisions = feed(engine(), 10, 0);
      expect(decisions.map((d) => d.level)).toEqual(["act"]);
    });

    it("re-arms after rearmAfter if the streak never ends", () => {
      // 90 frames over 90 s: fires at 2 s, re-arms at ≥62 s, fires again 3 frames later.
      const decisions = feed(engine(), 90, 0);
      expect(decisions).toHaveLength(2);
      expect(decisions[1]!.offence).toBe(2);
      expect(decisions[1]!.decidedAt).toBe(64 * SEC);
    });
  });

  describe("escalation", () => {
    it("second offence within 24 h kicks and suspends", () => {
      const e = engine();
      const [first] = feed(e, 3, 0);
      expect(first!.actions.map((a) => a.type)).toEqual(["report", "close_cam", "warn"]);
      e.evaluate(subject(), [], 3 * SEC); // camera closed, streak over
      const [second] = feed(e, 3, 10 * MIN);
      expect(second!.offence).toBe(2);
      expect(second!.actions.map((a) => a.type)).toEqual(["report", "kick", "suspend"]);
      expect(second!.actions.find((a) => a.type === "suspend")?.hours).toBe(24);
    });

    it("the last step repeats for later offences", () => {
      const e = engine();
      for (let i = 0; i < 4; i++) {
        feed(e, 3, i * HOUR);
        e.evaluate(subject(), [], i * HOUR + 10 * SEC);
      }
      const [fifth] = feed(e, 3, 5 * HOUR);
      expect(fifth!.offence).toBe(5);
      expect(fifth!.actions.map((a) => a.type)).toEqual(["report", "kick", "suspend"]);
    });

    it("an offence older than the window no longer counts", () => {
      const e = engine();
      feed(e, 3, 0);
      e.evaluate(subject(), [], 10 * SEC);
      const [later] = feed(e, 3, 25 * HOUR);
      expect(later!.offence).toBe(1);
      expect(later!.actions.map((a) => a.type)).toContain("close_cam");
    });

    it("a rule without window never escalates but keeps counting", () => {
      const e = engine();
      const child = [det("CHILD_PRESENT", 0.9)];
      for (let i = 0; i < 3; i++) {
        const [d] = feed(e, 3, i * HOUR, child);
        expect(d!.offence).toBe(i + 1);
        expect(d!.actions).toEqual([
          { type: "report" },
          { type: "warn", message: expect.any(String) },
          { type: "kick", delayMs: 5_000, message: expect.any(String) },
        ]);
        e.evaluate(subject(), [], i * HOUR + 10 * SEC);
      }
      expect(e.userState("u1")!.rules["child-present"]).toMatchObject({ acts: 3, offencesInWindow: 3, warnings: 3 });
    });

    it("in an adults room nudity is only reported, never acted on", () => {
      const decisions = feed(engine(), 30, 0, [det(NUDITY, 0.99)], subject("u", "adults-1"));
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.level).toBe("report");
    });

    it("in an adults room a child is still acted on", () => {
      const [d] = feed(engine(), 3, 0, [det("CHILD_PRESENT", 0.9)], subject("u", "adults-1"));
      expect(d!.level).toBe("act");
    });
  });

  describe("memory", () => {
    it("userState exposes counters", () => {
      const e = engine();
      feed(e, 3, 0, [det(NUDITY, 0.7)]);
      expect(e.userState("u1")).toMatchObject({
        userId: "u1",
        lastSeen: 2 * SEC,
        rules: { "explicit-nudity": { reports: 1, acts: 0, offencesInWindow: 0, lastOffenceAt: null } },
      });
      expect(e.userState("nobody")).toBeNull();
    });

    it("prune forgets idle users but not those whose offences still count", () => {
      const e = engine();
      feed(e, 3, 0, undefined, subject("offender"));
      e.evaluate(subject("idle"), [], 0);
      expect(e.trackedUsers).toBe(2);
      // 20 h: under idleTtl (48 h) — nobody goes.
      expect(e.prune(20 * HOUR)).toBe(0);
      // 49 h: idle is over TTL; offender's offence (24 h window) has expired too.
      expect(e.prune(49 * HOUR)).toBe(2);
    });

    it("prune keeps a user idle past the TTL while an offence is inside its window", () => {
      const e = new PolicyEngine({ ...cfg, memory: { idleTtl: HOUR } });
      feed(e, 3, 0);
      expect(e.prune(2 * HOUR)).toBe(0);
      expect(e.prune(25 * HOUR)).toBe(1);
    });

    it("forget drops everything about a user", () => {
      const e = engine();
      feed(e, 3, 0);
      e.forget("u1");
      expect(e.userState("u1")).toBeNull();
      const [d] = feed(e, 3, 10 * SEC);
      expect(d!.offence).toBe(1);
    });
  });

  it("is deterministic: same frames, same decisions", () => {
    const run = () => {
      const e = engine();
      return [...feed(e, 5, 0), ...feed(e, 5, HOUR, [det(NUDITY, 0.7)]), ...feed(e, 90, 2 * HOUR)];
    };
    expect(run()).toEqual(run());
  });
});
