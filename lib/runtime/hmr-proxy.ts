import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { SessionUser } from '@/lib/services/types';
import type { RuntimeStateFile } from './types';
import { runtimeOrigin } from './proxy-target';
import { parseCookieHeader, sessionTokenFromCookies } from '@/lib/auth/upgrade-cookie';

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

export type ForgeAcl = { id: string; createdById: string; groups: string[] };

export type HmrUpgradeDeps = {
  getUserBySessionToken: (token: string) => Promise<SessionUser | null>;
  loadState: () => Promise<RuntimeStateFile>;
  loadForgeAcl: (forgeId: string) => Promise<ForgeAcl | null>;
  canReadForge: (user: SessionUser, acl: ForgeAcl) => boolean;
  /** Open the upstream forge socket and pipe frames. Injected for tests. */
  tunnel: (targetWsUrl: string, req: IncomingMessage, socket: Socket, head: Buffer, dashboardOrigin: string) => void;
};

/** ws origin the forge's allowedDevOrigins must trust (the page's own origin). */
function dashboardOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

export async function handleForgeHmrUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  deps: HmrUpgradeDeps,
): Promise<void> {
  const kill = (reason: string) => {
    console.warn('[hmr-proxy] rejected upgrade:', reason, req.url);
    try { socket.destroy(); } catch { /* noop */ }
  };
  const target = forgeHmrTarget(req.url ?? '');
  if (!target) return kill('no-target');

  const token = sessionTokenFromCookies(parseCookieHeader(req.headers.cookie));
  if (!token) return kill('no-token');
  try {
    const user = await deps.getUserBySessionToken(token);
    if (!user) return kill('no-user');

    const state = await deps.loadState();
    const entry = Object.values(state).find((e) => e.slug === target.slug && e.status === 'running');
    if (!entry) return kill('no-entry');

    const acl = await deps.loadForgeAcl(entry.forgeId);
    if (!acl || !deps.canReadForge(user, acl)) return kill('acl-denied');

    const wsBase = runtimeOrigin(entry.port).replace(/^http/, 'ws');
    deps.tunnel(wsBase + target.path, req, socket, head, dashboardOrigin(req));
  } catch (err) {
    console.warn('[hmr-proxy] upgrade error:', (err as Error)?.message ?? err, req.url);
    try { socket.destroy(); } catch { /* noop */ }
  }
}

/** Real upstream tunnel: accept the browser socket, dial the forge, pipe both ways. */
const tunnelServer = new WebSocketServer({ noServer: true });
export const defaultTunnel: HmrUpgradeDeps['tunnel'] = (targetWsUrl, req, socket, head, origin) => {
  tunnelServer.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(targetWsUrl, { headers: { origin } });
    upstream.on('unexpected-response', (_q, r) => console.warn('[hmr-proxy] upstream unexpected-response', r.statusCode, targetWsUrl));
    // Frames queued before the upstream opens are dropped on upstream error; the browser HMR client reconnects.
    const queue: Array<Buffer | string> = [];
    upstream.on('open', () => { for (const m of queue) { try { upstream.send(m); } catch { /* closed */ } } queue.length = 0; });
    client.on('message', (d, isBin) => {
      const m = isBin ? (d as Buffer) : d.toString('utf8');
      if (upstream.readyState === WebSocket.OPEN) upstream.send(m); else queue.push(m);
    });
    upstream.on('message', (d, isBin) => {
      try { client.send(isBin ? (d as Buffer) : d.toString('utf8')); } catch { /* closed */ }
    });
    const closeBoth = () => { try { client.close(); } catch { /* noop */ } try { upstream.close(); } catch { /* noop */ } };
    client.on('close', closeBoth); upstream.on('close', closeBoth);
    client.on('error', closeBoth);
    upstream.on('error', (err) => { console.warn('[hmr-proxy] upstream error:', err.message, targetWsUrl); closeBoth(); });
  });
};
