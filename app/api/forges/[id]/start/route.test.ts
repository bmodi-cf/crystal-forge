// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// The prod guard returns before auth() is ever called; mock @/lib/auth so
// importing the handler doesn't pull in next-auth (which fails to resolve
// `next/server` under vitest's node environment).
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const prev = process.env.FORGE_DASHBOARD_MODE;
afterEach(() => {
  if (prev === undefined) delete process.env.FORGE_DASHBOARD_MODE;
  else process.env.FORGE_DASHBOARD_MODE = prev;
});

describe('start route prod guard', () => {
  it('returns 404 in prod mode before doing any work', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'prod';
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/forges/x/start', { method: 'POST' }) as unknown as NextRequest,
      { params: Promise.resolve({ id: 'x' }) } as unknown as RouteContext<'/api/forges/[id]/start'>,
    );
    expect(res.status).toBe(404);
  });
});
