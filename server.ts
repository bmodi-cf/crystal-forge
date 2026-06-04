import { createServer } from 'node:http';
import next from 'next';

const port = parseInt(process.env.PORT || '3030', 10);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));

  // Next's own HMR/websocket (dashboard hot-reload) is served by Next's upgrade
  // handler. Task 6 inserts the forge-HMR tunnel ahead of this delegation.
  const upgradeHandler = app.getUpgradeHandler();
  server.on('upgrade', (req, socket, head) => {
    void upgradeHandler(req, socket, head);
  });

  server.listen(port, () => {
    console.log(`> dashboard server listening on :${port} (${dev ? 'dev' : 'production'})`);
  });
});
