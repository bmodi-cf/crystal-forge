import net from 'node:net';
import { loadState } from './state';

export class RuntimeCapacityError extends Error {
  constructor(message = 'No free port in pool') {
    super(message);
    this.name = 'RuntimeCapacityError';
  }
}

export async function allocatePort(
  range: { start: number; end: number } = { start: 3001, end: 3099 },
): Promise<number> {
  const state = await loadState();
  const inUse = new Set<number>(Object.values(state).map((e) => e.port));
  for (let p = range.start; p <= range.end; p++) {
    if (inUse.has(p)) continue;
    if (await isHostFree(p)) return p;
  }
  throw new RuntimeCapacityError();
}

function isHostFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}
