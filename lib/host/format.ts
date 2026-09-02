const GIB = 1024 ** 3;

/** Placeholder for a bucket with no reading — a real gap, not a zero. */
export const NO_VALUE = '—';

/** Bytes to GiB as a plain number, for chart axes. */
export function toGiB(bytes: number): number {
  return bytes / GIB;
}

/**
 * Bytes as GiB (base-1024), matching `df -h` and `free -m`. Docker's own output
 * is base-1000, so the same byte count reads lower here (52.46 GB → 48.9 GiB) —
 * the unit label is what keeps that from looking like a bug.
 */
export function formatGiB(bytes: number | null, digits = 1): string {
  if (bytes === null) return NO_VALUE;
  return `${(bytes / GIB).toFixed(digits)} GiB`;
}

export function formatPct(pct: number | null, digits = 0): string {
  if (pct === null) return NO_VALUE;
  return `${pct.toFixed(digits)} %`;
}
