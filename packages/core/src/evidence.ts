import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Decision } from "./policy/engine.js";
import type { ActionType, Detection, EncodedImage, ImageMime } from "./types.js";

export type ReviewStatus = "pending" | "confirmed" | "false_positive" | "banned";

export type ActionOutcome = "done" | "failed" | "skipped" | "dry_run" | "report_only";

export interface ActionResult {
  type: ActionType;
  outcome: ActionOutcome;
  at: number;
  error?: string;
}

export interface EvidenceFrame {
  image: EncodedImage;
  capturedAt: number;
  detections: Detection[];
}

export interface EvidenceFrameMeta {
  file: string;
  mime: ImageMime;
  capturedAt: number;
  detections: Detection[];
}

export interface EvidenceRecord {
  id: string;
  createdAt: number;
  decision: Decision;
  detectors: string[];
  frames: EvidenceFrameMeta[];
  actions: ActionResult[];
  review: {
    status: ReviewStatus;
    at?: number;
    by?: string;
    note?: string;
  };
}

export interface EvidenceFilter {
  userId?: string;
  roomId?: string;
  ruleId?: string;
  level?: Decision["level"];
  review?: ReviewStatus;
  /** Epoch ms, inclusive. */
  from?: number;
  /** Epoch ms, exclusive. */
  to?: number;
  limit?: number;
}

export interface EvidenceStoreOptions {
  /** Directory that holds the evidence. Created if missing. */
  dir: string;
  /** Delete records older than this (default 30 days). */
  retentionMs?: number;
  /**
   * Records a moderator confirmed (or banned on) are kept this long instead —
   * they may be needed to answer an appeal or the authorities. Default 1 year.
   */
  confirmedRetentionMs?: number;
}

const DAY = 86_400_000;
const EXT: Record<ImageMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const ID_PATTERN = /^\d{13}-[0-9a-f]{8}$/;

/**
 * Evidence of sanctioned cases on local disk: one directory per event with
 * `event.json` and the frames that led to the decision.
 *
 * Only frames that produced a decision ever reach this store; everything else
 * the pipeline analyses is discarded in memory.
 *
 *   <dir>/2026-09-13/1757779200000-a1b2c3d4/event.json
 *                                          /frame-0.jpg …
 */
export class EvidenceStore {
  private readonly retentionMs: number;
  private readonly confirmedRetentionMs: number;

  constructor(private readonly opts: EvidenceStoreOptions) {
    this.retentionMs = opts.retentionMs ?? 30 * DAY;
    this.confirmedRetentionMs = opts.confirmedRetentionMs ?? 365 * DAY;
  }

  async save(input: {
    decision: Decision;
    frames: EvidenceFrame[];
    detectors: string[];
    actions?: ActionResult[];
    createdAt?: number;
  }): Promise<EvidenceRecord> {
    const createdAt = input.createdAt ?? Date.now();
    const id = `${String(createdAt).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
    const dir = this.dirOf(id);
    await mkdir(dir, { recursive: true });

    const frames: EvidenceFrameMeta[] = [];
    for (const [i, frame] of input.frames.entries()) {
      const file = `frame-${i}.${EXT[frame.image.mime]}`;
      await writeFile(join(dir, file), frame.image.bytes);
      frames.push({ file, mime: frame.image.mime, capturedAt: frame.capturedAt, detections: frame.detections });
    }

    const record: EvidenceRecord = {
      id,
      createdAt,
      decision: input.decision,
      detectors: input.detectors,
      frames,
      actions: input.actions ?? [],
      review: { status: "pending" },
    };
    await this.write(record);
    return record;
  }

  async get(id: string): Promise<EvidenceRecord | null> {
    if (!ID_PATTERN.test(id)) return null;
    try {
      return JSON.parse(await readFile(join(this.dirOf(id), "event.json"), "utf8")) as EvidenceRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async readFrame(id: string, index: number): Promise<{ bytes: Buffer; mime: ImageMime } | null> {
    const record = await this.get(id);
    const meta = record?.frames[index];
    if (!meta) return null;
    return { bytes: await readFile(join(this.dirOf(id), meta.file)), mime: meta.mime };
  }

  /** Newest first. */
  async list(filter: EvidenceFilter = {}): Promise<EvidenceRecord[]> {
    const out: EvidenceRecord[] = [];
    for (const id of await this.ids()) {
      const createdAt = Number(id.slice(0, 13));
      if (filter.to !== undefined && createdAt >= filter.to) continue;
      if (filter.from !== undefined && createdAt < filter.from) break; // ids are sorted newest first
      const record = await this.get(id);
      if (!record || !matches(record, filter)) continue;
      out.push(record);
      if (filter.limit !== undefined && out.length >= filter.limit) break;
    }
    return out;
  }

  async review(id: string, status: ReviewStatus, meta: { by?: string; note?: string; at?: number } = {}): Promise<EvidenceRecord> {
    const record = await this.require(id);
    record.review = { status, at: meta.at ?? Date.now() };
    if (meta.by !== undefined) record.review.by = meta.by;
    if (meta.note !== undefined) record.review.note = meta.note;
    await this.write(record);
    return record;
  }

  async appendActions(id: string, results: ActionResult[]): Promise<EvidenceRecord> {
    const record = await this.require(id);
    record.actions.push(...results);
    await this.write(record);
    return record;
  }

  /** Delete what retention allows. Returns the number of records removed. */
  async prune(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const id of await this.ids()) {
      const createdAt = Number(id.slice(0, 13));
      if (now - createdAt < this.retentionMs) continue;
      const record = await this.get(id);
      const kept = record?.review.status === "confirmed" || record?.review.status === "banned";
      if (kept && now - createdAt < this.confirmedRetentionMs) continue;
      await rm(this.dirOf(id), { recursive: true, force: true });
      removed += 1;
    }
    await this.removeEmptyDays();
    return removed;
  }

  private async require(id: string): Promise<EvidenceRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`evidence ${id} not found`);
    return record;
  }

  /** Written to a temp file and renamed, so a crash never leaves half a JSON. */
  private async write(record: EvidenceRecord): Promise<void> {
    const dir = this.dirOf(record.id);
    const tmp = join(dir, `.event.json.${process.pid}.tmp`);
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tmp, join(dir, "event.json"));
  }

  private dirOf(id: string): string {
    const day = new Date(Number(id.slice(0, 13))).toISOString().slice(0, 10);
    return join(this.opts.dir, day, id);
  }

  private async ids(): Promise<string[]> {
    const days = await readdir(this.opts.dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [] as string[];
      throw err;
    });
    const ids: string[] = [];
    for (const day of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      for (const id of await readdir(join(this.opts.dir, day))) if (ID_PATTERN.test(id)) ids.push(id);
    }
    return ids.sort().reverse();
  }

  private async removeEmptyDays(): Promise<void> {
    const days = await readdir(this.opts.dir).catch(() => [] as string[]);
    for (const day of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const entries = await readdir(join(this.opts.dir, day)).catch(() => ["?"]);
      if (entries.length === 0) await rm(join(this.opts.dir, day), { recursive: true, force: true });
    }
  }
}

function matches(record: EvidenceRecord, f: EvidenceFilter): boolean {
  const d = record.decision;
  if (f.userId !== undefined && d.subject.userId !== f.userId) return false;
  if (f.roomId !== undefined && d.subject.roomId !== f.roomId) return false;
  if (f.ruleId !== undefined && d.ruleId !== f.ruleId) return false;
  if (f.level !== undefined && d.level !== f.level) return false;
  if (f.review !== undefined && record.review.status !== f.review) return false;
  return true;
}
