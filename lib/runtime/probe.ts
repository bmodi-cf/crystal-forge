import http from 'node:http';

/** Delay between health-probe attempts during bring-up. */
export const PROBE_INTERVAL_MS = 1000;

/**
 * Overall health-probe deadline, measured from the moment the dev server is
 * exec'd (i.e. AFTER the setup phase). The pilot host has a single vCPU:
 * several forges starting at once can keep a perfectly healthy dev server from
 * binding its port for a long stretch. Give bring-up minutes, not seconds.
 */
export const PROBE_TIMEOUT_MS = 120_000;

/**
 * Budget for the setup phase — clone, `pnpm install`, `prisma generate` — which
 * runs BEFORE the probe deadline starts counting. Not enforced anywhere; it
 * exists solely to size the liveness backstop below.
 */
export const SETUP_BUDGET_MS = 600_000;

/**
 * Liveness backstop for an entry wedged in `starting`.
 *
 * finishStart writes a terminal status on every path it controls
 * (`setup-failed`, `running`, `crashed`), so this only needs to catch a
 * bring-up that died *without* recording one — a dashboard restart mid-start,
 * or an unhandled throw. That makes a generous value nearly free, while a tight
 * one is actively harmful: it fires while a healthy slow start is still
 * converging and reports a false `crashed`.
 *
 * It MUST therefore stay larger than finishStart's worst case (setup + probe).
 * Deriving it keeps the two from drifting apart — exactly the regression that
 * shipped in 21b8531, which raised the probe deadline 30s -> 120s while this
 * stayed a hardcoded 60s, so it began firing mid-bring-up on every cold start.
 */
export const STARTING_TIMEOUT_MS = SETUP_BUDGET_MS + PROBE_TIMEOUT_MS;

export function probe(port: number, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  // Generous default: on a loaded host (several forges compiling at once) a
  // healthy dev server can legitimately take multiple seconds to answer.
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs },
      (res) => {
        // Any response — even 404/500 — means a process is listening.
        res.resume();
        finish(true);
      },
    );
    req.once('error', () => finish(false));
    req.once('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.end();
  });
}
