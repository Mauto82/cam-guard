/**
 * Core vocabulary shared by every cam-guard package.
 *
 * The library only ever handles still frames, never video streams: a source
 * grabs one image, a detector scores it, the policy decides, and the frame is
 * dropped unless it becomes evidence of a sanctioned case.
 */

/**
 * Bounding box in NORMALISED coordinates: 0..1 relative to the original image.
 *
 * Normalised rather than pixels so a policy's "minimum area" means the same
 * thing whether the frame came from a 320px thumbnail or a 1080p capture.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detection {
  /** Detector-specific label, e.g. `FEMALE_BREAST_EXPOSED` or `CHILD_PRESENT`. */
  label: string;
  /** Confidence 0..1. */
  score: number;
  box: Box;
}

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

/** An encoded still image, as a source captured it. */
export interface EncodedImage {
  bytes: Uint8Array;
  mime: ImageMime;
}

export interface Detector {
  /** Short stable name, recorded in evidence (e.g. `nudenet-320n`). */
  readonly name: string;
  /** Labels this detector can emit. */
  readonly labels: readonly string[];
  /** Load models. Idempotent; `detect` calls it if needed. */
  init?(): Promise<void>;
  detect(image: EncodedImage): Promise<Detection[]>;
  dispose?(): Promise<void>;
}

/** Who is on camera, and where. The library never knows more than this. */
export interface Subject {
  userId: string;
  roomId: string;
  displayName?: string;
}

export interface Frame {
  subject: Subject;
  image: EncodedImage;
  /** Epoch milliseconds. */
  capturedAt: number;
  /** Id of the source that produced it. */
  sourceId: string;
}

/**
 * Where frames come from: a browser automation, a folder of images, an SFU tap.
 * Pluggable and platform-agnostic.
 */
export interface Source {
  readonly id: string;
  /** Subjects that currently have a camera on. */
  listActive(): Promise<Subject[]>;
  /** Grab one still of that subject, or null if it is no longer available. */
  capture(subject: Subject): Promise<Frame | null>;
  close?(): Promise<void>;
}

/**
 * Actions a policy may request. `ban` is deliberately absent: a permanent ban
 * is always a human decision, taken from the dashboard.
 */
export type ActionType = "report" | "warn" | "close_cam" | "kick" | "suspend";

export interface ActionSpec {
  type: ActionType;
  /** Wait before executing, e.g. warn first and kick 5 s later. */
  delayMs?: number;
  /** Text shown to the user (`warn`) or recorded as the reason. */
  message?: string;
  /** Only for `suspend`. */
  hours?: number;
}

/** Platform adapters the host application provides. The library calls these. */
export interface ActionAdapters {
  warn?(subject: Subject, text: string): Promise<void>;
  closeCam?(subject: Subject): Promise<void>;
  kick?(subject: Subject, reason: string): Promise<void>;
  suspend?(subject: Subject, hours: number, reason: string): Promise<void>;
  /** Only ever invoked by a human, from the dashboard. */
  ban?(subject: Subject, reason: string): Promise<void>;
}
