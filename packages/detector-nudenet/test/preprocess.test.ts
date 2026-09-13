import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { hwcToChw, prepare, squareLayout } from "../src/index.js";

/** Solid-colour synthetic image. Tests never use real imagery. */
async function solid(width: number, height: number, rgb: [number, number, number], orientation?: number) {
  let img = sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } });
  if (orientation) img = img.withMetadata({ orientation });
  return { bytes: new Uint8Array(await img.jpeg({ quality: 95 }).toBuffer()), mime: "image/jpeg" as const };
}

describe("squareLayout", () => {
  it("scales the long side to the input size", () => {
    expect(squareLayout(640, 320, 320)).toEqual({ side: 640, scale: 0.5, resizedWidth: 320, resizedHeight: 160 });
    expect(squareLayout(300, 900, 320)).toMatchObject({ resizedWidth: 107, resizedHeight: 320 });
  });
});

describe("hwcToChw", () => {
  it("splits channels into planes and scales to 0..1", () => {
    // 2×2 image: red, green, blue, white
    const rgb = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    expect(Array.from(hwcToChw(rgb, 2))).toEqual([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
  });

  it("bgr order swaps the first and third planes", () => {
    const rgb = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    expect(Array.from(hwcToChw(rgb, 2, "bgr"))).toEqual([0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1]);
  });

  it("checks the buffer size", () => {
    expect(() => hwcToChw(new Uint8Array(5), 2)).toThrow(/expected 12 bytes/);
  });
});

describe("prepare", () => {
  it("pads right/bottom with black, like upstream NudeNet", async () => {
    const p = await prepare(await solid(200, 100, [255, 0, 0]), 32);
    expect(p).toMatchObject({ inputSize: 32, width: 200, height: 100 });
    const plane = 32 * 32;
    const px = (x: number, y: number) => [p.tensor[y * 32 + x]!, p.tensor[plane + y * 32 + x]!, p.tensor[2 * plane + y * 32 + x]!];
    // Image occupies rows 0..15: red.
    const [r, g, b] = px(10, 5);
    expect(r).toBeGreaterThan(0.9);
    expect(g).toBeLessThan(0.1);
    expect(b).toBeLessThan(0.1);
    // Rows 16..31 are padding: black.
    expect(px(10, 25)).toEqual([0, 0, 0]);
  });

  it("applies EXIF orientation before measuring", async () => {
    // Stored 200×100, orientation 6 (rotate 90°) → displayed 100×200.
    const p = await prepare(await solid(200, 100, [0, 0, 255], 6), 32);
    expect([p.width, p.height]).toEqual([100, 200]);
    const plane = 32 * 32;
    expect(p.tensor[2 * plane + 5 * 32 + 5]).toBeGreaterThan(0.9); // inside: blue
    expect(p.tensor[2 * plane + 5 * 32 + 25]).toBe(0); // right padding
  });

  it("rejects bytes that are not an image", async () => {
    await expect(prepare({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }, 32)).rejects.toThrow();
  });
});
