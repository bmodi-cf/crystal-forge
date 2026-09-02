import { describe, it, expect } from 'vitest';
import { readHostSnapshot } from './read';

const PROC_STAT = 'cpu  6071251 13104 4865847 109790958 906528 0 105246 0 0 0\n';
const MEMINFO = 'MemTotal:       16373060 kB\nMemAvailable:    6505424 kB\n';

// Real statfs('/') output from the pilot host. bavail < bfree: the difference
// is root-reserved and must NOT be reported as free.
const STATFS = { blocks: 65506593, bfree: 33875802, bavail: 30530049, frsize: 4096 };

function deps(overrides: Partial<Parameters<typeof readHostSnapshot>[0]> = {}) {
  return {
    readText: async (p: string) => {
      if (p === '/proc/stat') return PROC_STAT;
      if (p === '/proc/meminfo') return MEMINFO;
      throw new Error(`unexpected read: ${p}`);
    },
    statfsPath: async () => STATFS,
    cpuCount: () => 1,
    ...overrides,
  };
}

describe('readHostSnapshot', () => {
  it('assembles jiffies, memory bytes and disk bytes', async () => {
    await expect(readHostSnapshot(deps())).resolves.toEqual({
      cpuJiffiesTotal: 121_752_934n,
      cpuJiffiesIdle: 109_790_958n,
      cpuJiffiesIowait: 906_528n,
      cpuCount: 1,
      memTotal: 16_766_013_440n,
      memAvailable: 6_661_554_176n,
      diskTotal: 268_315_004_928n,
      diskAvailable: 125_051_080_704n,
    });
  });

  it('uses bavail, not bfree', async () => {
    const snap = await readHostSnapshot(deps());
    // bfree would give 138,755,284,992 — larger, and wrong.
    expect(snap.diskAvailable).toBe(BigInt(STATFS.bavail) * BigInt(STATFS.frsize));
  });

  it('propagates a /proc read failure so the sampler can skip the tick', async () => {
    await expect(
      readHostSnapshot(deps({ readText: async () => { throw new Error('EACCES'); } })),
    ).rejects.toThrow(/EACCES/);
  });
});
