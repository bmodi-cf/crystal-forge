import type {
  ContainerManager, ContainerStatus, ContainerSummary,
  CreateContainerSpec, ExecOpts,
} from './types';

type Entry = { id: string; spec: CreateContainerSpec; running: boolean };
export type ExecCall = { id: string; cmd: string; args: string[]; opts?: ExecOpts };

export class FakeContainerManager implements ContainerManager {
  private readonly containers = new Map<string, Entry>();
  private seq = 0;
  private readonly exitQueue: number[] = [];
  private readonly failMatches: string[] = [];
  readonly execCalls: ExecCall[] = [];

  /** Queue the exit code the next exec() should return (default 0). */
  queueExit(code: number): void { this.exitQueue.push(code); }

  /**
   * Make any exec whose `cmd + args` contains `match` exit non-zero, regardless
   * of call order. Useful for probes (e.g. `test -d …`) whose position in the
   * sequence is awkward to target with the positional queue.
   */
  failCommand(match: string): void { this.failMatches.push(match); }

  async create(spec: CreateContainerSpec): Promise<string> {
    const id = `fake-${++this.seq}`;
    this.containers.set(id, { id, spec, running: true });
    return id;
  }

  async exec(id: string, cmd: string, args: string[], opts?: ExecOpts): Promise<{ exitCode: number }> {
    this.execCalls.push({ id, cmd, args, ...(opts ? { opts } : {}) });
    const full = `${cmd} ${args.join(' ')}`;
    if (this.failMatches.some((m) => full.includes(m))) return { exitCode: 1 };
    return { exitCode: this.exitQueue.length ? this.exitQueue.shift()! : 0 };
  }

  async inspect(id: string): Promise<ContainerStatus> {
    const e = this.containers.get(id);
    return { exists: !!e, running: !!e?.running };
  }

  async stop(id: string): Promise<void> {
    const e = this.containers.get(id);
    if (e) e.running = false;
  }

  async remove(id: string): Promise<void> { this.containers.delete(id); }

  async list(opts?: { label?: string }): Promise<ContainerSummary[]> {
    const out: ContainerSummary[] = [];
    for (const e of this.containers.values()) {
      const labels = e.spec.labels ?? {};
      if (opts?.label && !(opts.label in labels)) continue;
      out.push({ id: e.id, name: e.spec.name, labels });
    }
    return out;
  }
}
