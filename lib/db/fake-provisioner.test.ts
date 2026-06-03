import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDatabaseProvisioner } from './fake-provisioner';

describe('FakeDatabaseProvisioner', () => {
  let fake: FakeDatabaseProvisioner;

  beforeEach(() => {
    fake = new FakeDatabaseProvisioner();
  });

  it('creates a database and records its name', async () => {
    await fake.createDatabase('marketing_frufru');
    expect(fake.has('marketing_frufru')).toBe(true);
    expect(fake.list()).toEqual(['marketing_frufru']);
  });

  it('throws when the same database is created twice', async () => {
    await fake.createDatabase('a');
    await expect(fake.createDatabase('a')).rejects.toThrow(/already exists/i);
  });

  it('drops a database that exists', async () => {
    await fake.createDatabase('a');
    await fake.dropDatabase('a');
    expect(fake.has('a')).toBe(false);
  });

  it('drop is idempotent on a missing database', async () => {
    await expect(fake.dropDatabase('never-existed')).resolves.toBeUndefined();
  });

  it('failNextCall makes the next matching call throw, then resumes normal behaviour', async () => {
    fake.failNextCall('createDatabase', new Error('connection refused'));
    await expect(fake.createDatabase('a')).rejects.toThrow('connection refused');
    // Subsequent call works.
    await fake.createDatabase('a');
    expect(fake.has('a')).toBe(true);
  });

  it('list returns every recorded name in insertion order', async () => {
    await fake.createDatabase('a');
    await fake.createDatabase('b');
    expect(fake.list()).toEqual(['a', 'b']);
  });
});

describe('FakeDatabaseProvisioner roles', () => {
  it('provisions, password-rotates, and drops a role', async () => {
    const p = new FakeDatabaseProvisioner();
    await p.createDatabase('forge_x');
    await p.provisionRole('forge_x', 'forge_x_app');
    expect(p.hasRole('forge_x_app')).toBe(true);
    await p.setRolePassword('forge_x_app', 'deadbeef');
    expect(p.passwordOf('forge_x_app')).toBe('deadbeef');
    await p.dropRole('forge_x_app');
    expect(p.hasRole('forge_x_app')).toBe(false);
  });
});
