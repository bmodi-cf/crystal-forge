// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb } from '@/lib/test/db';
import { prismaSampleStore, type HostSampleInsert } from './store';

// Real values measured on the pilot host — large enough to catch any accidental
// 32-bit or float round-trip.
const ROW: HostSampleInsert = {
  cpuJiffiesTotal: 121_752_934n,
  cpuJiffiesIdle: 109_790_958n,
  cpuJiffiesIowait: 906_528n,
  cpuCount: 1,
  memTotal: 16_766_013_440n,
  memAvailable: 6_661_554_176n,
  diskTotal: 268_315_004_928n,
  diskAvailable: 125_051_080_704n,
  dockerImages: 23_135_864_692n,
  dockerContainers: 1_560_223_744n,
  dockerVolumes: 25_503_138_118n,
  dockerBuildCache: 52_456_054_966n,
  runningForges: 3,
};

describe('prismaSampleStore', () => {
  it('round-trips BigInt byte counts with no precision loss', async () => {
    await withCleanDb(async (prisma) => {
      const store = prismaSampleStore(prisma);
      await store.insert(ROW);
      const row = await prisma.hostSample.findFirstOrThrow();
      expect(row.dockerBuildCache).toBe(52_456_054_966n);
      expect(row.diskTotal).toBe(268_315_004_928n);
      expect(row.cpuJiffiesIowait).toBe(906_528n);
      expect(row.runningForges).toBe(3);
    });
  });

  it('latestAt returns null on an empty table', async () => {
    await withCleanDb(async (prisma) => {
      expect(await prismaSampleStore(prisma).latestAt()).toBeNull();
    });
  });

  it('latestAt returns the newest row timestamp', async () => {
    await withCleanDb(async (prisma) => {
      const store = prismaSampleStore(prisma);
      const older = new Date('2026-09-01T10:00:00.000Z');
      const newer = new Date('2026-09-01T10:05:00.000Z');
      await store.insert(ROW, older);
      await store.insert(ROW, newer);
      expect((await store.latestAt())?.toISOString()).toBe(newer.toISOString());
    });
  });

  it('latestDockerAt ignores rows whose docker columns are null', async () => {
    await withCleanDb(async (prisma) => {
      const store = prismaSampleStore(prisma);
      const withDocker = new Date('2026-09-01T10:00:00.000Z');
      const withoutDocker = new Date('2026-09-01T10:25:00.000Z');
      await store.insert(ROW, withDocker);
      await store.insert(
        { ...ROW, dockerImages: null, dockerContainers: null, dockerVolumes: null, dockerBuildCache: null },
        withoutDocker,
      );
      expect((await store.latestDockerAt())?.toISOString()).toBe(withDocker.toISOString());
    });
  });

  it('deleteOlderThan removes only rows strictly older than the cutoff', async () => {
    await withCleanDb(async (prisma) => {
      const store = prismaSampleStore(prisma);
      const cutoff = new Date('2026-09-01T12:00:00.000Z');
      await store.insert(ROW, new Date('2026-09-01T11:59:59.000Z'));
      await store.insert(ROW, cutoff);
      await store.insert(ROW, new Date('2026-09-01T12:00:01.000Z'));
      expect(await store.deleteOlderThan(cutoff)).toBe(1);
      expect(await prisma.hostSample.count()).toBe(2);
    });
  });
});
