import type { PrismaClient } from '@prisma/client';
import { canWriteForge, forgeReadFilter, canReadForge } from '@/lib/acl';
import { ForbiddenError, NotFoundError, RuntimeBusyError } from '@/lib/errors';
import { getGitHubClient } from '@/lib/github/client';
import type { GitHubClient } from '@/lib/github/types';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { randomBytes } from 'node:crypto';
import { slugifyForgeName, slugToDbName, dbNameToRole } from '@/lib/github/slug';
import { allocatePort } from '@/lib/runtime/ports';
import { getContainerManager } from '@/lib/runtime/container';
import type { ContainerManager } from '@/lib/runtime/container/types';
import { setupForgeContainer } from '@/lib/runtime/container-setup';
import { getDatabaseProvisioner } from '@/lib/db/provisioner';
import type { DatabaseProvisioner } from '@/lib/db/types';
import { buildScopedDatabaseUrl } from '@/lib/db/url';
import { probe as defaultProbe } from '@/lib/runtime/probe';
import { mutateState, loadState } from '@/lib/runtime/state';
import { workspaceVolumeName, claudeVolumeName, CONTAINER_WORKDIR, CLAUDE_HOME, logPath as logPathFor } from '@/lib/runtime/paths';
import { env } from '@/lib/env';
import type { RuntimeStateEntry, RuntimeStateView } from '@/lib/runtime/types';
import type { SessionUser } from './types';

export type RuntimeDeps = {
  prisma: PrismaClient;
  githubClient: GitHubClient;
  containerManager: ContainerManager;
  provisioner: DatabaseProvisioner;
  setup: (mgr: ContainerManager, id: string, opts: { slug: string; repoFullName: string; token: string; logPath: string }) => Promise<void>;
  probe: (port: number) => Promise<boolean>;
  portStart: number;
  portEnd: number;
};

export type RuntimeService = {
  startForge(currentUser: SessionUser, forgeId: string): Promise<RuntimeStateEntry>;
  stopForge(currentUser: SessionUser, forgeId: string): Promise<void>;
  getRuntime(currentUser: SessionUser, forgeId: string): Promise<RuntimeStateView | null>;
  listRuntimes(currentUser: SessionUser): Promise<RuntimeStateView[]>;
};

const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 30_000;

export function makeRuntimeService(deps: RuntimeDeps): RuntimeService {
  const startInflight = new Map<string, Promise<RuntimeStateEntry>>();
  const stopInflight = new Map<string, Promise<void>>();

  async function loadForgeForAcl(forgeId: string) {
    const row = await deps.prisma.forge.findUnique({
      where: { id: forgeId },
      include: { groups: { include: { group: true } } },
    });
    if (!row) throw new NotFoundError('forge', forgeId);
    return {
      id: row.id,
      name: row.name,
      repoFullName: row.repoFullName,
      createdById: row.createdById,
      groupNames: row.groups.map((g) => g.group.name),
    };
  }

  function aclFor(row: { id: string; createdById: string; groupNames: string[] }) {
    return { id: row.id, createdById: row.createdById, groups: row.groupNames };
  }

  type BeginResult =
    | { launch: false; entry: RuntimeStateEntry }
    | { launch: true; entry: RuntimeStateEntry; repoFullName: string; dbName: string; role: string };

  // Fast phase: ACL + dispatch on existing state + write the 'starting' entry.
  // Returns synchronously enough to answer the HTTP request; the caller then
  // runs finishStart in the background. Access/not-found errors surface here.
  async function beginStart(currentUser: SessionUser, forgeId: string): Promise<BeginResult> {
    const row = await loadForgeForAcl(forgeId);
    if (!canWriteForge(currentUser, aclFor(row))) {
      throw new ForbiddenError(`Cannot start forge ${forgeId}`);
    }

    const slug = slugifyForgeName(row.name);

    // Dispatch on existing entry status.
    const state = await loadState();
    const existing = state[forgeId];
    if (existing) {
      if (existing.status === 'running' || existing.status === 'starting') {
        return { launch: false, entry: existing };
      }
      if (existing.status === 'stopping') {
        throw new RuntimeBusyError('Forge is currently stopping; try again shortly');
      }
      // crashed / setup-failed → clear and continue to fresh start.
      await mutateState((s) => { delete s[forgeId]; });
    }

    const port = await allocatePort({ start: deps.portStart, end: deps.portEnd });
    const startedAt = new Date().toISOString();
    const log = logPathFor(slug);
    const dbName = slugToDbName(slug);
    const role = dbNameToRole(dbName);

    const baseEntry: RuntimeStateEntry = {
      forgeId, slug, status: 'starting',
      containerId: '', port, startedAt, logPath: log,
    };
    await mutateState((s) => { s[forgeId] = baseEntry; });
    return { launch: true, entry: baseEntry, repoFullName: row.repoFullName, dbName, role };
  }

  // Slow phase: provision DB role, create + set up the container, launch the
  // production supervisor, and probe for health. Runs in the background after
  // beginStart; records the terminal status (running / setup-failed / crashed)
  // in state for the client poller. The liveness loop is the backstop if this
  // throws before writing a terminal status.
  async function finishStart(
    forgeId: string,
    baseEntry: RuntimeStateEntry,
    repoFullName: string,
    dbName: string,
    role: string,
  ): Promise<void> {
    const { slug, port, logPath: log } = baseEntry;

    // Ensure the scoped role exists before rotating its password. The role is
    // normally created at forge creation (provisionRole), but a forge whose
    // role is missing — created before role-provisioning, a reset DB, or a
    // partial creation — would otherwise crash here: setRolePassword issues an
    // ALTER ROLE, which errors if the role doesn't exist. provisionRole is
    // idempotent (CREATE ROLE IF NOT EXISTS), so calling it every start
    // self-heals without affecting forges whose role is already present.
    const password = randomBytes(24).toString('hex');
    await deps.provisioner.provisionRole(dbName, role);
    await deps.provisioner.setRolePassword(role, password);
    const databaseUrl = buildScopedDatabaseUrl({ role, password, database: dbName });

    const containerId = await deps.containerManager.create({
      name: `forge-${slug}`,
      image: env.FORGE_RUNTIME_IMAGE,
      labels: { 'crystal-forge.forgeId': forgeId },
      env: {
        PORT: '3000',
        NEXT_TELEMETRY_DISABLED: '1',
        FORGE_BASE_PATH: `/app/${slug}`,
        FORGE_DEV_ORIGINS: env.FORGE_DEV_ORIGINS,
        DATABASE_URL: databaseUrl,
        // PAT for the agent's own git/gh operations. `gh` reads GH_TOKEN
        // automatically; container-setup runs `gh auth setup-git` so plain git
        // does too. Only injected when configured (empty would confuse gh).
        ...(env.FORGE_GIT_TOKEN ? { GH_TOKEN: env.FORGE_GIT_TOKEN } : {}),
      },
      publish: { hostIp: '127.0.0.1', hostPort: port, containerPort: 3000 },
      volumes: [
        { volume: workspaceVolumeName(slug), target: CONTAINER_WORKDIR },
        // Persist the agent's Claude home (login + conversation transcripts) so
        // it survives container recreation — no forced re-login, --resume works.
        { volume: claudeVolumeName(slug), target: CLAUDE_HOME },
      ],
      network: env.FORGE_NETWORK,
    });
    await mutateState((s) => { const e = s[forgeId]; if (e) e.containerId = containerId; });

    try {
      const token = await deps.githubClient.getInstallationToken();
      await deps.setup(deps.containerManager, containerId, { slug, repoFullName, token, logPath: log });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.containerManager.remove(containerId).catch(() => {});
      await mutateState((s) => { s[forgeId] = { ...baseEntry, containerId, status: 'setup-failed', setupError: msg }; });
      return; // terminal state recorded; the client poller surfaces it
    }

    // Start the dev server under a restart-loop supervisor so a crash self-heals
    // instead of freezing the preview. Dev mode gives agent edits instant Fast
    // Refresh; its HMR WebSocket reaches the browser through the dashboard's
    // forge-HMR tunnel (server.ts → lib/runtime/hmr-proxy.ts). Detached: the
    // loop keeps running in the container (reparented to PID 1) after this
    // exec returns.
    await deps.containerManager.exec(containerId, 'sh',
      ['-c', `while true; do pnpm dev --port 3000; echo "[forge] dev server exited (code $?); restarting in 2s"; sleep 2; done >> ${CONTAINER_WORKDIR}/.forge-dev.log 2>&1`],
      { workdir: CONTAINER_WORKDIR, detached: true });

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await deps.probe(port)) {
        const final: RuntimeStateEntry = { ...baseEntry, containerId, status: 'running' };
        let written = false;
        await mutateState((s) => { if (s[forgeId]) { s[forgeId] = final; written = true; } });
        if (!written) {
          // The entry was deleted mid-start (a concurrent stopForge won the
          // race). Don't resurrect it — tear the container back down and stop.
          await deps.containerManager.remove(containerId).catch(() => {});
        }
        return;
      }
      await sleep(PROBE_INTERVAL_MS);
    }
    // Didn't become healthy within PROBE_TIMEOUT_MS — record crashed and stop.
    // The client poller surfaces it; the supervisor inside the container keeps
    // trying to build/start, so a later manual restart can still succeed.
    await deps.containerManager.remove(containerId).catch(() => {});
    await mutateState((s) => { const e = s[forgeId]; if (e) e.status = 'crashed'; });
  }

  async function doStop(currentUser: SessionUser, forgeId: string): Promise<void> {
    const row = await loadForgeForAcl(forgeId);
    if (!canWriteForge(currentUser, aclFor(row))) {
      throw new ForbiddenError(`Cannot stop forge ${forgeId}`);
    }
    const state = await loadState();
    const entry = state[forgeId];
    if (!entry) return; // idempotent
    await mutateState((s) => {
      const e = s[forgeId];
      if (e) e.status = 'stopping';
    });
    if (entry.containerId) {
      try { await deps.containerManager.stop(entry.containerId); await deps.containerManager.remove(entry.containerId); }
      catch (err) { console.error('[runtime/stopForge] container teardown failed', { id: entry.containerId, err }); }
    }
    await mutateState((s) => { delete s[forgeId]; });
  }

  return {
    async startForge(currentUser, forgeId) {
      const cached = startInflight.get(forgeId);
      if (cached) return cached;
      // Resolve once the 'starting' entry is written, then bring the forge up in
      // the background. The HTTP request returns promptly (avoiding a gateway
      // timeout on the slow container build); the client polls /api/forges/runtime
      // for the starting → running/crashed/setup-failed transition. Concurrent
      // starts collapse onto this promise during the begin phase; once it clears,
      // the persisted 'starting' state keeps a second start from launching twice.
      const p = beginStart(currentUser, forgeId).then((begun) => {
        if (begun.launch) {
          void finishStart(forgeId, begun.entry, begun.repoFullName, begun.dbName, begun.role)
            .catch((err) => { console.error('[runtime] forge bring-up failed', forgeId, err); });
        }
        return begun.entry;
      });
      startInflight.set(forgeId, p);
      void p.catch(() => {}).finally(() => startInflight.delete(forgeId));
      return p;
    },

    async stopForge(currentUser, forgeId) {
      const cached = stopInflight.get(forgeId);
      if (cached) return cached;
      const p = doStop(currentUser, forgeId)
        .finally(() => stopInflight.delete(forgeId));
      stopInflight.set(forgeId, p);
      return p;
    },

    async getRuntime(currentUser, forgeId) {
      const row = await loadForgeForAcl(forgeId);
      if (!canReadForge(currentUser, aclFor(row))) {
        throw new ForbiddenError(`Cannot read forge ${forgeId}`);
      }
      const state = await loadState();
      const entry = state[forgeId];
      if (!entry) return null;
      return toView(entry, canWriteForge(currentUser, aclFor(row)));
    },

    async listRuntimes(currentUser) {
      const visible = await deps.prisma.forge.findMany({
        where: forgeReadFilter(currentUser),
        include: { groups: { include: { group: true } } },
      });
      const idToWriteable = new Map<string, boolean>();
      for (const f of visible) {
        const acl = { id: f.id, createdById: f.createdById, groups: f.groups.map((g) => g.group.name) };
        idToWriteable.set(f.id, canWriteForge(currentUser, acl));
      }
      const state = await loadState();
      const out: RuntimeStateView[] = [];
      for (const [forgeId, writable] of idToWriteable) {
        const entry = state[forgeId];
        if (!entry) continue;
        out.push(toView(entry, writable));
      }
      return out;
    },
  };
}

/**
 * Project a state entry to its client-facing view. `logPath` (a host path) is
 * always stripped; `containerId` is kept only for writers.
 */
function toView(e: RuntimeStateEntry, canWrite: boolean): RuntimeStateView {
  const { logPath: _log, containerId, ...rest } = e;
  return canWrite ? { ...rest, containerId } : rest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let cached: RuntimeService | null = null;

export function getRuntimeService(): RuntimeService {
  if (cached) return cached;
  cached = makeRuntimeService({
    prisma: defaultPrisma,
    githubClient: getGitHubClient(),
    containerManager: getContainerManager(),
    provisioner: getDatabaseProvisioner(),
    setup: setupForgeContainer,
    probe: defaultProbe,
    portStart: 3001,
    portEnd: 3099,
  });
  return cached;
}

export function resetRuntimeService(): void {
  cached = null;
}

/**
 * Load the ACL fields needed by the preview-proxy route without throwing.
 * Returns null when the forge does not exist.
 */
export async function loadForgeAcl(
  forgeId: string,
): Promise<{ id: string; createdById: string; groups: string[] } | null> {
  const row = await defaultPrisma.forge.findUnique({
    where: { id: forgeId },
    include: { groups: { include: { group: true } } },
  });
  if (!row) return null;
  return {
    id: row.id,
    createdById: row.createdById,
    groups: row.groups.map((g) => g.group.name),
  };
}
