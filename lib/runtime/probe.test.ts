// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { probe } from './probe';

let server: http.Server | null = null;

afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function listen(port: number, status: number): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((_req, res) => {
      res.statusCode = status;
      res.end('ok');
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

describe('probe', () => {
  it('returns true on 200', async () => {
    await listen(3911, 200);
    expect(await probe(3911, { timeoutMs: 500 })).toBe(true);
  });

  it('returns true on 404 (server is alive)', async () => {
    await listen(3912, 404);
    expect(await probe(3912, { timeoutMs: 500 })).toBe(true);
  });

  it('returns true on 500 (server is alive)', async () => {
    await listen(3913, 500);
    expect(await probe(3913, { timeoutMs: 500 })).toBe(true);
  });

  it('returns false on connection refused', async () => {
    expect(await probe(3914, { timeoutMs: 500 })).toBe(false);
  });

  it('returns false on timeout', async () => {
    server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((r) => server!.listen(3915, '127.0.0.1', () => r()));
    expect(await probe(3915, { timeoutMs: 100 })).toBe(false);
  });
});
