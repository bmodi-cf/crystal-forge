// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// The dev guard returns before auth() is ever called; mock @/lib/auth so
// importing the handler doesn't pull in next-auth (which fails to resolve
// `next/server` under vitest's node environment).
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const prev = process.env.FORGE_DASHBOARD_MODE;
afterEach(() => {
  if (prev === undefined) delete process.env.FORGE_DASHBOARD_MODE;
  else process.env.FORGE_DASHBOARD_MODE = prev;
});

describe('deployment start route dev guard', () => {
  it('returns 404 in dev mode before doing any work', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'dev';
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/deployments/x/start', { method: 'POST' }) as unknown as NextRequest,
      { params: Promise.resolve({ forgeId: 'x' }) } as unknown as RouteContext<'/api/deployments/[forgeId]/start'>,
    );
    expect(res.status).toBe(404);
  });
});
