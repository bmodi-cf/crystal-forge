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
  it('writes config.yml + nested hosts.yml under /home/forge and passes the token via env, never argv', async () => {
    const { mgr, calls } = recordingManager();
    await writeForgeGitToken(mgr, 'cid', 'ghs_secret');
    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0]!;
    expect(cmd).toBe('sh');
    const script = args[args.length - 1];
    // Both files targeted under /home/forge/.config/gh/.
    expect(script).toContain('/home/forge/.config/gh/config.yml');
    expect(script).toContain('/home/forge/.config/gh/hosts.yml');
    // config.yml carries a version marker — this is what suppresses gh's
    // multi-account migration (which would otherwise call GET /user, which an
    // installation token can't do) on gh >= 2.40.
    expect(script).toMatch(/version:\s*1/);
    // hosts.yml uses the nested `users:` shape, not the legacy flat form.
    expect(script).toContain('users:');
    expect(script).toContain('x-access-token:');
    expect(script).toContain('oauth_token: %s');
    // Token flows through the exec environment, never argv.
    expect(script).toContain('$FORGE_GH_TOKEN');
    expect(args.join(' ')).not.toContain('ghs_secret'); // token never in argv
    expect(opts?.env).toEqual({ FORGE_GH_TOKEN: 'ghs_secret' });
  });

  it('throws when the exec exits non-zero', async () => {
    const { mgr } = recordingManager(1);
    await expect(writeForgeGitToken(mgr, 'cid', 't')).rejects.toThrow(/write gh token/i);
  });
});
