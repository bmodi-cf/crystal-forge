// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const prev = process.env.FORGE_DASHBOARD_MODE;
afterEach(() => {
  if (prev === undefined) delete process.env.FORGE_DASHBOARD_MODE;
  else process.env.FORGE_DASHBOARD_MODE = prev;
  vi.clearAllMocks();
});

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, { method: 'POST', ...init }) as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'f1' }) } as unknown as RouteContext<'/api/forges/[id]/uploads'>;

describe('uploads route', () => {
  it('returns 404 in prod mode before doing any work', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'prod';
    const { POST } = await import('./route');
    const res = await POST(req('http://localhost/api/forges/f1/uploads?name=a.txt'), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    delete process.env.FORGE_DASHBOARD_MODE;
    const { auth } = await import('@/lib/auth');
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req('http://localhost/api/forges/f1/uploads?name=a.txt'), ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    delete process.env.FORGE_DASHBOARD_MODE;
    const { auth } = await import('@/lib/auth');
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'u1' } });
    const { POST } = await import('./route');
    const res = await POST(req('http://localhost/api/forges/f1/uploads', { body: 'x' }), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 413 when Content-Length exceeds the cap, without touching the service', async () => {
    delete process.env.FORGE_DASHBOARD_MODE;
    const { auth } = await import('@/lib/auth');
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'u1' } });
    const { POST } = await import('./route');
    const res = await POST(
      req('http://localhost/api/forges/f1/uploads?name=big.bin', {
        body: 'x',
        headers: { 'content-length': String(200 * 1024 * 1024) },
      }),
      ctx,
    );
    expect(res.status).toBe(413);
  });
});
