export async function register(): Promise<void> {
  // Skip Edge / browser runtimes — runtime modules use Node stdlib.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Skip during tests — tests construct their own services.
  if (process.env.NODE_ENV === 'test') return;
  const { bootCleanup, startLivenessLoop } = await import('./lib/runtime/runner');
  try {
    await bootCleanup();
  } catch (err) {
    console.error('[instrumentation] bootCleanup failed', err);
  }
  startLivenessLoop();
  console.info('[instrumentation] runtime liveness loop started');
}
