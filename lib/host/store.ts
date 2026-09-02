import type { PrismaClient } from '@prisma/client';

/** One sample's worth of columns. `at` is supplied separately so the sampler
 *  and the seed can control it while production inserts default to now(). */
export type HostSampleInsert = {
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

/**
 * The sampler's whole view of the database. Narrow on purpose: sampler tests
 * substitute a fake and stay pure, so only this file's tests need Postgres.
 */
export type SampleStore = {
  /** Timestamp of the newest sample, or null when the table is empty. */
  latestAt(): Promise<Date | null>;
  /** Timestamp of the newest sample that actually carries docker figures. */
  latestDockerAt(): Promise<Date | null>;
  insert(row: HostSampleInsert, at?: Date): Promise<void>;
  /** Deletes rows strictly older than `cutoff`; returns the count removed. */
  deleteOlderThan(cutoff: Date): Promise<number>;
};

export function prismaSampleStore(prisma: PrismaClient): SampleStore {
  return {
    async latestAt() {
      const row = await prisma.hostSample.findFirst({
        orderBy: { at: 'desc' },
        select: { at: true },
      });
      return row?.at ?? null;
    },

    async latestDockerAt() {
      const row = await prisma.hostSample.findFirst({
        where: { dockerImages: { not: null } },
        orderBy: { at: 'desc' },
        select: { at: true },
      });
      return row?.at ?? null;
    },

    async insert(row, at) {
      await prisma.hostSample.create({ data: at ? { ...row, at } : row });
    },

    async deleteOlderThan(cutoff) {
      const { count } = await prisma.hostSample.deleteMany({
        where: { at: { lt: cutoff } },
      });
      return count;
    },
  };
}
