// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { handlePreviewProxy, type PreviewProxyDeps } from './preview-proxy';
import type { SessionUser } from '@/lib/services/types';
import type { RuntimeStateFile } from './types';

const user: SessionUser = {
  id: 'u1', entraOid: null, email: 'a@b.c', name: 'A', initials: 'A',
  groups: ['eng'], isAdmin: false,
};

const runningState: RuntimeStateFile = {
  'forge-1': {
    forgeId: 'forge-1', slug: 'bmodi-test1', status: 'running',
    pid: 1, port: 3001, startedAt: '2026-06-02T00:00:00.000Z', logPath: '/tmp/x.log',
  },
};

function makeDeps(over: Partial<PreviewProxyDeps> = {}): PreviewProxyDeps {
  return {
    getSession: async () => ({ user }),
    loadState: async () => runningState,
    loadForgeAcl: async () => ({ id: 'forge-1', createdById: 'u1', groups: ['eng'] }),
    fetch: (async () => new Response('OK', { status: 200 })) as unknown as typeof fetch,
    ...over,
  };
}

describe('handlePreviewProxy', () => {
  it('returns 401 when there is no session', async () => {
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/bmodi-test1/'),
      'bmodi-test1',
      makeDeps({ getSession: async () => null }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the slug is not a running forge', async () => {
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/ghost/'),
      'ghost',
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the forge is stopped (absent from state)', async () => {
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/bmodi-test1/'),
      'bmodi-test1',
      makeDeps({ loadState: async () => ({}) }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when ACL denies read access', async () => {
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/bmodi-test1/'),
      'bmodi-test1',
      makeDeps({ loadForgeAcl: async () => ({ id: 'forge-1', createdById: 'other', groups: ['other'] }) }),
    );
    expect(res.status).toBe(404);
  });

  it('proxies to the runtime origin preserving path+query and relays the upstream response', async () => {
    let calledUrl = '';
    let calledMethod = '';
    const res = await handlePreviewProxy(
      new Request('http://localhost:3000/app/bmodi-test1/dash?q=1', { method: 'GET' }),
      'bmodi-test1',
      makeDeps({
        fetch: (async (url: string | URL, init: RequestInit) => {
          calledUrl = String(url);
          calledMethod = init?.method ?? 'GET';
          return new Response('hello', { status: 201, headers: { 'x-test': 'yes' } });
        }) as unknown as typeof fetch,
      }),
    );
    expect(calledUrl).toBe('http://127.0.0.1:3001/app/bmodi-test1/dash?q=1');
    expect(calledMethod).toBe('GET');
    expect(res.status).toBe(201);
    expect(res.headers.get('x-test')).toBe('yes');
    expect(await res.text()).toBe('hello');
  });
});
