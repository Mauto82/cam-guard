/**
 * NudeNet v3 classes, in the order of the model's output channels.
 * Kept verbatim from upstream so policies can use the names people already know.
 */
export const NUDENET_LABELS = [
  "FEMALE_GENITALIA_COVERED",
  "FACE_FEMALE",
  "BUTTOCKS_EXPOSED",
  "FEMALE_BREAST_EXPOSED",
  "FEMALE_GENITALIA_EXPOSED",
  "MALE_BREAST_EXPOSED",
  "ANUS_EXPOSED",
  "FEET_EXPOSED",
  "BELLY_COVERED",
  "FEET_COVERED",
  "ARMPITS_COVERED",
  "ARMPITS_EXPOSED",
  "FACE_MALE",
  "BELLY_EXPOSED",
  "MALE_GENITALIA_EXPOSED",
  "ANUS_COVERED",
  "FEMALE_BREAST_COVERED",
  "BUTTOCKS_COVERED",
] as const;

export type NudeNetLabel = (typeof NUDENET_LABELS)[number];

/** The classes the example policy treats as explicit nudity. */
export const EXPLICIT_LABELS: readonly NudeNetLabel[] = [
  "FEMALE_GENITALIA_EXPOSED",
  "MALE_GENITALIA_EXPOSED",
  "ANUS_EXPOSED",
  "FEMALE_BREAST_EXPOSED",
  "BUTTOCKS_EXPOSED",
];
