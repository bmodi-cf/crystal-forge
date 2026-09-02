// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb, makeUser } from '@/lib/test/db';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { getUsageSeries } from './usage';
import type { UsageRange } from '@/lib/host/series';

const SAMPLE = {
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
  runningForges: 1,
};

describe('getUsageSeries', () => {
  it('refuses a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(getUsageSeries(dev, '24h')).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('rejects an unknown range', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await expect(getUsageSeries(admin, 'forever' as UsageRange)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('returns an empty series for an admin when nothing has been sampled', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const series = await getUsageSeries(admin, '24h');
      expect(series).toMatchObject({ range: '24h', points: [], latest: null });
    });
  });

  it('includes rows inside the window and excludes older ones', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const now = Date.now();
      await prisma.hostSample.create({ data: { ...SAMPLE, at: new Date(now - 30 * 60_000) } });
      await prisma.hostSample.create({
        data: { ...SAMPLE, at: new Date(now - 40 * 60 * 60_000) }, // 40 h ago
      });
      const series = await getUsageSeries(admin, '24h');
      expect(series.latest).not.toBeNull();
      // Only the recent sample is in range, so exactly one bucket is emitted.
      expect(series.points).toHaveLength(1);
    });
  });
});
