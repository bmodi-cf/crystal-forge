// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ValidationError } from '@/lib/errors';
import { parseForgeJson, parseBundleJson, BUNDLE_FILES } from './types';

const forge = {
  name: 'Second Set of Eyes',
  displayName: 'Second Set of Eyes',
  description: 'Drawing review',
  slug: 'second-set-of-eyes',
  repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
  deployVersion: 'v1.0.0',
};

const bundle = {
  version: 'v1.0.0',
  sourceHost: 'pilot',
  cutAt: '2026-08-21T18:00:00.000Z',
  appImageDigest: 'sha256:' + 'a'.repeat(64),
  migrations: ['20260801120000_init'],
};

describe('parseForgeJson', () => {
  it('accepts a well-formed row and passes nullable fields through', () => {
    expect(parseForgeJson({ ...forge, description: null })).toMatchObject({
      slug: 'second-set-of-eyes',
      repoFullName: 'CrystalFountainsInc/second-set-of-eyes',
      description: null,
    });
  });

  it('rejects a row missing repoFullName, which the Forge table requires', () => {
    const { repoFullName: _omitted, ...without } = forge;
    expect(() => parseForgeJson(without)).toThrow(ValidationError);
  });

  it('rejects a deployVersion that is not a semver tag', () => {
    expect(() => parseForgeJson({ ...forge, deployVersion: 'latest' })).toThrow(ValidationError);
  });
});

describe('parseBundleJson', () => {
  it('accepts a well-formed provenance record', () => {
    expect(parseBundleJson(bundle).appImageDigest).toBe('sha256:' + 'a'.repeat(64));
  });

  it('rejects an app image digest that is not sha256:<64 hex>', () => {
    expect(() => parseBundleJson({ ...bundle, appImageDigest: 'sha256:nope' })).toThrow(
      ValidationError,
    );
  });

  it('rejects a non-semver version', () => {
    expect(() => parseBundleJson({ ...bundle, version: '1.0.0' })).toThrow(ValidationError);
  });
});

describe('BUNDLE_FILES', () => {
  it('names the three files the spec defines', () => {
    expect(BUNDLE_FILES).toEqual({
      forge: 'forge.json',
      data: 'data.sql',
      bundle: 'bundle.json',
    });
  });
});
