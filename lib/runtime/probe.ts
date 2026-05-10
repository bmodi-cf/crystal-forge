import http from 'node:http';

export function probe(port: number, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 1000;
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
