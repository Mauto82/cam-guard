import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultModelsDir, ensureModel, MODELS, NudeNetDetector } from "../src/index.js";
import { extractFromZip } from "../src/zip.js";

/** Minimal zip writer, enough to exercise the reader. */
function makeZip(files: { name: string; data: Buffer; deflate: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("extractFromZip", () => {
  const zip = makeZip([
    { name: "pkg/__init__.py", data: Buffer.from("x = 1\n"), deflate: false },
    { name: "pkg/model.onnx", data: Buffer.alloc(5000, 7), deflate: true },
  ]);

  it("reads stored and deflated entries", () => {
    expect(extractFromZip(zip, "pkg/__init__.py").toString()).toBe("x = 1\n");
    expect(extractFromZip(zip, "pkg/model.onnx").equals(Buffer.alloc(5000, 7))).toBe(true);
  });

  it("says what is missing", () => {
    expect(() => extractFromZip(zip, "nope")).toThrow(/nope not found/);
    expect(() => extractFromZip(Buffer.from("not a zip at all, really not"), "x")).toThrow(/not a zip/);
  });
});

describe("ensureModel", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cam-guard-models-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a cached file whose hash does not match", async () => {
    await writeFile(join(dir, MODELS["320n"].file), "tampered");
    await expect(ensureModel("320n", { dir })).rejects.toThrow(/has sha256 .* expected/);
  });

  it("refuses a download whose hash does not match, and saves nothing", async () => {
    const fakeWheel = makeZip([{ name: "nudenet/320n.onnx", data: Buffer.from("evil"), deflate: true }]);
    const fetchImpl = (async () => new Response(fakeWheel, { status: 200 })) as typeof fetch;
    await expect(ensureModel("320n", { dir, fetch: fetchImpl, githubToken: "" })).rejects.toThrow(
      /could not obtain NudeNet 320n[\s\S]*sha256/,
    );
    expect(existsSync(join(dir, MODELS["320n"].file))).toBe(false);
  });

  it("does not mistake a sign-in page for weights", async () => {
    const fetchImpl = (async () =>
      new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(ensureModel("640m", { dir, fetch: fetchImpl, githubToken: "t" })).rejects.toThrow(/HTML page/);
  });

  it("explains that 640m needs a GitHub token", async () => {
    const before = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      await expect(ensureModel("640m", { dir })).rejects.toThrow(/GITHUB_TOKEN/);
    } finally {
      if (before !== undefined) process.env.GITHUB_TOKEN = before;
    }
  });
});

/**
 * Runs only when the real 320n model is already in the cache — CI without
 * network skips it. Uses a synthetic image: the point is that the pipeline
 * runs end to end and within budget, not what it finds.
 */
const cached = join(defaultModelsDir(), MODELS["320n"].file);
describe.skipIf(!existsSync(cached))("NudeNetDetector (real model)", () => {
  it("runs on a synthetic image, with timings", async () => {
    const detector = new NudeNetDetector({ model: "320n" });
    const bytes = new Uint8Array(
      await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 110, b: 100 } } })
        .jpeg()
        .toBuffer(),
    );
    const first = await detector.detectTimed({ bytes, mime: "image/jpeg" });
    expect(first).toMatchObject({ width: 640, height: 480 });
    for (const d of first.detections) {
      expect(d.score).toBeGreaterThanOrEqual(0.25);
      expect(d.box.x + d.box.w).toBeLessThanOrEqual(1.00001);
    }
    expect(first.timings.totalMs).toBeGreaterThan(0);
    await detector.dispose();
  });

  it("the cached file matches the pinned hash", async () => {
    const { readFile } = await import("node:fs/promises");
    expect(createHash("sha256").update(await readFile(cached)).digest("hex")).toBe(MODELS["320n"].sha256);
  });
});
