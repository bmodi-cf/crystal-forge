import { describe, it, expect } from 'vitest';
import { parseVersion, nextVersion, compareVersions } from './semver';

describe('parseVersion', () => {
  it('parses a v-prefixed semver', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  it('returns null for garbage', () => {
    expect(parseVersion('nope')).toBeNull();
    expect(parseVersion('v1.2')).toBeNull();
  });
});

describe('nextVersion', () => {
  it('first release is v1.0.0 regardless of bump', () => {
    expect(nextVersion(null, 'patch')).toBe('v1.0.0');
    expect(nextVersion(null, 'major')).toBe('v1.0.0');
  });
  it('bumps patch', () => {
    expect(nextVersion('v1.2.3', 'patch')).toBe('v1.2.4');
  });
  it('bumps minor and zeroes patch', () => {
    expect(nextVersion('v1.2.3', 'minor')).toBe('v1.3.0');
  });
  it('bumps major and zeroes minor+patch', () => {
    expect(nextVersion('v1.2.3', 'major')).toBe('v2.0.0');
  });
});

describe('compareVersions', () => {
  it('orders by major then minor then patch', () => {
    expect(compareVersions('v1.0.0', 'v1.0.1')).toBeLessThan(0);
    expect(compareVersions('v2.0.0', 'v1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', 'v1.2.3')).toBe(0);
  });
});
