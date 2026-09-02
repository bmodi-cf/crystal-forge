import { describe, it, expect, vi } from 'vitest';
import { sampleOnce, startUsageSampler, DOCKER_SAMPLE_INTERVAL_MS, type SamplerDeps } from './sampler';
import type { HostSampleInsert, SampleStore } from './store';
import type { HostSnapshot } from './read';

const SNAPSHOT: HostSnapshot = {
  cpuJiffiesTotal: 121_752_934n,
  cpuJiffiesIdle: 109_790_958n,
  cpuJiffiesIowait: 906_528n,
  cpuCount: 1,
  memTotal: 16_766_013_440n,
  memAvailable: 6_661_554_176n,
  diskTotal: 268_315_004_928n,
  diskAvailable: 125_051_080_704n,
};

const DOCKER = {
  imagesBytes: 23_135_864_692,
  containersBytes: 1_560_223_744,
  volumesBytes: 25_503_138_118,
  buildCacheBytes: 52_456_054_966,
};

const OPTS = { intervalMs: 300_000, retentionDays: 90, dockerIntervalMs: DOCKER_SAMPLE_INTERVAL_MS };

type Written = { at: Date; row: HostSampleInsert };

function fakeStore(seed: Written[] = []) {
  const rows = [...seed];
  const cutoffs: Date[] = [];
  const store: SampleStore & { rows: Written[]; cutoffs: Date[] } = {
    rows,
    cutoffs,
    latestAt: async () => (rows.length ? rows[rows.length - 1]!.at : null),
    latestDockerAt: async () => {
      const withDocker = rows.filter((r) => r.row.dockerImages !== null);
      return withDocker.length ? withDocker[withDocker.length - 1]!.at : null;
    },
    insert: async (row, at) => { rows.push({ at: at ?? new Date(), row }); },
    deleteOlderThan: async (cutoff) => { cutoffs.push(cutoff); return 0; },
  };
  return store;
}

function deps(over: Partial<SamplerDeps> = {}): SamplerDeps & { store: ReturnType<typeof fakeStore> } {
  const store = (over.store as ReturnType<typeof fakeStore>) ?? fakeStore();
  // `store` is reassigned after the spread so the returned handle is always the
  // very instance the sampler writes to, whether it came from `over` or fresh.
  return Object.assign(
    {
      readSnapshot: async () => SNAPSHOT,
      readDocker: async () => DOCKER,
      countRunningForges: async () => 3,
      now: () => new Date('2026-09-01T12:00:00.000Z'),
    },
    over,
    { store },
  );
}

describe('sampleOnce', () => {
  it('writes one row carrying the snapshot, docker figures and forge count', async () => {
    const d = deps();
    await expect(sampleOnce(d, OPTS)).resolves.toBe('written');
    expect(d.store.rows).toHaveLength(1);
    expect(d.store.rows[0]!.row).toMatchObject({
      cpuJiffiesTotal: 121_752_934n,
      cpuJiffiesIowait: 906_528n,
      memAvailable: 6_661_554_176n,
      diskAvailable: 125_051_080_704n,
      dockerBuildCache: 52_456_054_966n,
      runningForges: 3,
    });
  });

  it('samples docker on the very first tick, when no docker row exists yet', async () => {
    const readDocker = vi.fn(async () => DOCKER);
    await sampleOnce(deps({ readDocker }), OPTS);
    expect(readDocker).toHaveBeenCalledTimes(1);
  });

  it('skips the whole tick when the newest row is younger than half the interval', async () => {
    const store = fakeStore([
      { at: new Date('2026-09-01T11:58:00.000Z'), row: { dockerImages: 1n } as HostSampleInsert },
    ]);
    const d = deps({ store });
    await expect(sampleOnce(d, OPTS)).resolves.toBe('skipped');
    expect(d.store.rows).toHaveLength(1);
  });

  it('leaves docker columns null when the newest docker row is too recent', async () => {
    const readDocker = vi.fn(async () => DOCKER);
    // 25 min old: inside the 30 min cadence (threshold is 30 min - interval/2).
    const store = fakeStore([
      { at: new Date('2026-09-01T11:35:00.000Z'), row: { dockerImages: 1n } as HostSampleInsert },
    ]);
    const d = deps({ store, readDocker });
    await sampleOnce(d, OPTS);
    expect(readDocker).not.toHaveBeenCalled();
    expect(d.store.rows[1]!.row).toMatchObject({
      dockerImages: null, dockerContainers: null, dockerVolumes: null, dockerBuildCache: null,
    });
  });

  it('samples docker again once the newest docker row has aged past the cadence', async () => {
    const readDocker = vi.fn(async () => DOCKER);
    // 28 min old: past the 27.5 min threshold.
    const store = fakeStore([
      { at: new Date('2026-09-01T11:32:00.000Z'), row: { dockerImages: 1n } as HostSampleInsert },
    ]);
    await sampleOnce(deps({ store, readDocker }), OPTS);
    expect(readDocker).toHaveBeenCalledTimes(1);
  });

  it('still writes host figures when docker fails', async () => {
    const d = deps({ readDocker: async () => { throw new Error('daemon down'); } });
    await expect(sampleOnce(d, OPTS)).resolves.toBe('written');
    expect(d.store.rows[0]!.row).toMatchObject({ dockerImages: null, memTotal: 16_766_013_440n });
  });

  it('writes nothing when the /proc read fails', async () => {
    const d = deps({ readSnapshot: async () => { throw new Error('EACCES'); } });
    await expect(sampleOnce(d, OPTS)).resolves.toBe('skipped');
    expect(d.store.rows).toHaveLength(0);
  });

  it('nulls only runningForges when the container list fails', async () => {
    const d = deps({ countRunningForges: async () => { throw new Error('docker gone'); } });
    await sampleOnce(d, OPTS);
    expect(d.store.rows[0]!.row).toMatchObject({ runningForges: null, memTotal: 16_766_013_440n });
  });

  it('prunes rows older than the retention window', async () => {
    const d = deps();
    await sampleOnce(d, OPTS);
    expect(d.store.cutoffs[0]!.toISOString()).toBe('2026-06-03T12:00:00.000Z');
  });
});

describe('startUsageSampler', () => {
  it('ticks immediately and on the interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ now: () => new Date(Date.now()) });
      const handle = startUsageSampler(d, OPTS);
      await vi.advanceTimersByTimeAsync(0);
      expect(d.store.rows).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(300_000);
      expect(d.store.rows).toHaveLength(2);

      handle.stop();
      await vi.advanceTimersByTimeAsync(900_000);
      expect(d.store.rows).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stack ticks while one is still in flight', async () => {
    vi.useFakeTimers();
    try {
      // Held in a box: assigning through a Promise executor callback is
      // invisible to control-flow analysis, which would narrow a bare `let` to
      // `never` and make the call below a type error.
      const box: { release: (() => void) | null } = { release: null };
      const readSnapshot = vi.fn(
        () => new Promise<HostSnapshot>((resolve) => {
          box.release = () => resolve(SNAPSHOT);
        }),
      );
      const d = deps({ readSnapshot, now: () => new Date(Date.now()) });
      const handle = startUsageSampler(d, OPTS);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(600_000); // two more interval boundaries
      expect(readSnapshot).toHaveBeenCalledTimes(1);
      box.release?.();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
