export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV === 'test') return;
  const { bootCleanup, startLivenessLoop } = await import('./lib/runtime/runner');
  const { startWsServer } = await import('./lib/runtime/ws-server');
  const { env } = await import('./lib/env');
  try { await bootCleanup(); }
  catch (err) { console.error('[instrumentation] bootCleanup failed', err); }

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
