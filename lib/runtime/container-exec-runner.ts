import type { CommandRunner, CommandResult, RunOpts } from './runner-types';
import type { ContainerManager } from './container/types';

/** Drop undefined values so a ProcessEnv-shaped map fits ExecOpts.env. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** A CommandRunner that runs every command inside a fixed container. */
export function containerExecRunner(mgr: ContainerManager, containerId: string): CommandRunner {
  return {
    run(cmd: string, args: string[], opts: RunOpts = {}): Promise<CommandResult> {
      return mgr.exec(containerId, cmd, args, {
        ...(opts.cwd ? { workdir: opts.cwd } : {}),
        ...(opts.env ? { env: definedEnv(opts.env) } : {}),
        ...(opts.logPath ? { logPath: opts.logPath } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
    },
  };
}
