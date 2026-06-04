// Matches an upgrade under a forge prefix: /app/<slug>/...  The dashboard's own
// HMR (/_next/...) and other paths are NOT matched and fall through to Next.
const FORGE_PATH = /^\/app\/([^/]+)\//;

export type ForgeHmrTarget = { slug: string; path: string };

/** If `path` is a WebSocket under /app/<slug>/, return its slug + full path. */
export function forgeHmrTarget(path: string): ForgeHmrTarget | null {
  const m = FORGE_PATH.exec(path);
  if (!m) return null;
  return { slug: m[1]!, path };
}
