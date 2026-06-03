// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildScopedDatabaseUrl } from './url';

describe('buildScopedDatabaseUrl', () => {
  it('targets the container pg host with role creds and db name', () => {
    const url = buildScopedDatabaseUrl({ role: 'forge_x_app', password: 'abc123', database: 'forge_x' });
    expect(url).toBe('postgres://forge_x_app:abc123@crystal-forge-pg:5432/forge_x');
  });
});
