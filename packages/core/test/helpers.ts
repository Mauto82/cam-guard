import type { Detection, EncodedImage, Frame, Subject } from "../src/index.js";

/** A tiny valid PNG (1×1 transparent pixel). Tests never use real imagery. */
export const PIXEL_PNG: EncodedImage = {
  mime: "image/png",
  bytes: Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  ),
};

export const subject = (userId = "u1", roomId = "lobby"): Subject => ({ userId, roomId });

export const det = (label: string, score: number, w = 0.3, h = 0.3): Detection => ({
  label,
  score,
  box: { x: 0.1, y: 0.1, w, h },
});

export const frame = (s: Subject, capturedAt: number): Frame => ({
  subject: s,
  image: PIXEL_PNG,
  capturedAt,
  sourceId: "test",
});

export const SEC = 1_000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
