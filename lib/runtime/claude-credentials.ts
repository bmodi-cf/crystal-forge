/**
 * Single seam for the credentials a `claude` agent sees inside a forge
 * container. The returned vars are injected via `docker exec -e` (they are NOT
 * inherited by a host process anymore — the agent runs in the container).
 *
 * Today: forwards the harness operator's `ANTHROPIC_API_KEY` when set.
 *
 * Future: a per-user variant will inject scoped, per-forge credentials.
 * Callers must NOT read these env vars by other means — this is the only seam.
 */
export function claudeCredentialsEnv(): Record<string, string> {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? { ANTHROPIC_API_KEY: key } : {};
}
