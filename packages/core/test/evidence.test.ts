import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceStore, type Decision } from "../src/index.js";
import { det, HOUR, PIXEL_PNG, subject } from "./helpers.js";

const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 13, 12, 0, 0);

const decision = (over: Partial<Decision> = {}): Decision => ({
  ruleId: "explicit-nudity",
  profile: "strict",
  level: "act",
  subject: subject(),
  actions: [{ type: "report" }, { type: "close_cam" }],
  offence: 1,
  evidence: [det("FEMALE_BREAST_EXPOSED", 0.9)],
  topScore: 0.9,
  frames: 2,
  decidedAt: T0,
  ...over,
});

describe("EvidenceStore", () => {
  let dir: string;
  let store: EvidenceStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cam-guard-evidence-"));
    store = new EvidenceStore({ dir, retentionMs: 30 * DAY, confirmedRetentionMs: 365 * DAY });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const save = (createdAt = T0, over: Partial<Decision> = {}) =>
    store.save({
      decision: decision({ decidedAt: createdAt, ...over }),
      frames: [
        { image: PIXEL_PNG, capturedAt: createdAt - 1_000, detections: [] },
        { image: PIXEL_PNG, capturedAt: createdAt, detections: [det("FEMALE_BREAST_EXPOSED", 0.9)] },
      ],
      detectors: ["nudenet-320n"],
      createdAt,
    });

  it("writes event.json and frames under a dated directory", async () => {
    const rec = await save();
    expect(rec.id).toMatch(/^\d{13}-[0-9a-f]{8}$/);
    const files = await readdir(join(dir, "2026-09-13", rec.id));
    expect(files.sort()).toEqual(["event.json", "frame-0.png", "frame-1.png"]);
    expect(rec.review.status).toBe("pending");
  });

  it("reads a record and its frames back", async () => {
    const rec = await save();
    expect(await store.get(rec.id)).toEqual(rec);
    const frame = await store.readFrame(rec.id, 1);
    expect(frame?.mime).toBe("image/png");
    expect(Buffer.from(frame!.bytes).equals(Buffer.from(PIXEL_PNG.bytes))).toBe(true);
    expect(await store.readFrame(rec.id, 9)).toBeNull();
  });

  it("refuses ids that are not ids (no path traversal)", async () => {
    expect(await store.get("../../etc/passwd")).toBeNull();
  });

  it("lists newest first with filters", async () => {
    const a = await save(T0, { subject: subject("alice", "lobby") });
    const b = await save(T0 + HOUR, { subject: subject("bob", "lobby"), level: "report" });
    const c = await save(T0 + DAY, { subject: subject("alice", "adults-1") });

    expect((await store.list()).map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect((await store.list({ userId: "alice" })).map((r) => r.id)).toEqual([c.id, a.id]);
    expect((await store.list({ roomId: "lobby", level: "report" })).map((r) => r.id)).toEqual([b.id]);
    expect((await store.list({ from: T0 + 1, to: T0 + DAY })).map((r) => r.id)).toEqual([b.id]);
    expect(await store.list({ limit: 1 })).toHaveLength(1);
  });

  it("records reviews and action results", async () => {
    const rec = await save();
    await store.appendActions(rec.id, [{ type: "close_cam", outcome: "done", at: T0 }]);
    const reviewed = await store.review(rec.id, "false_positive", { by: "mod1", note: "a sofa", at: T0 + 5 });
    expect(reviewed.actions).toEqual([{ type: "close_cam", outcome: "done", at: T0 }]);
    expect(reviewed.review).toEqual({ status: "false_positive", by: "mod1", note: "a sofa", at: T0 + 5 });
    expect((await store.list({ review: "false_positive" })).map((r) => r.id)).toEqual([rec.id]);
  });

  it("prunes by retention, keeping confirmed cases longer", async () => {
    const old = await save(T0);
    const oldConfirmed = await save(T0 + 1);
    await store.review(oldConfirmed.id, "confirmed");
    const fresh = await save(T0 + 40 * DAY);

    expect(await store.prune(T0 + 41 * DAY)).toBe(1);
    expect(await store.get(old.id)).toBeNull();
    expect(await store.get(oldConfirmed.id)).not.toBeNull();
    expect(await store.get(fresh.id)).not.toBeNull();

    expect(await store.prune(T0 + 400 * DAY)).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it("an empty or missing directory lists nothing", async () => {
    const empty = new EvidenceStore({ dir: join(dir, "does-not-exist") });
    expect(await empty.list()).toEqual([]);
    expect(await empty.prune()).toBe(0);
  });
});
