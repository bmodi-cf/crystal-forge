import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { childProcessRunner } from '../child-process-runner';
import { CONTAINER_WORKDIR } from '../paths';
import type { CommandRunner } from '../runner-types';
import type {
  ContainerManager, ContainerStatus, ContainerSummary,
  CreateContainerSpec, ExecOpts,
} from './types';

/** Run a docker command and capture trimmed stdout. */
function defaultCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`docker ${args.join(' ')} failed (exit ${code}): ${err.trim()}`));
    });
  });
}

/**
 * Container-side upload script. POSIX sh, run via `sh -c`.
 *
 * The filename arrives as $UPLOAD_NAME (a docker `-e` env var) and is never
 * interpolated into this string, so no filename can inject shell syntax.
 *
 * Writes to a dotted .part file and mv's into place only on a clean cat, with a
 * trap sweeping the fragment on any failure — so a dropped connection or a full
 * volume never leaves a truncated file under the real name.
 */
export const UPLOAD_SCRIPT = [
  'set -e',
  'mkdir -p uploads',
  'n="$UPLOAD_NAME"',
  'case "$n" in *.*) stem="${n%.*}"; ext=".${n##*.}" ;; *) stem="$n"; ext="" ;; esac',
  'cand="$n"; i=2',
  'while [ -e "uploads/$cand" ]; do cand="$stem-$i$ext"; i=$((i+1)); done',
  'tmp="uploads/.$cand.part"',
  `trap 'rm -f "$tmp"' EXIT`,
  'cat > "$tmp"',
  'mv "$tmp" "uploads/$cand"',
  `printf '%s\\n' "uploads/$cand"`,
].join('\n');

export type SpawnStream = (
  cmd: string,
  args: string[],
  stdin: Readable,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Spawn a command with a piped stdin and captured output. Separate from
 * childProcessRunner, which hard-codes stdio:['ignore', fd, fd] and so can
 * neither accept a body nor return the resolved path.
 */
function defaultSpawnStream(cmd: string, args: string[], stdin: Readable) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    // The child exiting early makes our writes EPIPE; swallow so it surfaces as
    // a non-zero exit with stderr rather than an unhandled 'error' event.
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('exit', (code) => resolve({ exitCode: code ?? -1, stdout: out, stderr: err }));
    // A body error (byte-cap overrun, client abort) must surface to the caller
    // as *that* error, not as a generic docker failure.
    stdin.once('error', (bodyErr: Error) => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(bodyErr);
    });
    stdin.pipe(child.stdin);
  });
}

export type DockerDeps = {
  /** Injectable for tests; runs `docker <args>` and returns stdout. */
  capture?: (cmd: string, args: string[]) => Promise<string>;
  /** Injectable for tests; runs a logged, fire-and-forget docker command. */
  runner?: CommandRunner;
  /** Injectable for tests; runs a command with piped stdin and captured output. */
  spawnStream?: SpawnStream;
};

export class DockerContainerManager implements ContainerManager {
  private readonly capture: (cmd: string, args: string[]) => Promise<string>;
  private readonly runner: CommandRunner;
  private readonly spawnStream: SpawnStream;

  constructor(deps: DockerDeps = {}) {
    this.capture = deps.capture ?? ((c, a) => defaultCapture(c, a));
    this.runner = deps.runner ?? childProcessRunner;
    this.spawnStream = deps.spawnStream ?? defaultSpawnStream;
  }

  async create(spec: CreateContainerSpec): Promise<string> {
    const args = ['create', '--name', spec.name];
    for (const [k, v] of Object.entries(spec.labels ?? {})) args.push('--label', `${k}=${v}`);
    for (const [k, v] of Object.entries(spec.env ?? {})) args.push('--env', `${k}=${v}`);
    if (spec.publish) {
      const p = spec.publish;
      args.push('--publish', `${p.hostIp}:${p.hostPort}:${p.containerPort}`);
    }
    for (const vol of spec.volumes ?? []) {
      args.push('--volume', `${vol.volume}:${vol.target}${vol.readOnly ? ':ro' : ''}`);
    }
    if (spec.network) args.push('--network', spec.network);
    args.push(spec.image, ...(spec.command ?? ['sleep', 'infinity']));
    const id = (await this.capture('docker', args)).trim();
    await this.capture('docker', ['start', id]);
    return id;
  }

  async exec(id: string, cmd: string, args: string[], opts: ExecOpts = {}): Promise<{ exitCode: number }> {
    const docker = ['exec'];
    if (opts.detached) docker.push('-d');
    else if (opts.tty) docker.push('-i', '-t');
    else docker.push('-i');
    if (opts.workdir) docker.push('-w', opts.workdir);
    for (const [k, v] of Object.entries(opts.env ?? {})) docker.push('-e', `${k}=${v}`);
    docker.push(id, cmd, ...args);
    return this.runner.run('docker', docker, {
      ...(opts.logPath ? { logPath: opts.logPath } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  async writeUpload(id: string, opts: { name: string; body: Readable }): Promise<{ path: string }> {
    const args = [
      'exec', '-i',
      '-w', CONTAINER_WORKDIR,
      '-e', `UPLOAD_NAME=${opts.name}`,
      id, 'sh', '-c', UPLOAD_SCRIPT,
    ];
    const { exitCode, stdout, stderr } = await this.spawnStream('docker', args, opts.body);
    if (exitCode !== 0) {
      throw new Error(`upload failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    const path = stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!path) throw new Error('upload produced no path');
    return { path };
  }

  async inspect(id: string): Promise<ContainerStatus> {
    // One call yields both the running state and the published 3000/tcp host
    // port. `with index ...` guards the nil case: containers with no binding
    // print an empty second field rather than erroring the template.
    const tmpl =
      '{{.State.Running}}|{{with index .NetworkSettings.Ports "3000/tcp"}}{{(index . 0).HostPort}}{{end}}';
    try {
      const out = (await this.capture('docker', ['inspect', '-f', tmpl, id])).trim();
      const [runningStr = '', portStr = ''] = out.split('|');
      const port = portStr ? Number(portStr) : NaN;
      return {
        exists: true,
        running: runningStr === 'true',
        ...(Number.isFinite(port) ? { port } : {}),
      };
    } catch {
      return { exists: false, running: false };
    }
  }

  async stop(id: string): Promise<void> {
    await this.capture('docker', ['stop', id]).catch(() => {});
  }

  async remove(id: string): Promise<void> {
    await this.capture('docker', ['rm', '-f', id]).catch(() => {});
  }

  async list(opts: { label?: string } = {}): Promise<ContainerSummary[]> {
    const args = ['ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Labels}}'];
    if (opts.label) args.push('--filter', `label=${opts.label}`);
    const out = await this.capture('docker', args);
    return out.split('\n').filter(Boolean).map((line) => {
      const [id = '', name = '', labelStr = ''] = line.split('\t');
      const labels: Record<string, string> = {};
      for (const pair of (labelStr ?? '').split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return { id, name, labels };
    });
  }
}
