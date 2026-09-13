const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;

/** `"24h"`, `"5s"`, `"1.5d"` or a plain number of milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid duration: ${value}`);
    return value;
  }
  const match = PATTERN.exec(value.trim());
  if (!match) throw new Error(`invalid duration "${value}" (expected e.g. 500ms, 5s, 10m, 24h, 2d)`);
  return Number(match[1]) * UNITS[match[2]!]!;
}
