/** Cumulative jiffies from /proc/stat's aggregate `cpu` line. */
export type CpuJiffies = { total: bigint; idle: bigint; iowait: bigint };

/**
 * Parse the aggregate `cpu` line of /proc/stat.
 *
 * `total` is the sum of every field — that denominator is what makes
 * (Δtotal - Δidle) / Δtotal an honest utilization figure. The aggregate line
 * already sums all cores, so the result needs no division by core count.
 * Field 4 is idle and field 5 is iowait; they are distinct, and iowait counts
 * as busy in the derived percentage while also being reported separately.
 */
export function parseCpuLine(text: string): CpuJiffies {
  const line = text
    .split('\n')
    .find((l) => /^cpu\s/.test(l));
  if (!line) throw new Error('/proc/stat has no aggregate cpu line');

  const fields = line.trim().split(/\s+/).slice(1).map((f) => BigInt(f));
  const total = fields.reduce((a, b) => a + b, 0n);
  return {
    total,
    idle: fields[3] ?? 0n,
    iowait: fields[4] ?? 0n,
  };
}

const KB = 1024n;

/** Parse /proc/meminfo's MemTotal and MemAvailable, in bytes. */
export function parseMeminfo(text: string): { total: bigint; available: bigint } {
  const read = (key: string): bigint => {
    const kb = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text)?.[1];
    if (kb === undefined) throw new Error(`/proc/meminfo has no ${key}`);
    return BigInt(kb) * KB;
  };
  return { total: read('MemTotal'), available: read('MemAvailable') };
}
