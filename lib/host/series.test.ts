import { describe, it, expect } from 'vitest';
import { buildSeries, RANGES, type SampleRow } from './series';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const INTERVAL = 300_000; // 5 min
// A 1-vCPU host at 100 Hz accrues 30,000 jiffies per 5-minute interval.
const JIFFIES_PER_INTERVAL = 30_000n;

function row(minutes: number, over: Partial<SampleRow> = {}): SampleRow {
  return {
    at: new Date(T0 + minutes * 60_000),
    cpuJiffiesTotal: 0n,
    cpuJiffiesIdle: 0n,
    cpuJiffiesIowait: 0n,
    cpuCount: 1,
    memTotal: 16_000_000_000n,
    memAvailable: 8_000_000_000n,
    diskTotal: 250_000_000_000n,
    diskAvailable: 125_000_000_000n,
    dockerImages: null,
    dockerContainers: null,
    dockerVolumes: null,
    dockerBuildCache: null,
    runningForges: 2,
    ...over,
  };
}

const OPTS = { range: '24h' as const, sampleIntervalMs: INTERVAL };

describe('buildSeries', () => {
  it('returns an empty series with no latest for no rows', () => {
    expect(buildSeries([], OPTS)).toMatchObject({ points: [], docker: [], latest: null });
  });

  it('reports a fully busy interval as 100 %', () => {
    const series = buildSeries(
      [row(0), row(5, { cpuJiffiesTotal: JIFFIES_PER_INTERVAL, cpuJiffiesIdle: 0n })],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBe(100);
  });

  it('reports a fully idle interval as 0 %', () => {
    const series = buildSeries(
      [row(0), row(5, { cpuJiffiesTotal: JIFFIES_PER_INTERVAL, cpuJiffiesIdle: JIFFIES_PER_INTERVAL })],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBe(0);
  });

  it('counts iowait as busy and also reports it separately', () => {
    const series = buildSeries(
      [
        row(0),
        row(5, {
          cpuJiffiesTotal: 30_000n,
          cpuJiffiesIdle: 21_000n,   // 70 % idle
          cpuJiffiesIowait: 6_000n,  // 20 % iowait, inside the 30 % busy
        }),
      ],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBeCloseTo(30, 6);
    expect(series.points.at(-1)?.iowaitPct).toBeCloseTo(20, 6);
  });

  it('emits a null cpu when the counter goes backwards (reboot)', () => {
    const series = buildSeries(
      [
        row(0, { cpuJiffiesTotal: 900_000n, cpuJiffiesIdle: 600_000n }),
        row(5, { cpuJiffiesTotal: 1_000n, cpuJiffiesIdle: 500n }), // rebooted
      ],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBeNull();
    // Memory is still a valid gauge reading across a reboot.
    expect(series.points.at(-1)?.memUsedBytes).toBe(8_000_000_000);
  });

  it('emits a null cpu when the gap exceeds 3x the sample interval', () => {
    const series = buildSeries(
      [row(0), row(20, { cpuJiffiesTotal: 120_000n, cpuJiffiesIdle: 0n })], // 20 min > 15 min
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBeNull();
  });

  it('accepts a gap of exactly 3x the interval', () => {
    const series = buildSeries(
      [row(0), row(15, { cpuJiffiesTotal: 90_000n, cpuJiffiesIdle: 0n })],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBe(100);
  });

  it('emits all-null points for buckets with no samples, so the line breaks', () => {
    const series = buildSeries([row(0), row(30)], OPTS);
    // 24h range buckets at 5 min: 00:00 … 00:30 is 7 buckets.
    expect(series.points).toHaveLength(7);
    expect(series.points[3]).toMatchObject({ cpuPct: null, memUsedBytes: null });
  });

  it('reports a bucket mean below its peak when one interval inside it is hot', () => {
    // 7d buckets at 1 h with 5-minute samples: all three rows land in ONE bucket,
    // giving it two intervals — one fully idle, one fully busy.
    const series = buildSeries(
      [
        row(0),
        row(5, { cpuJiffiesTotal: 30_000n, cpuJiffiesIdle: 30_000n }), // idle
        row(10, { cpuJiffiesTotal: 60_000n, cpuJiffiesIdle: 30_000n }), // busy
      ],
      { range: '7d', sampleIntervalMs: INTERVAL },
    );
    expect(series.points).toHaveLength(1);
    expect(series.points[0]!.cpuPct).toBeCloseTo(50, 6);
    expect(series.points[0]!.cpuPeakPct).toBeCloseTo(100, 6);
  });

  it('derives memory used as total - available, and reports a peak', () => {
    const series = buildSeries(
      [
        row(0, { memAvailable: 8_000_000_000n }),
        row(5, { memAvailable: 2_000_000_000n }),
      ],
      OPTS,
    );
    expect(series.points[0]!.memUsedBytes).toBe(8_000_000_000);
    expect(series.points.at(-1)?.memUsedBytes).toBe(14_000_000_000);
    expect(series.points.at(-1)?.memPeakBytes).toBe(14_000_000_000);
    expect(series.points.at(-1)?.memTotalBytes).toBe(16_000_000_000);
  });

  it('buckets docker rows at 30 minutes minimum, taking the last per bucket', () => {
    const docker = (n: bigint) => ({
      dockerImages: n, dockerContainers: n, dockerVolumes: n, dockerBuildCache: n,
    });
    const series = buildSeries(
      [
        row(0, docker(1n)),
        row(5),                     // no docker columns
        row(29, docker(2n)),        // same 30-min bucket as minute 0 — wins
        row(35, docker(3n)),        // next bucket
      ],
      OPTS,
    );
    expect(series.dockerBucketMs).toBe(1_800_000);
    expect(series.docker.map((d) => d.imagesBytes)).toEqual([2, 3]);
  });

  it('reports latest from the final row, with cpu from the final valid interval', () => {
    const series = buildSeries(
      [row(0), row(5, { cpuJiffiesTotal: 30_000n, cpuJiffiesIdle: 15_000n, runningForges: 4 })],
      OPTS,
    );
    expect(series.latest).toMatchObject({
      cpuPct: 50,
      memUsedBytes: 8_000_000_000,
      memTotalBytes: 16_000_000_000,
      diskUsedBytes: 125_000_000_000,
      diskTotalBytes: 250_000_000_000,
      runningForges: 4,
      cpuCount: 1,
    });
  });

  it('carries the bucket size for the requested range', () => {
    expect(buildSeries([row(0)], { range: '90d', sampleIntervalMs: INTERVAL }).bucketMs)
      .toBe(RANGES['90d'].bucketMs);
  });
});
