import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where the prod forge image reads its env file. Next's standalone server
 * (`node server.js`) chdir's to /app and `next-server.js` calls loadEnvConfig
 * against that directory at boot, so /app/.env — and only /app/.env — is picked
 * up. A config file anywhere else in the container would simply be ignored.
 */
export const CONTAINER_ENV_PATH = '/app/.env';

const DEFAULT_ENV_DIR = '/etc/crystal-forge/forge-env';

/**
 * Host directory holding per-forge env files. Read from process.env at call
 * time (not the parsed env snapshot) so it is test-settable, mirroring how
 * prod-runtime.ts reads process.env.REGISTRY_HOST.
 */
function envDir(): string {
  return process.env.FORGE_ENV_DIR ?? DEFAULT_ENV_DIR;
}

/** Host path of a forge's env file. Not a promise that it exists. */
export function forgeEnvFilePath(slug: string): string {
  return path.join(envDir(), `${slug}.env`);
}

/**
 * The forge's env file, or null when it is absent or is not a regular file.
 *
 * The regular-file check is load-bearing, not defensive: `docker create -v
 * /missing/path:/app/.env` silently creates a *directory* at both ends, and the
 * forge then boots with a directory where its env file should be. Skipping the
 * mount entirely is the correct fallback — the forge starts exactly as it does
 * today, just without the extra vars.
 */
export async function resolveForgeEnvFile(slug: string): Promise<string | null> {
  const file = forgeEnvFilePath(slug);
  try {
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null; // ENOENT, and any other stat failure: treat as "no env file".
  }
}
