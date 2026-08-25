// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forgeEnvFilePath, resolveForgeEnvFile } from './forge-env-file';

let dir: string;
const prevDir = process.env.FORGE_ENV_DIR;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'forge-env-'));
  process.env.FORGE_ENV_DIR = dir;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDir === undefined) delete process.env.FORGE_ENV_DIR;
  else process.env.FORGE_ENV_DIR = prevDir;
});

describe('forgeEnvFilePath', () => {
  it('is <FORGE_ENV_DIR>/<slug>.env', () => {
    expect(forgeEnvFilePath('acme-portal')).toBe(path.join(dir, 'acme-portal.env'));
  });
});

describe('resolveForgeEnvFile', () => {
  it('returns the host path when the forge has an env file', async () => {
    await writeFile(path.join(dir, 'acme-portal.env'), 'OPENAI_API_KEY=x\n');
    expect(await resolveForgeEnvFile('acme-portal')).toBe(path.join(dir, 'acme-portal.env'));
  });

  it('returns null when the forge has no env file', async () => {
    expect(await resolveForgeEnvFile('acme-portal')).toBeNull();
  });

  it('returns null when the path is a directory — docker would otherwise mount a directory over .env', async () => {
    await mkdir(path.join(dir, 'acme-portal.env'));
    expect(await resolveForgeEnvFile('acme-portal')).toBeNull();
  });
});
