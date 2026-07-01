import { createServer } from 'node:http';
import type { Socket } from 'node:net';
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

  const upgradeHandler = app.getUpgradeHandler();
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

  server.listen(port, () => {
    console.log(`> dashboard server listening on :${port} (${dev ? 'dev' : 'production'})`);
  });
});
