export type CommandResult = { exitCode: number };

export type RunOpts = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** When set, the child's stdout+stderr are appended to this file. */
  logPath?: string;
  /** Hard timeout. The child is SIGKILLed if it exceeds this. */
  timeoutMs?: number;
};

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: RunOpts): Promise<CommandResult>;
}
