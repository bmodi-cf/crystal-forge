import type {
  ContainerManager, ContainerStatus, ContainerSummary,
  CreateContainerSpec, DockerDiskUsage, ExecOpts,
} from './types';
import type { Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { forgeHome } from '../paths';

type Entry = {
  id: string;
  spec: CreateContainerSpec;
  running: boolean;
  /** The stand-in dev server, when FORGE_FAKE_SERVE is on. */
  child?: ChildProcess;
};
export type ExecCall = { id: string; cmd: string; args: string[]; opts?: ExecOpts };
export type UploadRecord = { id: string; path: string; bytes: number };

/**
 * Resolve `name` against names already taken in `taken`, appending -2, -3, …
 * before the extension. Mirrors the container-side shell loop in
 * docker-container-manager.ts so fake and real behave identically.
 */
export function resolveUploadName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let cand = name;
  let i = 2;
  while (taken.has(cand)) { cand = `${stem}-${i}${ext}`; i += 1; }
  return cand;
}

export class FakeContainerManager implements ContainerManager {
  private readonly containers = new Map<string, Entry>();
  private seq = 0;
  private readonly exitQueue: number[] = [];
  private readonly failMatches: string[] = [];
  readonly execCalls: ExecCall[] = [];
  readonly created: CreateContainerSpec[] = [];
  readonly uploads: UploadRecord[] = [];
  private readonly takenUploads = new Map<string, Set<string>>();

  /** Mutable so a test can assert a specific figure reaches the store. */
  diskUsageResult: DockerDiskUsage = {
    imagesBytes: 1_000_000_000,
    containersBytes: 2_000_000,
    volumesBytes: 500_000_000,
    buildCacheBytes: 3_000_000_000,
  };
  /** Set to make diskUsage() reject, exercising the null-columns path. */
  diskUsageError: Error | null = null;

  async diskUsage(): Promise<DockerDiskUsage> {
    if (this.diskUsageError) throw this.diskUsageError;
    return this.diskUsageResult;
  }

  /** Queue the exit code the next exec() should return (default 0). */
  queueExit(code: number): void { this.exitQueue.push(code); }

  /**
   * Make any exec whose `cmd + args` contains `match` exit non-zero, regardless
   * of call order. Useful for probes (e.g. `test -d …`) whose position in the
   * sequence is awkward to target with the positional queue.
   */
  failCommand(match: string): void { this.failMatches.push(match); }

  async create(spec: CreateContainerSpec): Promise<string> {
    this.created.push(spec);
    const id = `fake-${++this.seq}`;
    const entry: Entry = { id, spec, running: true };
    const child = this.serveClone(spec);
    if (child) entry.child = child;
    this.containers.set(id, entry);
    return id;
  }

  /**
   * Run the pre-warmed clone's dev server on the published host port.
   *
   * `finishStart` probes 127.0.0.1:<hostPort> and will not report `running`
   * until something answers, so without this a forge started in fake mode sits
   * in `starting` until the probe deadline and then reports `crashed`. Before
   * docker isolation the runtime spawned the clone's dev script directly and
   * the e2e fixtures were written against that; this restores the same
   * observable behaviour for the fake path.
   *
   * Opt-in via FORGE_FAKE_SERVE, and silent unless the clone actually exists:
   * the unit suite uses this class heavily and must never spawn a process.
   */
  private serveClone(spec: CreateContainerSpec): ChildProcess | null {
    if (process.env.FORGE_FAKE_SERVE !== '1') return null;
    const hostPort = spec.publish?.hostPort;
    if (hostPort === undefined) return null;

    const slug = spec.name.replace(/^forge-/, '');
    const dir = path.join(forgeHome(), 'clones', slug);
    const entrypoint = path.join(dir, 'server.js');
    if (!fs.existsSync(entrypoint)) return null;

    const child = spawn(process.execPath, [entrypoint], {
      cwd: dir,
      env: { ...process.env, PORT: String(hostPort) },
      stdio: 'ignore',
      detached: false,
    });
    child.unref();
    return child;
  }

  /** Kill the stand-in dev server, if this entry has one. */
  private stopClone(e: Entry | undefined): void {
    if (!e?.child) return;
    try { e.child.kill('SIGKILL'); } catch { /* already gone */ }
    delete e.child;
  }

  async exec(id: string, cmd: string, args: string[], opts?: ExecOpts): Promise<{ exitCode: number }> {
    this.execCalls.push({ id, cmd, args, ...(opts ? { opts } : {}) });
    const full = `${cmd} ${args.join(' ')}`;
    if (this.failMatches.some((m) => full.includes(m))) return { exitCode: 1 };
    return { exitCode: this.exitQueue.length ? this.exitQueue.shift()! : 0 };
  }

  async writeUpload(id: string, opts: { name: string; body: Readable }): Promise<{ path: string }> {
    // Drain first: a body that errors must reject before anything is recorded.
    let bytes = 0;
    for await (const chunk of opts.body) bytes += Buffer.from(chunk as Buffer).length;
    let taken = this.takenUploads.get(id);
    if (!taken) { taken = new Set<string>(); this.takenUploads.set(id, taken); }
    const resolved = resolveUploadName(opts.name, taken);
    taken.add(resolved);
    const path = `uploads/${resolved}`;
    this.uploads.push({ id, path, bytes });
    return { path };
  }

  async inspect(id: string): Promise<ContainerStatus> {
    const e = this.containers.get(id);
    if (!e) return { exists: false, running: false };
    const port = e.spec.publish?.hostPort;
    return { exists: true, running: e.running, ...(port !== undefined ? { port } : {}) };
  }

  async stop(id: string): Promise<void> {
    const e = this.containers.get(id);
    if (e) e.running = false;
    this.stopClone(e);
  }

  async remove(id: string): Promise<void> {
    this.stopClone(this.containers.get(id));
    this.containers.delete(id);
  }

  async list(opts?: { label?: string; running?: boolean }): Promise<ContainerSummary[]> {
    const out: ContainerSummary[] = [];
    for (const e of this.containers.values()) {
      const labels = e.spec.labels ?? {};
      if (opts?.label && !(opts.label in labels)) continue;
      if (opts?.running && !e.running) continue;
      out.push({ id: e.id, name: e.spec.name, labels });
    }
    return out;
  }
}
