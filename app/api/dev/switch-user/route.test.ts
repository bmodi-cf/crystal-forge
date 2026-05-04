// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { withCleanDb, makeUser } from '@/lib/test/db';

const ORIGINAL_ENV = process.env.AUTH_DEV_USERS_ENABLED;

describe('POST /api/dev/switch-user', () => {
  afterEach(() => {
    process.env.AUTH_DEV_USERS_ENABLED = ORIGINAL_ENV;
  });

  it('returns 404 when AUTH_DEV_USERS_ENABLED is unset', async () => {
    process.env.AUTH_DEV_USERS_ENABLED = '';
    const { POST } = await import('./route');
    const res = await POST(new Request('http://localhost/api/dev/switch-user', {
      method: 'POST',
      body: JSON.stringify({ email: 'maya.chen@crystalfountains.com' }),
      headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when body is invalid', async () => {
    process.env.AUTH_DEV_USERS_ENABLED = 'true';
    const { POST } = await import('./route');
    const res = await POST(new Request('http://localhost/api/dev/switch-user', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when user does not exist', async () => {
    process.env.AUTH_DEV_USERS_ENABLED = 'true';
    await withCleanDb(async () => {
      const { POST } = await import('./route');
      const res = await POST(new Request('http://localhost/api/dev/switch-user', {
        method: 'POST',
        body: JSON.stringify({ email: 'nobody@x.com' }),
        headers: { 'content-type': 'application/json' },
      }));
      expect(res.status).toBe(404);
    });
  });

  it('creates a session and returns a session cookie when valid', async () => {
    process.env.AUTH_DEV_USERS_ENABLED = 'true';
    await withCleanDb(async (prisma) => {
      await makeUser(prisma, { email: 'maya@x.com', name: 'Maya Chen' });
      const { POST } = await import('./route');
      const res = await POST(new Request('http://localhost/api/dev/switch-user', {
        method: 'POST',
        body: JSON.stringify({ email: 'maya@x.com' }),
        headers: { 'content-type': 'application/json' },
      }));
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain('authjs.session-token=');
    });
  });
});
