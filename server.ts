import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import next from 'next';

const port = parseInt(process.env.PORT || '3030', 10);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  // Next's custom-server wrapper lazily registers its OWN `'upgrade'` listener on
  // our http.Server the first time a request is handled (`setupWebSocketHandler`,
  // gated only on this private flag). That listener runs `resolveRoutes` and calls
  // `socket.end()` for any upgrade whose path matches a Next route — which includes
  // the forge preview catch-all `/app/[slug]/[[...path]]`. It would therefore tear
  // down our forge HMR tunnel sockets mid-handshake, racing the async auth below.
  // We run in production (`dev:false`), so the dashboard has no HMR socket of its
  // own and Next's listener is purely harmful: suppress it and own `'upgrade'`
  // entirely. (Pre-empting the flag before the first request keeps Next from ever
  // attaching the listener.)
  (app as unknown as { didWebSocketSetup: boolean }).didWebSocketSetup = true;

  const server = createServer((req, res) => handle(req, res));

  // Take over the *router server's* upgrade handler — the one Next's own
  // (suppressed) listener above calls — not the inner base server's
  // `getUpgradeHandler()`. Only the former routes the dashboard's dev HMR
  // socket; with the latter that socket never completes its handshake and, in
  // dev, **no page hydrates**: every client component ships its SSR markup and
  // then sits inert (no effects, no onClick). Production has no HMR socket at
  // all, which is why the pilot never showed it and only the Playwright suite —
  // the one thing that runs this server with `dev:true` — did.
  const upgradeHandler = (app as unknown as {
    upgradeHandler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  }).upgradeHandler;

  if (process.env.FORGE_DASHBOARD_MODE !== 'prod') {
    const { forgeHmrTarget, handleForgeHmrUpgrade, defaultTunnel } = await import('./lib/runtime/hmr-proxy');
    const { getUserBySessionToken } = await import('./lib/services/users');
    const { loadState } = await import('./lib/runtime/state');
    const { loadForgeAcl } = await import('./lib/services/runtime');
    const { canReadForge } = await import('./lib/acl');

    server.on('upgrade', (req, socket, head) => {
      if (forgeHmrTarget(req.url ?? '')) {
        void handleForgeHmrUpgrade(req, socket as Socket, head, {
          getUserBySessionToken: (t) => getUserBySessionToken(t),
          loadState,
          loadForgeAcl,
          canReadForge,
          tunnel: defaultTunnel,
        });
        return;
      }
      void upgradeHandler(req, socket, head); // dashboard's own HMR
    });
  }

  server.listen(port, () => {
    console.log(`> dashboard server listening on :${port} (${dev ? 'dev' : 'production'})`);
  });
});
