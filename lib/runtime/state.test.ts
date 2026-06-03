// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, mutateState, loadRuntimePort, loadRuntimeHandle } from './state';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-state-'));
  prevHome = process.env.CRYSTAL_FORGE_HOME;
  process.env.CRYSTAL_FORGE_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CRYSTAL_FORGE_HOME;
  else process.env.CRYSTAL_FORGE_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('runtime state', () => {
  it('loadState returns an empty object when the file is missing', async () => {
    const s = await loadState();
    expect(s).toEqual({});
  });

  it('saveState writes atomically and loadState reads it back', async () => {
    await saveState({
      f1: {
        forgeId: 'f1', slug: 'foo', status: 'running',
        containerId: 'c1234', port: 3001, startedAt: '2026-05-09T00:00:00.000Z',
        logPath: '/tmp/x.log',
      },
    });
    const s = await loadState();
    expect(s['f1']?.status).toBe('running');
    // Tmp file should not be left behind.
    const files = await fs.readdir(tmp);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('mutateState applies the mutator and persists', async () => {
    await mutateState((s) => {
      s['f1'] = {
        forgeId: 'f1', slug: 'foo', status: 'starting',
        containerId: '', port: 3002, startedAt: '2026-05-09T00:00:00.000Z',
        logPath: '/tmp/x.log',
      };
    });
    const s = await loadState();
    expect(s['f1']?.status).toBe('starting');
  });

  it('loadRuntimePort returns the port for a known forge, null otherwise', async () => {
    await saveState({
      'forge-xyz': {
        forgeId: 'forge-xyz', slug: 'demo', status: 'running',
        containerId: 'c1234', port: 3002, startedAt: '2026-05-13T00:00:00.000Z',
        logPath: '/tmp/demo.log',
      },
    });
    expect(await loadRuntimePort('forge-xyz')).toBe(3002);
    expect(await loadRuntimePort('forge-missing')).toBeNull();
  });

  it('loadRuntimeHandle returns containerId and port for a known forge', async () => {
    await mutateState((s) => {
      s['f1'] = {
        forgeId: 'f1', slug: 'x', status: 'running',
        containerId: 'c123', port: 3042, startedAt: 'now', logPath: '/tmp/x.log',
      };
    });
    expect(await loadRuntimeHandle('f1')).toEqual({ containerId: 'c123', port: 3042 });
    expect(await loadRuntimeHandle('missing')).toBeNull();
  });

  it('loadState backs up corrupt files and returns empty state', async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(path.join(tmp, 'state.json'), 'this is not json', 'utf8');
    const s = await loadState();
    expect(s).toEqual({});
    const files = await fs.readdir(tmp);
    expect(files.some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });
});
