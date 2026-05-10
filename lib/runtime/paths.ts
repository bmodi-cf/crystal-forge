import os from 'node:os';
import path from 'node:path';
import { env } from '@/lib/env';

export function forgeHome(): string {
  return env.CRYSTAL_FORGE_HOME ?? path.join(os.homedir(), '.crystal-forge');
}

export function stateFilePath(): string {
  return path.join(forgeHome(), 'state.json');
}

export function clonesDir(): string {
  return path.join(forgeHome(), 'clones');
}

export function forgeClonePath(slug: string): string {
  return path.join(clonesDir(), slug);
}

export function logPath(slug: string): string {
  return path.join(forgeClonePath(slug), '.forge.log');
}
