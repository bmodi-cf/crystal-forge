import { randomBytes } from 'node:crypto';
import type { ContainerManager } from '@/lib/runtime/container/types';
import type { DatabaseProvisioner } from '@/lib/db/types';
import { buildScopedDatabaseUrl } from '@/lib/db/url';
import { allocatePort as realAllocatePort } from '@/lib/runtime/ports';
import { env } from '@/lib/env';

export type ProdRuntimeDeps = {
  containerManager: ContainerManager;
  provisioner: DatabaseProvisioner;
  probe: (port: number) => Promise<boolean>;
  allocatePort?: () => Promise<number>;
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
};

export type ProdStartInput = {
  forgeId: string;
  slug: string;
  deployVersion: string;
  dbName: string;
  role: string;
};

const DEFAULT_PROBE_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function registryHost(): string {
  return process.env.REGISTRY_HOST ?? 'registry.crystalfountains.com';
}

/**
 * Start ONE forge from its pinned production image. Unlike the dev flow there
 * is no clone, no pnpm install, no Claude, no dev-server supervisor: the image
 * is prebuilt and its own entrypoint runs `prisma migrate deploy` + the prod
 * server. We only provision the per-forge DB, inject DATABASE_URL, create the
 * container, and probe for health.
 */
export async function startForgeContainer(
  deps: ProdRuntimeDeps,
  input: ProdStartInput,
): Promise<{ containerId: string; port: number }> {
  const { forgeId, slug, deployVersion, dbName, role } = input;

  // Per-forge prod DB: create it, then idempotent role, fresh password, scoped URL.
  // Unlike dev (where createForge creates the DB at forge-creation time), prod
  // forges are enabled declaratively — a row flipped to deployEnabled via SQL or
  // promotion, never through createForge — so the DB may not exist yet. Create it
  // idempotently; the pinned image's entrypoint runs `prisma migrate deploy`
  // against it. provisionRole then grants the role ALL on schema public.
  const password = randomBytes(24).toString('hex');
  try {
    await deps.provisioner.createDatabase(dbName);
  } catch (err) {
    if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  await deps.provisioner.provisionRole(dbName, role);
  await deps.provisioner.setRolePassword(role, password);
  const databaseUrl = buildScopedDatabaseUrl({ role, password, database: dbName });

  const allocate = deps.allocatePort ?? (() => realAllocatePort({ start: 3200, end: 3999 }));
  const port = await allocate();

  const image = `${registryHost()}/${slug}:${deployVersion}`;
  const containerId = await deps.containerManager.create({
    name: `forge-${slug}`,
    image,
    labels: {
      'crystal-forge.forgeId': forgeId,
      'crystal-forge.version': deployVersion,
      'crystal-forge.port': String(port),
    },
    env: {
      PORT: '3000',
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      FORGE_BASE_PATH: `/app/${slug}`,
      FORGE_DEV_ORIGINS: env.FORGE_DEV_ORIGINS,
      DATABASE_URL: databaseUrl,
      // No GH_TOKEN: prod does no git.
    },
    publish: { hostIp: '127.0.0.1', hostPort: port, containerPort: 3000 },
    volumes: [], // no workspace volume, no Claude volume
    network: env.FORGE_NETWORK,
    // No command: run the image's baked entrypoint.
  });

  const timeout = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const interval = deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await deps.probe(port)) return { containerId, port };
    await sleep(interval);
  }
  await deps.containerManager.remove(containerId).catch(() => {});
  throw new Error(`forge ${slug} did not become healthy within ${timeout}ms`);
}

export async function stopForgeContainer(
  deps: Pick<ProdRuntimeDeps, 'containerManager'>,
  containerId: string,
): Promise<void> {
  await deps.containerManager.stop(containerId).catch(() => {});
  await deps.containerManager.remove(containerId).catch(() => {});
}
