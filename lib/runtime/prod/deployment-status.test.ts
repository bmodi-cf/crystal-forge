// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deploymentsFilePath } from '@/lib/runtime/paths';
import { loadDeploymentStatuses, saveDeploymentStatuses } from './deployment-status';
import type { DeploymentStatus } from './reconciler';

let tmp: string;
let prevHome: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-depstatus-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

const SAMPLE: DeploymentStatus = {
  forgeId: 'f1', slug: 'acme', name: 'Acme',
  desiredVersion: 'v1.2.3', runningVersion: 'v1.2.3',
  phase: 'running', error: null, consecutiveFailures: 0,
};

describe('deployment status snapshot', () => {
  it('returns an empty record when the file does not exist', async () => {
    expect(await loadDeploymentStatuses()).toEqual({});
  });

  it('round-trips statuses keyed by forgeId', async () => {
    await saveDeploymentStatuses([SAMPLE]);
    expect(await loadDeploymentStatuses()).toEqual({ f1: SAMPLE });
  });

  it('replaces the previous snapshot rather than merging into it', async () => {
    await saveDeploymentStatuses([SAMPLE]);
    await saveDeploymentStatuses([{ ...SAMPLE, forgeId: 'f2', slug: 'beta', name: 'Beta' }]);
    const snap = await loadDeploymentStatuses();
    expect(Object.keys(snap)).toEqual(['f2']);
  });

  it('backs up an unparseable file and returns empty', async () => {
    await fs.writeFile(deploymentsFilePath(), 'not json', 'utf8');
    expect(await loadDeploymentStatuses()).toEqual({});
    const files = await fs.readdir(tmp);
    expect(files.some((f) => f.startsWith('deployments.json.corrupt-'))).toBe(true);
  });
});
