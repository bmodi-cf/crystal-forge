import fs from 'node:fs/promises';
import path from 'node:path';
import { stateFilePath, forgeHome } from './paths';
import type { RuntimeStateFile } from './types';

export async function loadState(): Promise<RuntimeStateFile> {
  const p = stateFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as RuntimeStateFile;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('shape');
    }
    return parsed;
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(forgeHome(), `state.json.corrupt-${ts}`);
    await fs.rename(p, backup).catch(() => {});
    console.error('[runtime/state] state.json was unparseable; backed up to', backup);
    return {};
  }
}

export async function saveState(state: RuntimeStateFile): Promise<void> {
  const dir = forgeHome();
  await fs.mkdir(dir, { recursive: true });
  const p = stateFilePath();
  const tmp = `${p}.tmp`;
  const body = JSON.stringify(state, null, 2);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(body, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, p);
}

export async function mutateState(
  mutator: (state: RuntimeStateFile) => void | Promise<void>,
): Promise<RuntimeStateFile> {
  const state = await loadState();
  await mutator(state);
  await saveState(state);
  return state;
}

/**
 * No-ACL port lookup for trusted internal callers (e.g. the WS server).
 * Returns null if the forge isn't currently in the runtime state.
 */
export async function loadRuntimePort(forgeId: string): Promise<number | null> {
  const state = await loadState();
  return state[forgeId]?.port ?? null;
}

/** No-ACL handle lookup for trusted internal callers (WS server). */
export async function loadRuntimeHandle(
  forgeId: string,
): Promise<{ containerId: string; port: number; repoFullName?: string } | null> {
  const state = await loadState();
  const e = state[forgeId];
  return e ? { containerId: e.containerId, port: e.port, repoFullName: e.repoFullName } : null;
}
