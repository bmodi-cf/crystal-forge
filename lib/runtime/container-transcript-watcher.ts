import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { CONTAINER_WORKDIR } from './paths';
import { parseTranscriptLine, encodedCwd, type WatcherDeps } from './transcript-watcher';

export type TailStream = EventEmitter & { kill: () => void };

/** Injectable for tests; real impl tails the transcript dir over `docker exec`. */
export type SpawnTail = (containerId: string) => TailStream;

const defaultSpawnTail: SpawnTail = (containerId) => {
  // Container HOME is /home/forge (see forge-runtime.Dockerfile); cwd is /workspace.
  const dir = `/home/forge/.claude/projects/${encodedCwd(CONTAINER_WORKDIR)}`;
  const script =
    `until ls ${dir}/*.jsonl >/dev/null 2>&1; do sleep 0.25; done; ` +
    `exec tail -n +1 -F ${dir}/*.jsonl`;
  const child = spawn('docker', ['exec', containerId, 'sh', '-c', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const ee = new EventEmitter() as TailStream;
  ee.kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
  let buffer = '';
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) ee.emit('line', line);
    }
  });
  return ee;
};

export function startContainerTranscriptWatcher(
  conversationId: string,
  containerId: string,
  deps: WatcherDeps & { spawnTail?: SpawnTail },
): { stop: () => void } {
  const spawnTail = deps.spawnTail ?? defaultSpawnTail;
  const stream = spawnTail(containerId);
  let sessionRecorded = false;
  stream.on('line', (line: string) => {
    const parsed = parseTranscriptLine(line);
    if (!parsed) return;
    if (!sessionRecorded) {
      sessionRecorded = true;
      void Promise.resolve(deps.setClaudeSessionId(conversationId, parsed.sessionId)).catch(() => {});
    }
    void Promise.resolve(deps.appendMessage(conversationId, {
      role: parsed.message.role, content: parsed.message.content,
    })).catch(() => {});
  });
  return { stop: () => { stream.kill(); } };
}
