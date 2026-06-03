import type { PrismaClient } from '@prisma/client';
import { canWriteForge, forgeReadFilter, canReadForge } from '@/lib/acl';
import { ForbiddenError, NotFoundError, RuntimeBusyError } from '@/lib/errors';
import { getGitHubClient } from '@/lib/github/client';
import type { GitHubClient } from '@/lib/github/types';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { slugifyForgeName } from '@/lib/github/slug';
import { allocatePort } from '@/lib/runtime/ports';
import { ensureClone as defaultClone } from '@/lib/runtime/clone';
import { spawnLongLived as defaultSpawn, killProcess as defaultKill, isAlive as defaultIsAlive } from '@/lib/runtime/process';
import { probe as defaultProbe } from '@/lib/runtime/probe';
import { mutateState, loadState } from '@/lib/runtime/state';
import { forgeClonePath, logPath as logPathFor } from '@/lib/runtime/paths';
import type { RuntimeStateEntry, RuntimeStateView } from '@/lib/runtime/types';
import type { SessionUser } from './types';

export type RuntimeDeps = {
  prisma: PrismaClient;
  githubClient: GitHubClient;
  clone: (forge: { slug: string; repoFullName: string }, gh: GitHubClient) => Promise<void>;
  spawnLongLived: (cmd: string, args: string[], opts: { cwd: string; logPath: string; env?: Record<string, string> }) => number;
  killProcess: (pid: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
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

  async function doStart(currentUser: SessionUser, forgeId: string): Promise<RuntimeStateEntry> {
    const row = await loadForgeForAcl(forgeId);
    if (!canWriteForge(currentUser, aclFor(row))) {
      throw new ForbiddenError(`Cannot start forge ${forgeId}`);
    }

    const slug = slugifyForgeName(row.name);

    // Dispatch on existing entry status.
    const state = await loadState();
    const existing = state[forgeId];
    if (existing) {
      if (existing.status === 'running' || existing.status === 'starting') return existing;
      if (existing.status === 'stopping') {
        throw new RuntimeBusyError('Forge is currently stopping; try again shortly');
      }
      // crashed / setup-failed → clear and continue to fresh start.
      await mutateState((s) => { delete s[forgeId]; });
    }

    const port = await allocatePort({ start: deps.portStart, end: deps.portEnd });
    const startedAt = new Date().toISOString();
    const log = logPathFor(slug);

    const baseEntry: RuntimeStateEntry = {
      forgeId, slug, status: 'starting',
      pid: 0, port, startedAt, logPath: log,
    };
    await mutateState((s) => { s[forgeId] = baseEntry; });

    try {
      await deps.clone({ slug, repoFullName: row.repoFullName }, deps.githubClient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await mutateState((s) => {
        s[forgeId] = { ...baseEntry, status: 'setup-failed', setupError: msg };
      });
      throw err;
    }

    const pid = deps.spawnLongLived(
      'pnpm',
      ['dev', '--port', String(port)],
      {
        cwd: forgeClonePath(slug),
        logPath: log,
        env: {
          PORT: String(port),
          NEXT_TELEMETRY_DISABLED: '1',
          FORGE_BASE_PATH: `/app/${slug}`,
        },
      },
    );
    await mutateState((s) => {
      const e = s[forgeId];
      if (e) e.pid = pid;
    });

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await deps.probe(port)) {
        const final: RuntimeStateEntry = { ...baseEntry, pid, status: 'running' };
        let written = false;
        await mutateState((s) => {
          if (s[forgeId]) {
            s[forgeId] = final;
            written = true;
          }
        });
        if (!written) {
          // Entry was deleted (probably by a concurrent stopForge). Kill the
          // dev-server we just spawned so we don't leak it.
          await deps.killProcess(pid).catch(() => {});
          throw new RuntimeBusyError('Forge was stopped while starting');
        }
        return final;
      }
      await sleep(PROBE_INTERVAL_MS);
    }
    await deps.killProcess(pid).catch(() => {});
    await mutateState((s) => {
      const e = s[forgeId];
      if (e) e.status = 'crashed';
    });
    throw new Error(`Forge ${slug} failed to become healthy within ${PROBE_TIMEOUT_MS}ms`);
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
    if (entry.pid > 0) {
      try { await deps.killProcess(entry.pid); } catch (err) {
        console.error('[runtime/stopForge] kill failed', { pid: entry.pid, err });
      }
    }
    await mutateState((s) => { delete s[forgeId]; });
  }

  return {
    async startForge(currentUser, forgeId) {
      const cached = startInflight.get(forgeId);
      if (cached) return cached;
      const p = doStart(currentUser, forgeId)
        .finally(() => startInflight.delete(forgeId));
      startInflight.set(forgeId, p);
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
      return canWriteForge(currentUser, aclFor(row)) ? entry : redactPid(entry);
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
        out.push(writable ? entry : redactPid(entry));
      }
      return out;
    },
  };
}

function redactPid(e: RuntimeStateEntry): RuntimeStateView {
  const { pid: _drop, ...rest } = e;
  return rest;
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
    clone: async (forge, gh) => { await defaultClone(forge, gh); },
    spawnLongLived: defaultSpawn,
    killProcess: defaultKill,
    isAlive: defaultIsAlive,
    probe: defaultProbe,
    portStart: 3001,
    portEnd: 3099,
  });
  return cached;
}

export function resetRuntimeService(): void {
  cached = null;
}
