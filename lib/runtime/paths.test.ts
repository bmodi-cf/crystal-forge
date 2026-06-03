import { describe, it, expect } from 'vitest';
import { workspaceVolumeName, CONTAINER_WORKDIR } from './paths';

describe('paths container helpers', () => {
  it('derives a stable per-forge volume name', () => {
    expect(workspaceVolumeName('acme-blue')).toBe('forge-acme-blue');
  });
  it('uses a fixed in-container workdir', () => {
    expect(CONTAINER_WORKDIR).toBe('/workspace');
  });
});
