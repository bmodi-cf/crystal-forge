import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { parseCpuLine, parseMeminfo } from './proc';

/** The filesystem whose capacity is tracked. This host has a single root fs. */
export const DISK_MOUNT = '/';

export type HostSnapshot = {
  cpuJiffiesTotal: bigint;
  cpuJiffiesIdle: bigint;
  cpuJiffiesIowait: bigint;
  cpuCount: number;
  memTotal: bigint;
  memAvailable: bigint;
  diskTotal: bigint;
  diskAvailable: bigint;
};

export type HostReaderDeps = {
  readText?: (path: string) => Promise<string>;
  statfsPath?: (path: string) => Promise<{ blocks: number; bavail: number; bsize: number }>;
  cpuCount?: () => number;
};

/**
 * One reading of the host. The dashboard runs as a host systemd unit, not in a
 * container (deploy/systemd/crystal-forge.service), so /proc and statfs report
 * real host figures.
 */
export async function readHostSnapshot(deps: HostReaderDeps = {}): Promise<HostSnapshot> {
  const readText = deps.readText ?? ((p: string) => readFile(p, 'utf8'));
  const statfsPath = deps.statfsPath ?? ((p: string) => statfs(p));
  const cpuCount = deps.cpuCount ?? (() => os.cpus().length);

  const [statText, memText, fs] = await Promise.all([
    readText('/proc/stat'),
    readText('/proc/meminfo'),
    statfsPath(DISK_MOUNT),
  ]);

  const cpu = parseCpuLine(statText);
  const mem = parseMeminfo(memText);
  // bsize, not frsize: Linux reports both as 4096 for ext4 and `df` reads
  // bsize, but only bsize is on Node's StatsFs type.
  const blockSize = BigInt(fs.bsize);

  return {
    cpuJiffiesTotal: cpu.total,
    cpuJiffiesIdle: cpu.idle,
    cpuJiffiesIowait: cpu.iowait,
    cpuCount: cpuCount(),
    memTotal: mem.total,
    memAvailable: mem.available,
    diskTotal: BigInt(fs.blocks) * blockSize,
    // bavail, not bfree: the difference is root-reserved and unavailable to a build.
    diskAvailable: BigInt(fs.bavail) * blockSize,
  };
}
