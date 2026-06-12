import { getContainerManager } from './container';
import type { ContainerManager } from './container/types';
import { CONTAINER_WORKDIR } from './paths';
import { claudeCredentialsEnv } from './claude-credentials';

/** One window per conversation; the socket name carries the conversation id. */
const SESSION = 'main';
const socket = (conversationId: string) => `claude-${conversationId}`;

export type TmuxDeps = { manager?: ContainerManager };

export async function hasSession(
  containerId: string,
  conversationId: string,
  deps: TmuxDeps = {},
): Promise<boolean> {
  const mgr = deps.manager ?? getContainerManager();
  const { exitCode } = await mgr.exec(containerId, 'tmux',
    ['-L', socket(conversationId), 'has-session', '-t', SESSION]);
  return exitCode === 0;
}

export async function ensureSession(
  opts: { containerId: string; conversationId: string; resumeSessionId: string | null },
  deps: TmuxDeps = {},
): Promise<{ created: boolean }> {
  const mgr = deps.manager ?? getContainerManager();
  if (await hasSession(opts.containerId, opts.conversationId, deps)) return { created: false };
  const resume = opts.resumeSessionId ? ` --resume ${opts.resumeSessionId}` : '';
  const command = `claude --dangerously-skip-permissions${resume}`;
  // Fresh per-conversation server, so credentials passed via `-e` (ExecOpts.env
  // -> docker exec -e) propagate to the claude process this spawns.
  await mgr.exec(opts.containerId, 'tmux',
    ['-L', socket(opts.conversationId), 'new-session', '-d', '-s', SESSION, '-c', CONTAINER_WORKDIR, command],
    { env: claudeCredentialsEnv() });
  return { created: true };
}

export function attachArgv(
  containerId: string,
  conversationId: string,
): { command: string; args: string[] } {
  return {
    command: 'docker',
    args: ['exec', '-i', '-t', containerId, 'tmux', '-L', socket(conversationId), 'attach', '-t', SESSION],
  };
}

export async function killSession(
  containerId: string,
  conversationId: string,
  deps: TmuxDeps = {},
): Promise<void> {
  const mgr = deps.manager ?? getContainerManager();
  await mgr.exec(containerId, 'tmux', ['-L', socket(conversationId), 'kill-server']);
}
