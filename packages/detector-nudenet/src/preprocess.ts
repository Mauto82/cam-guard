import sharp from "sharp";
import type { EncodedImage } from "@cam-guard/core";

/**
 * Channel order fed to the model.
 *
 * `rgb` is what the model was trained on (ultralytics YOLOv8 feeds RGB).
 * `bgr` reproduces upstream NudeNet 3.4.2, which — through a double channel
 * swap in its OpenCV preprocessing — actually feeds BGR, and so reports lower
 * scores (on a test portrait: 0.73 BGR vs 0.82 RGB). Use `bgr` only to match
 * thresholds tuned with the Python package.
 */
export type ChannelOrder = "rgb" | "bgr";

export interface Prepared {
  /** NCHW float32, RGB, 0..1 — what the model takes. */
  tensor: Float32Array;
  inputSize: number;
  /** Size of the decoded image, after EXIF orientation. */
  width: number;
  height: number;
}

/**
 * Where the image lands inside the square model input.
 *
 * NudeNet pads the image to a square on the RIGHT and BOTTOM (not centred, as
 * a classic letterbox would) and then resizes the square. Matching that
 * exactly matters: the boxes the model outputs are relative to that layout.
 * Scaling first and padding after gives the same geometry in a single pass.
 */
export function squareLayout(width: number, height: number, inputSize: number) {
  const side = Math.max(width, height);
  const scale = inputSize / side;
  return {
    side,
    scale,
    resizedWidth: Math.max(1, Math.round(width * scale)),
    resizedHeight: Math.max(1, Math.round(height * scale)),
  };
}

/** Interleaved RGB bytes (HWC) → planar float32 0..1 (CHW), in the requested channel order. */
export function hwcToChw(rgb: Uint8Array, size: number, order: ChannelOrder = "rgb"): Float32Array {
  const plane = size * size;
  if (rgb.length !== plane * 3) throw new Error(`expected ${plane * 3} bytes, got ${rgb.length}`);
  const out = new Float32Array(plane * 3);
  const [first, last] = order === "rgb" ? [0, 2 * plane] : [2 * plane, 0];
  for (let i = 0, p = 0; i < plane; i++, p += 3) {
    out[first + i] = rgb[p]! / 255;
    out[plane + i] = rgb[p + 1]! / 255;
    out[last + i] = rgb[p + 2]! / 255;
  }
  return out;
}

export async function prepare(image: EncodedImage, inputSize: number, order: ChannelOrder = "rgb"): Promise<Prepared> {
  const meta = await sharp(image.bytes).metadata();
  if (!meta.width || !meta.height) throw new Error("could not read image dimensions");
  // EXIF orientations 5–8 swap width and height once applied.
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;
  const layout = squareLayout(width, height, inputSize);

  const raw = await sharp(image.bytes)
    .rotate()
    .removeAlpha()
    .resize(layout.resizedWidth, layout.resizedHeight, { fit: "fill", kernel: "linear" })
    .extend({
      right: inputSize - layout.resizedWidth,
      bottom: inputSize - layout.resizedHeight,
      background: { r: 0, g: 0, b: 0 },
    })
    .toColourspace("srgb")
    .raw()
    .toBuffer();

  return { tensor: hwcToChw(raw, inputSize, order), inputSize, width, height };
}
