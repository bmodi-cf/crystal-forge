import { canReadForge } from '@/lib/acl';
import type { SessionUser } from '@/lib/services/types';
import type { RuntimeStateFile } from './types';
import { runtimeOrigin } from './proxy-target';

export type ForgeAcl = { id: string; createdById: string; groups: string[] };

export type PreviewProxyDeps = {
  getSession: () => Promise<{ user?: SessionUser | null } | null>;
  loadState: () => Promise<RuntimeStateFile>;
  loadForgeAcl: (forgeId: string) => Promise<ForgeAcl | null>;
  fetch: typeof fetch;
};

// Hop-by-hop headers must not be forwarded by a proxy (RFC 7230 §6.1). We also
// drop host/content-length so undici recomputes them for the upstream request.
// `set-cookie` is dropped from forge-app responses on purpose: forge apps are
// gated by the dashboard and have no identity of their own, so they must not be
// able to plant cookies on the shared dashboard origin (which could clobber the
// dashboard's own session cookie). Revisit when app-level identity lands.
// `content-encoding` is dropped because undici (the runtime `fetch`) transparently
// DECOMPRESSES the upstream body, so `upstream.body` is already plaintext — relaying
// the original `content-encoding: gzip` would make the browser try to gunzip plain
// bytes and render a blank page.
const STRIP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'set-cookie', 'content-encoding',
]);

// Identity header the dashboard injects so the forge app knows the authenticated
// user. The value is base64url(JSON) of the session user — base64 so non-ASCII
// names/emails survive HTTP header (latin1) encoding. Any client-supplied copy
// is dropped before this is set, so a browser cannot spoof it. The forge port is
// loopback-bound and reached only via this proxy, so a plain trusted header is
// the trust boundary (cf. X-Forwarded-User behind an auth proxy). If forge-to-
// forge network isolation ever weakens, sign this (HMAC/asymmetric).
const FORGE_USER_HEADER = 'x-forge-user';

function encodeForgeUser(user: SessionUser): string {
  const payload = JSON.stringify({
    id: user.id,
    email: user.email,
    name: user.name,
    groups: user.groups,
    isAdmin: user.isAdmin,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function filterHeaders(src: Headers): Headers {
  // RFC 7230 §6.1: also strip any header named in the Connection header value.
  const connectionListed = new Set(
    (src.get('connection') ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const out = new Headers();
  src.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!STRIP_HEADERS.has(k) && !connectionListed.has(k)) out.append(key, value);
  });
  return out;
}

/**
 * Authenticate + ACL-gate + reverse-proxy a request for /app/<slug>/... to the
 * running forge's dev server. The full incoming path is preserved because the
 * forge app runs with basePath=/app/<slug>.
 */
export async function handlePreviewProxy(
  req: Request,
  slug: string,
  deps: PreviewProxyDeps,
): Promise<Response> {
  const session = await deps.getSession();
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const state = await deps.loadState();
  const entry = Object.values(state).find(
    (e) => e.slug === slug && e.status === 'running',
  );
  if (!entry) {
    return new Response('Not found', { status: 404 });
  }

  const acl = await deps.loadForgeAcl(entry.forgeId);
  if (!acl || !canReadForge(session.user, acl)) {
    // 404 rather than 403 so we don't confirm the forge exists to outsiders.
    return new Response('Not found', { status: 404 });
  }

  const incoming = new URL(req.url);
  const target = runtimeOrigin(entry.port) + incoming.pathname + incoming.search;

  // Drop any client-supplied identity header, then set the trusted one from the
  // validated session so the forge app can attribute the request to a user.
  const reqHeaders = filterHeaders(req.headers);
  reqHeaders.delete(FORGE_USER_HEADER);
  reqHeaders.set(FORGE_USER_HEADER, encodeForgeUser(session.user));

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: reqHeaders,
    body: hasBody ? req.body : undefined,
    redirect: 'manual', // pass the forge app's redirects through verbatim
  };
  if (hasBody) init.duplex = 'half'; // required by undici when streaming a body

  const upstream = await deps.fetch(target, init);
  const headers = filterHeaders(upstream.headers);

  // A forge app may emit an absolute redirect back to its own loopback origin.
  // Rewrite those to a relative path so the browser stays on the dashboard
  // origin (and re-enters this proxy) instead of being sent to a dead
  // 127.0.0.1 URL that also leaks the internal origin.
  const location = headers.get('location');
  if (location) {
    const origin = runtimeOrigin(entry.port);
    if (location.startsWith(origin)) {
      headers.set('location', location.slice(origin.length) || '/');
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
