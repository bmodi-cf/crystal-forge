// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { forgeHmrTarget, handleForgeHmrUpgrade, type HmrUpgradeDeps } from './hmr-proxy';

function fakeSocket() {
  const sock = { destroyed: false, end() { sock.destroyed = true; }, destroy() { sock.destroyed = true; } };
  return sock as unknown as import('node:net').Socket;
}
function deps(over: Partial<HmrUpgradeDeps>): HmrUpgradeDeps {
  return {
    getUserBySessionToken: async () => ({ id: 'u1' } as never),
    loadState: async () => ({ f1: { forgeId: 'f1', slug: 'acme', status: 'running', containerId: 'c', port: 3007, startedAt: 'x', logPath: '' } }) as never,
    loadForgeAcl: async () => ({ id: 'f1', createdById: 'u1', groups: [] }),
    canReadForge: () => true,
    tunnel: () => {},
    ...over,
  };
}

describe('forgeHmrTarget', () => {
  it('matches a forge HMR upgrade path and extracts slug + full path', () => {
    expect(forgeHmrTarget('/app/bmodi-test3/_next/webpack-hmr?id=abc'))
      .toEqual({ slug: 'bmodi-test3', path: '/app/bmodi-test3/_next/webpack-hmr?id=abc' });
  });
  it('matches any websocket path under a forge slug', () => {
    expect(forgeHmrTarget('/app/acme/_next/turbopack-hmr')?.slug).toBe('acme');
  });
  it('does NOT match the dashboard root HMR or non-/app paths', () => {
    expect(forgeHmrTarget('/_next/webpack-hmr')).toBeNull();
    expect(forgeHmrTarget('/api/forges/runtime')).toBeNull();
    expect(forgeHmrTarget('/app')).toBeNull();
  });
});

describe('handleForgeHmrUpgrade', () => {
  const req = (cookie?: string) => ({ url: '/app/acme/_next/webpack-hmr', headers: cookie ? { cookie } : {} }) as never;

  it('destroys the socket when there is no session', async () => {
    const sock = fakeSocket();
    let tunnelled = false;
    await handleForgeHmrUpgrade(req(), sock, Buffer.alloc(0), deps({
      getUserBySessionToken: async () => null, tunnel: () => { tunnelled = true; },
    }));
    expect(tunnelled).toBe(false);
    expect(sock.destroyed).toBe(true);
  });

  it('destroys the socket when ACL denies', async () => {
    const sock = fakeSocket();
    let tunnelled = false;
    await handleForgeHmrUpgrade(req('authjs.session-token=t'), sock, Buffer.alloc(0), deps({
      canReadForge: () => false, tunnel: () => { tunnelled = true; },
    }));
    expect(tunnelled).toBe(false);
    expect(sock.destroyed).toBe(true);
  });

  it('tunnels to runtimeOrigin(port)+path when authorized', async () => {
    const sock = fakeSocket();
    let target = '';
    await handleForgeHmrUpgrade(req('authjs.session-token=t'), sock, Buffer.alloc(0), deps({
      tunnel: (url) => { target = url; },
    }));
    expect(target).toBe('ws://127.0.0.1:3007/app/acme/_next/webpack-hmr');
    expect(sock.destroyed).toBe(false);
  });
});
