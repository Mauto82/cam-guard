import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderSource } from "../src/sources/folder.js";
import { camera, solidPng } from "./helpers.js";

describe("FolderSource", () => {
  let dir: string;
  let red: Buffer;
  let blue: Buffer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cam-guard-folder-"));
    red = await solidPng(255, 0, 0);
    blue = await solidPng(0, 0, 255);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("every user folder is a camera; frames play in filename order", async () => {
    await camera(dir, "lobby", "alice", [red, blue]);
    await camera(dir, "lobby", "bob", [blue]);
    await writeFile(join(dir, "lobby", "alice", "notes.txt"), "ignored");
    const src = new FolderSource({ dir, now: () => 42 });

    expect(await src.listActive()).toEqual([
      { userId: "alice", roomId: "lobby" },
      { userId: "bob", roomId: "lobby" },
    ]);
    const f1 = await src.capture({ userId: "alice", roomId: "lobby" });
    const f2 = await src.capture({ userId: "alice", roomId: "lobby" });
    expect(Buffer.from(f1!.image.bytes).equals(red)).toBe(true);
    expect(Buffer.from(f2!.image.bytes).equals(blue)).toBe(true);
    expect(f1).toMatchObject({ capturedAt: 42, subject: { userId: "alice", roomId: "lobby" }, image: { mime: "image/png" } });
  });

  it("a camera switches off when its frames run out", async () => {
    await camera(dir, "lobby", "alice", [red]);
    const src = new FolderSource({ dir });
    await src.listActive();
    await src.capture({ userId: "alice", roomId: "lobby" });
    expect(await src.capture({ userId: "alice", roomId: "lobby" })).toBeNull();
    expect(await src.listActive()).toEqual([]);
    expect(src.exhausted).toBe(true);
  });

  it("loop starts over", async () => {
    await camera(dir, "lobby", "alice", [red, blue]);
    const src = new FolderSource({ dir, loop: true });
    await src.listActive();
    const s = { userId: "alice", roomId: "lobby" };
    const frames = [];
    for (let i = 0; i < 3; i++) frames.push(Buffer.from((await src.capture(s))!.image.bytes));
    expect(frames.map((b) => (b.equals(red) ? "red" : "blue"))).toEqual(["red", "blue", "red"]);
    expect(src.exhausted).toBe(false);
  });

  it("picks up cameras added while running", async () => {
    await camera(dir, "lobby", "alice", [red]);
    const src = new FolderSource({ dir });
    expect(await src.listActive()).toHaveLength(1);
    await camera(dir, "adults-1", "carol", [red]);
    expect((await src.listActive()).map((s) => s.userId).sort()).toEqual(["alice", "carol"]);
  });

  it("says clearly when the folder is missing", async () => {
    await expect(new FolderSource({ dir: join(dir, "nope") }).listActive()).rejects.toThrow(/does not exist/);
  });
});
