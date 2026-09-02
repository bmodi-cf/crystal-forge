export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV === 'test') return;
  const { reconcileForges, startLivenessLoop } = await import('./lib/runtime/runner');
  const { startWsServer } = await import('./lib/runtime/ws-server');
  const { env } = await import('./lib/env');

  // Harden the dashboard's own database: it is created by docker-compose /
  // migrations (not via the provisioner), so it keeps Postgres' default PUBLIC
  // CONNECT grant — which would let any scoped forge role connect to it. Revoke
  // it here (idempotent; the dashboard connects as a superuser, which bypasses
  // the check). Forge databases are already hardened in provisionRole.
  try {
    const { getDatabaseProvisioner } = await import('./lib/db/provisioner');
    const dashboardDb = new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
    if (dashboardDb) {
      await getDatabaseProvisioner().hardenDatabase(dashboardDb);
      console.info(`[instrumentation] hardened dashboard DB "${dashboardDb}" (revoked PUBLIC connect)`);
    }
  } catch (err) {
    console.error('[instrumentation] dashboard DB hardening failed', err);
  }

  // Host usage sampler for /admin/usage. Runs in both modes — each dashboard
  // samples the host it runs on. Wrapped so a sampler failure can never keep
  // the dashboard from booting.
  if (env.FORGE_USAGE_SAMPLE_MS > 0) {
    try {
      const { startUsageSampler, DOCKER_SAMPLE_INTERVAL_MS } = await import('./lib/host/sampler');
      const { prismaSampleStore } = await import('./lib/host/store');
      const { readHostSnapshot } = await import('./lib/host/read');
      const { getContainerManager } = await import('@/lib/runtime/container');
      const { FORGE_LABEL } = await import('./lib/runtime/runner');
      const { prisma } = await import('./lib/prisma');
      const mgr = getContainerManager();
      startUsageSampler(
        {
          store: prismaSampleStore(prisma),
          readSnapshot: () => readHostSnapshot(),
          readDocker: () => mgr.diskUsage(),
          countRunningForges: async () =>
            (await mgr.list({ label: FORGE_LABEL, running: true })).length,
        },
        {
          intervalMs: env.FORGE_USAGE_SAMPLE_MS,
          retentionDays: env.FORGE_USAGE_RETENTION_DAYS,
          dockerIntervalMs: DOCKER_SAMPLE_INTERVAL_MS,
        },
      );
      console.info('[instrumentation] host usage sampler started');
    } catch (err) {
      console.error('[instrumentation] usage sampler failed to start', err);
    }
  }

  const mode = process.env.FORGE_DASHBOARD_MODE === 'prod' ? 'prod' : 'dev';

  if (mode === 'prod') {
    // Prod: declarative reconcile loop. Do NOT run the dev boot path (adopt
    // surviving forges / liveness loop / WS server) — prod containers are
    // managed by the reconcile loop, and the WS/PTY server is not started here.
    const { startReconcileLoop } = await import('./lib/runtime/prod/reconciler');
    const { startForgeContainer, stopForgeContainer } = await import('./lib/runtime/prod/prod-runtime');
    const { getContainerManager } = await import('./lib/runtime/container');
    const { getDatabaseProvisioner } = await import('./lib/db/provisioner');
    const { probe } = await import('./lib/runtime/probe');
    const { prisma } = await import('./lib/prisma');
    const containerManager = getContainerManager();
    const provisioner = getDatabaseProvisioner();
    const prodDeps = { containerManager, provisioner, probe };
    startReconcileLoop(
      {
        prisma,
        containerManager,
        start: (d) => startForgeContainer(prodDeps, d),
        stop: (id) => stopForgeContainer(prodDeps, id),
      },
      env.FORGE_RECONCILE_INTERVAL_MS,
    );
    console.info('[instrumentation] prod reconcile loop started');
    return;
  }

  // Dev (unchanged): reconcile surviving forges + liveness loop + WS server.
  // Reconcile persisted runtime state against Docker so forges that survived a
  // dashboard restart are adopted back as running (reachable immediately via
  // the file-backed proxy/HMR lookups), while dead containers and stale entries
  // are cleaned up. forgeLookup resolves an orphan container's forgeId to its
  // slug + repo from the DB — the canonical source, not the container name.
  try {
    const { prisma } = await import('./lib/prisma');
    const { slugifyForgeName } = await import('./lib/github/slug');
    await reconcileForges({
      forgeLookup: async (forgeId) => {
        const row = await prisma.forge.findUnique({
          where: { id: forgeId },
          select: { name: true, repoFullName: true },
        });
        return row ? { slug: slugifyForgeName(row.name), repoFullName: row.repoFullName } : null;
      },
    });
  } catch (err) { console.error('[instrumentation] reconcileForges failed', err); }

  startLivenessLoop();
  console.info('[instrumentation] runtime liveness loop started');
  try {
    const { getGitHubClient } = await import('@/lib/github/client');
    const { getContainerManager } = await import('@/lib/runtime/container');
    const { createTokenRefresher } = await import('./lib/runtime/token-refresher');
    const { writeForgeGitToken } = await import('./lib/runtime/gh-credential');

    const github = getGitHubClient();
    const mgr = getContainerManager();
    const tokenRefresher = createTokenRefresher({
      mint: (repo) => github.getScopedInstallationToken(repo),
      write: (id, token) => writeForgeGitToken(mgr, id, token),
      onError: (id, err) => console.error('[runtime/token] refresh failed for', id, err),
    });

    const ws = await startWsServer({
      port: env.CRYSTAL_FORGE_WS_PORT,
      secret: env.CRYSTAL_FORGE_WS_SECRET,
      tokenRefresher,
    });
    console.info(`[instrumentation] runtime WS server listening on ${ws.port}`);
  } catch (err) {
    console.error('[instrumentation] WS server failed to start', err);
  }
}
