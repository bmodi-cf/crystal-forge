export type UsageRange = '24h' | '7d' | '30d' | '90d';

/**
 * Window and bucket per range, chosen to keep every chart between ~170 and ~290
 * points: legible, and ~30 KB of JSON.
 */
export const RANGES: Record<UsageRange, { windowMs: number; bucketMs: number }> = {
  '24h': { windowMs: 86_400_000, bucketMs: 300_000 },
  '7d': { windowMs: 604_800_000, bucketMs: 3_600_000 },
  '30d': { windowMs: 2_592_000_000, bucketMs: 14_400_000 },
  '90d': { windowMs: 7_776_000_000, bucketMs: 43_200_000 },
};

/** Docker columns are only written every 30 min, so never bucket them finer. */
export const DOCKER_MIN_BUCKET_MS = 1_800_000;

/** A gap wider than this many sample intervals breaks the line. */
export const GAP_FACTOR = 3;

export type SampleRow = {
  at: Date;
  cpuJiffiesTotal: bigint;
  cpuJiffiesIdle: bigint;
  cpuJiffiesIowait: bigint;
  cpuCount: number;
  memTotal: bigint;
  memAvailable: bigint;
  diskTotal: bigint;
  diskAvailable: bigint;
  dockerImages: bigint | null;
  dockerContainers: bigint | null;
  dockerVolumes: bigint | null;
  dockerBuildCache: bigint | null;
  runningForges: number | null;
};

export type UsagePoint = {
  at: string;
  cpuPct: number | null;
  cpuPeakPct: number | null;
  iowaitPct: number | null;
  memUsedBytes: number | null;
  memPeakBytes: number | null;
  memTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  runningForges: number | null;
};

export type DockerPoint = {
  at: string;
  imagesBytes: number;
  containersBytes: number;
  volumesBytes: number;
  buildCacheBytes: number;
};

export type UsageLatest = {
  at: string;
  cpuPct: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  runningForges: number | null;
  cpuCount: number;
};

export type UsageSeries = {
  range: UsageRange;
  bucketMs: number;
  dockerBucketMs: number;
  points: UsagePoint[];
  docker: DockerPoint[];
  latest: UsageLatest | null;
};

/** One CPU interval between two consecutive rows, or null when unusable. */
type Interval = { endMs: number; dTotal: number; dBusy: number; dIowait: number } | null;

type Bucket = {
  dTotal: number;
  dBusy: number;
  dIowait: number;
  peakPct: number | null;
  memUsed: number[];
  memTotal: number | null;
  diskUsed: number[];
  diskTotal: number | null;
  runningForges: number | null;
};

const bucketStart = (ms: number, bucketMs: number): number => Math.floor(ms / bucketMs) * bucketMs;

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function emptyBucket(): Bucket {
  return {
    dTotal: 0, dBusy: 0, dIowait: 0, peakPct: null,
    memUsed: [], memTotal: null, diskUsed: [], diskTotal: null, runningForges: null,
  };
}

/**
 * Turn raw samples into a bucketed series.
 *
 * CPU comes from deltas between consecutive rows — the stored counters are
 * cumulative — so a bucket's mean is (Σ busy jiffies / Σ total jiffies) across
 * its intervals, which stays correct even when samples are unevenly spaced.
 * Two conditions make an interval unusable and emit null rather than a
 * fabricated number: a gap wider than GAP_FACTOR intervals (a downtime or a
 * deploy window), and a counter that went backwards (a reboot).
 *
 * Buckets run from the first sample to the last, not across the whole window: a
 * three-day-old install asked for 90 days should draw three days, not 87 empty
 * buckets. Buckets with no samples inside that span DO get an all-null point,
 * so a real outage reads as a break in the line.
 */
export function buildSeries(
  rows: SampleRow[],
  opts: { range: UsageRange; sampleIntervalMs: number },
): UsageSeries {
  const { bucketMs } = RANGES[opts.range];
  const dockerBucketMs = Math.max(bucketMs, DOCKER_MIN_BUCKET_MS);
  const base = { range: opts.range, bucketMs, dockerBucketMs };

  if (rows.length === 0) return { ...base, points: [], docker: [], latest: null };

  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  const maxGapMs = opts.sampleIntervalMs * GAP_FACTOR;

  const intervals: Interval[] = sorted.map((curr, i) => {
    const prev = sorted[i - 1];
    if (!prev) return null;
    const dtMs = curr.at.getTime() - prev.at.getTime();
    if (dtMs > maxGapMs) return null;
    if (curr.cpuJiffiesTotal < prev.cpuJiffiesTotal) return null; // reboot
    const dTotal = Number(curr.cpuJiffiesTotal - prev.cpuJiffiesTotal);
    if (dTotal <= 0) return null;
    const dIdle = Number(curr.cpuJiffiesIdle - prev.cpuJiffiesIdle);
    return {
      endMs: curr.at.getTime(),
      dTotal,
      dBusy: dTotal - dIdle,
      dIowait: Number(curr.cpuJiffiesIowait - prev.cpuJiffiesIowait),
    };
  });

  const buckets = new Map<number, Bucket>();
  const at = (ms: number): Bucket => {
    const key = bucketStart(ms, bucketMs);
    const existing = buckets.get(key);
    if (existing) return existing;
    const fresh = emptyBucket();
    buckets.set(key, fresh);
    return fresh;
  };

  for (const row of sorted) {
    const b = at(row.at.getTime());
    b.memUsed.push(Number(row.memTotal - row.memAvailable));
    b.memTotal = Number(row.memTotal);
    b.diskUsed.push(Number(row.diskTotal - row.diskAvailable));
    b.diskTotal = Number(row.diskTotal);
    b.runningForges = row.runningForges;
  }

  for (const interval of intervals) {
    if (!interval) continue;
    const b = at(interval.endMs);
    b.dTotal += interval.dTotal;
    b.dBusy += interval.dBusy;
    b.dIowait += interval.dIowait;
    const pct = (interval.dBusy / interval.dTotal) * 100;
    b.peakPct = b.peakPct === null ? pct : Math.max(b.peakPct, pct);
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  const points: UsagePoint[] = [];
  for (let key = first; key <= last; key += bucketMs) {
    const b = buckets.get(key);
    if (!b) {
      points.push({
        at: new Date(key).toISOString(),
        cpuPct: null, cpuPeakPct: null, iowaitPct: null,
        memUsedBytes: null, memPeakBytes: null, memTotalBytes: null,
        diskUsedBytes: null, diskTotalBytes: null, runningForges: null,
      });
      continue;
    }
    points.push({
      at: new Date(key).toISOString(),
      cpuPct: b.dTotal > 0 ? (b.dBusy / b.dTotal) * 100 : null,
      cpuPeakPct: b.peakPct,
      iowaitPct: b.dTotal > 0 ? (b.dIowait / b.dTotal) * 100 : null,
      memUsedBytes: mean(b.memUsed),
      memPeakBytes: b.memUsed.length ? Math.max(...b.memUsed) : null,
      memTotalBytes: b.memTotal,
      diskUsedBytes: mean(b.diskUsed),
      diskTotalBytes: b.diskTotal,
      runningForges: b.runningForges,
    });
  }

  // Docker: only rows that actually carry the columns, last one per bucket. No
  // null padding — a stacked area with holes in it just looks broken.
  const dockerByBucket = new Map<number, DockerPoint>();
  for (const row of sorted) {
    if (row.dockerImages === null) continue;
    const key = bucketStart(row.at.getTime(), dockerBucketMs);
    dockerByBucket.set(key, {
      at: new Date(key).toISOString(),
      imagesBytes: Number(row.dockerImages),
      containersBytes: Number(row.dockerContainers ?? 0n),
      volumesBytes: Number(row.dockerVolumes ?? 0n),
      buildCacheBytes: Number(row.dockerBuildCache ?? 0n),
    });
  }
  const docker = [...dockerByBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, point]) => point);

  const lastRow = sorted[sorted.length - 1]!;
  const lastInterval = [...intervals].reverse().find((i): i is NonNullable<Interval> => i !== null);
  // runningForges rides along with the docker probe, sampled every 30 min
  // rather than every 5, so the newest row carries null five times in six.
  // Carry the last known count forward instead of reporting "unknown".
  const lastForgeCount = [...sorted].reverse()
    .find((r) => r.runningForges !== null)?.runningForges ?? null;
  const latest: UsageLatest = {
    at: lastRow.at.toISOString(),
    cpuPct: lastInterval ? (lastInterval.dBusy / lastInterval.dTotal) * 100 : null,
    memUsedBytes: Number(lastRow.memTotal - lastRow.memAvailable),
    memTotalBytes: Number(lastRow.memTotal),
    diskUsedBytes: Number(lastRow.diskTotal - lastRow.diskAvailable),
    diskTotalBytes: Number(lastRow.diskTotal),
    runningForges: lastForgeCount,
    cpuCount: lastRow.cpuCount,
  };

  return { ...base, points, docker, latest };
}
