import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Detection, Detector, EncodedImage } from "@cam-guard/core";

const hash = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

/** Solid-colour PNG. Tests never use real imagery. */
export async function solidPng(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

/**
 * A detector that answers by image content: register what each image should
 * "contain", then write those images as frames.
 */
export class ScriptedDetector implements Detector {
  readonly name = "scripted";
  readonly labels = ["FEMALE_GENITALIA_EXPOSED", "MALE_GENITALIA_EXPOSED", "ANUS_EXPOSED", "FEMALE_BREAST_EXPOSED", "BUTTOCKS_EXPOSED"];
  private readonly answers = new Map<string, Detection[]>();
  calls = 0;

  register(image: Uint8Array, detections: Detection[]): void {
    this.answers.set(hash(image), detections);
  }

  async detect(image: EncodedImage): Promise<Detection[]> {
    this.calls += 1;
    return this.answers.get(hash(image.bytes)) ?? [];
  }
}

export const nude = (score: number): Detection[] => [
  { label: "FEMALE_BREAST_EXPOSED", score, box: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } },
];

/** Write `n` copies of `image` as the frames of one camera. */
export async function camera(root: string, roomId: string, userId: string, frames: Buffer[]): Promise<void> {
  const dir = join(root, roomId, userId);
  await mkdir(dir, { recursive: true });
  for (const [i, bytes] of frames.entries()) await writeFile(join(dir, `frame-${String(i).padStart(3, "0")}.png`), bytes);
}
