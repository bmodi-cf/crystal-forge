export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV === 'test') return;
  const { bootCleanup, startLivenessLoop } = await import('./lib/runtime/runner');
  const { startWsServer } = await import('./lib/runtime/ws-server');
  const { env } = await import('./lib/env');
  try { await bootCleanup(); }
  catch (err) { console.error('[instrumentation] bootCleanup failed', err); }
  startLivenessLoop();
  console.info('[instrumentation] runtime liveness loop started');
  try {
    const ws = await startWsServer({ port: env.CRYSTAL_FORGE_WS_PORT, secret: env.CRYSTAL_FORGE_WS_SECRET });
    console.info(`[instrumentation] runtime WS server listening on ${ws.port}`);
  } catch (err) {
    console.error('[instrumentation] WS server failed to start', err);
  }
}
