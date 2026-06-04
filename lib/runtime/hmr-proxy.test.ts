// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { forgeHmrTarget } from './hmr-proxy';

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
