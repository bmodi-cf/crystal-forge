import { describe, it, expect } from 'vitest';
import { writeForgeGitToken } from './gh-credential';
import type { ContainerManager, ExecOpts } from './container/types';

function recordingManager(exitCode = 0) {
  const calls: { cmd: string; args: string[]; opts?: ExecOpts }[] = [];
  const mgr = {
    create: async () => 'id',
    exec: async (_id: string, cmd: string, args: string[], opts?: ExecOpts) => {
      calls.push({ cmd, args, opts });
      return { exitCode };
    },
    inspect: async () => ({ exists: true, running: true }),
    stop: async () => {},
    remove: async () => {},
    list: async () => [],
  } as ContainerManager;
  return { mgr, calls };
}

describe('writeForgeGitToken', () => {
  it('writes hosts.yml under /home/forge and passes the token via env, never argv', async () => {
    const { mgr, calls } = recordingManager();
    await writeForgeGitToken(mgr, 'cid', 'ghs_secret');
    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0]!;
    expect(cmd).toBe('sh');
    const script = args[args.length - 1];
    expect(script).toContain('/home/forge/.config/gh/hosts.yml');
    expect(script).toContain('$FORGE_GH_TOKEN');
    expect(args.join(' ')).not.toContain('ghs_secret'); // token never in argv
    expect(opts?.env).toEqual({ FORGE_GH_TOKEN: 'ghs_secret' });
  });

  it('throws when the exec exits non-zero', async () => {
    const { mgr } = recordingManager(1);
    await expect(writeForgeGitToken(mgr, 'cid', 't')).rejects.toThrow(/write gh token/i);
  });
});
