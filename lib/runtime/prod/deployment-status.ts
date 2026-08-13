import fs from 'node:fs/promises';
import path from 'node:path';
import { deploymentsFilePath, forgeHome } from '@/lib/runtime/paths';
import type { DeploymentStatus } from './reconciler';

/**
 * Last reconcile tick's statuses, keyed by forgeId (mirrors state.json's shape).
 *
 * Persisted rather than held in a module-level variable: Turbopack emits
 * reconciler.ts into separate chunks for instrumentation and for route
 * handlers, so a shared in-memory binding does not exist across that boundary.
 */
export type DeploymentStatusFile = Record<string, DeploymentStatus>;

export async function loadDeploymentStatuses(): Promise<DeploymentStatusFile> {
  const p = deploymentsFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as DeploymentStatusFile;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('shape');
    }
    return parsed;
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(forgeHome(), `deployments.json.corrupt-${ts}`);
    await fs.rename(p, backup).catch(() => {});
    console.error('[prod/deployment-status] deployments.json was unparseable; backed up to', backup);
    return {};
  }
}

export async function saveDeploymentStatuses(statuses: DeploymentStatus[]): Promise<void> {
  await fs.mkdir(forgeHome(), { recursive: true });
  const p = deploymentsFilePath();
  const tmp = `${p}.tmp`;
  const record: DeploymentStatusFile = {};
  for (const s of statuses) record[s.forgeId] = s;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(record, null, 2), 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, p);
}
