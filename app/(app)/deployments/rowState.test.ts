// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { deriveRowState } from './rowState';
import type { DeploymentRow } from '@/lib/services/deployments';

const BASE: DeploymentRow = {
  forgeId: 'f1', name: 'Acme', displayName: null, slug: 'acme',
  deployEnabled: true, pinnedVersion: 'v1.0.0', runningVersion: 'v1.0.0',
  phase: 'running', error: null, consecutiveFailures: 0,
};

describe('deriveRowState', () => {
  it('reports running when pinned matches running and the phase is running', () => {
    expect(deriveRowState(BASE, ['v1.0.0'])).toBe('running');
  });

  it('reports not-deployed for a forge that was never enabled', () => {
    const row = { ...BASE, deployEnabled: false, pinnedVersion: null, runningVersion: null, phase: null };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('not-deployed');
  });

  it('reports no-image when a never-deployed forge has no semver tags', () => {
    const row = { ...BASE, deployEnabled: false, pinnedVersion: null, runningVersion: null, phase: null };
    expect(deriveRowState(row, [])).toBe('no-image');
  });

  it('does not report no-image when the registry lookup failed', () => {
    const row = { ...BASE, deployEnabled: false, pinnedVersion: null, runningVersion: null, phase: null };
    expect(deriveRowState(row, null)).toBe('not-deployed');
  });

  it('reports deploying while pinned and running disagree', () => {
    const row = { ...BASE, pinnedVersion: 'v1.1.0', runningVersion: 'v1.0.0' };
    expect(deriveRowState(row, ['v1.1.0', 'v1.0.0'])).toBe('deploying');
  });

  it('reports deploying for a first deploy with no snapshot entry yet', () => {
    const row = { ...BASE, pinnedVersion: 'v1.0.0', runningVersion: null, phase: null };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('deploying');
  });

  it('reports failed even when pinned and running disagree', () => {
    const row = { ...BASE, pinnedVersion: 'v9.9.9', runningVersion: null, phase: 'failed' as const, error: 'pull failed' };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('failed');
  });

  it('reports stopped when the reconciler says stopped', () => {
    const row = { ...BASE, phase: 'stopped' as const, runningVersion: 'v1.0.0' };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('stopped');
  });

  it('prefers not-deployed over any snapshot phase', () => {
    const row = { ...BASE, deployEnabled: false, pinnedVersion: null };
    expect(deriveRowState(row, ['v1.0.0'])).toBe('not-deployed');
  });
});
