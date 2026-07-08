// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { isProdMode, devOnlyRouteGuard } from './mode';

const prev = process.env.FORGE_DASHBOARD_MODE;
afterEach(() => {
  if (prev === undefined) delete process.env.FORGE_DASHBOARD_MODE;
  else process.env.FORGE_DASHBOARD_MODE = prev;
});

describe('isProdMode', () => {
  it('is true only when FORGE_DASHBOARD_MODE=prod', () => {
    process.env.FORGE_DASHBOARD_MODE = 'prod';
    expect(isProdMode()).toBe(true);
    process.env.FORGE_DASHBOARD_MODE = 'dev';
    expect(isProdMode()).toBe(false);
    delete process.env.FORGE_DASHBOARD_MODE;
    expect(isProdMode()).toBe(false);
  });
});

describe('devOnlyRouteGuard', () => {
  it('returns a 404 response in prod, null in dev', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'prod';
    const res = devOnlyRouteGuard();
    expect(res?.status).toBe(404);
    process.env.FORGE_DASHBOARD_MODE = 'dev';
    expect(devOnlyRouteGuard()).toBeNull();
  });
});
