// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { respondToServiceError } from './http';
import { NotFoundError, ForbiddenError, ValidationError } from './errors';

describe('respondToServiceError', () => {
  it('maps NotFoundError → 404', async () => {
    const res = respondToServiceError(new NotFoundError('forge', 'abc'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'forge abc not found' });
  });

  it('maps ForbiddenError → 403', async () => {
    const res = respondToServiceError(new ForbiddenError('nope'));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'nope' });
  });

  it('maps ValidationError → 400 and includes issues', async () => {
    const res = respondToServiceError(new ValidationError('bad', { name: ['required'] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad', issues: { name: ['required'] } });
  });

  it('maps unknown errors → 500 with a generic body', async () => {
    const res = respondToServiceError(new Error('boom'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'Internal Server Error' });
  });
});
