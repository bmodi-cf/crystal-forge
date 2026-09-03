// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { FakeContainerManager } from '@/lib/runtime/container/fake-container-manager';
import {
  WORKSPACE_SYNC_EXIT,
  workspaceSyncBlocker,
  checkWorkspaceSync,
} from './workspace-sync';

describe('workspaceSyncBlocker', () => {
  it('returns null when the workspace matches origin/dev', () => {
    expect(workspaceSyncBlocker(WORKSPACE_SYNC_EXIT.OK)).toBeNull();
  });

  it('reports uncommitted work for a dirty tree', () => {
    const b = workspaceSyncBlocker(WORKSPACE_SYNC_EXIT.DIRTY);
    expect(b?.kind).toBe('dirty');
    expect(b?.message).toMatch(/uncommitted/i);
  });

  it('tells the user to push when the workspace is ahead', () => {
    const b = workspaceSyncBlocker(WORKSPACE_SYNC_EXIT.AHEAD);
    expect(b?.kind).toBe('ahead');
    expect(b?.message).toMatch(/push/i);
  });

  it('tells the user to pull when the workspace is behind', () => {
    const b = workspaceSyncBlocker(WORKSPACE_SYNC_EXIT.BEHIND);
    expect(b?.kind).toBe('behind');
    expect(b?.message).toMatch(/pull/i);
  });

  it('reports divergence when both sides have unique commits', () => {
    const b = workspaceSyncBlocker(WORKSPACE_SYNC_EXIT.DIVERGED);
    expect(b?.kind).toBe('diverged');
  });

  it('blocks rather than passing when the fetch could not run', () => {
    const b = workspaceSyncBlocker(WORKSPACE_SYNC_EXIT.FETCH_FAILED);
    expect(b?.kind).toBe('fetch_failed');
  });

  it('blocks when the container has no git workspace', () => {
    expect(workspaceSyncBlocker(WORKSPACE_SYNC_EXIT.NO_WORKSPACE)?.kind).toBe('no_workspace');
  });

  it('blocks on an unrecognised exit code rather than treating it as clean', () => {
    expect(workspaceSyncBlocker(99)).not.toBeNull();
  });
});

describe('checkWorkspaceSync', () => {
  const running = async () => ({ status: 'running' as const, containerId: 'c1' });

  it('blocks when the forge is not running at all', async () => {
    const mgr = new FakeContainerManager();
    const b = await checkWorkspaceSync('f1', mgr, async () => null);
    expect(b?.kind).toBe('not_running');
    expect(mgr.execCalls).toHaveLength(0);
  });

  it('blocks when the forge is still starting', async () => {
    const mgr = new FakeContainerManager();
    const b = await checkWorkspaceSync('f1', mgr, async () => ({
      status: 'starting' as const, containerId: 'c1',
    }));
    expect(b?.kind).toBe('not_running');
    expect(mgr.execCalls).toHaveLength(0);
  });

  it('passes when the running workspace is clean and in sync', async () => {
    const mgr = new FakeContainerManager();
    expect(await checkWorkspaceSync('f1', mgr, running)).toBeNull();
  });

  it('runs the check inside the forge container workspace', async () => {
    const mgr = new FakeContainerManager();
    await checkWorkspaceSync('f1', mgr, running);
    expect(mgr.execCalls).toHaveLength(1);
    expect(mgr.execCalls[0]!.id).toBe('c1');
    expect(mgr.execCalls[0]!.opts?.workdir).toBe('/workspace');
  });

  it('surfaces the container exit code as the matching blocker', async () => {
    const mgr = new FakeContainerManager();
    mgr.queueExit(WORKSPACE_SYNC_EXIT.AHEAD);
    const b = await checkWorkspaceSync('f1', mgr, running);
    expect(b?.kind).toBe('ahead');
  });
});
