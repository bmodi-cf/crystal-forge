import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { CONTAINER_WORKDIR, CLAUDE_HOME } from './paths';
import { parseTranscriptLine, encodedCwd, type AppendMessageFn } from './transcript-watcher';

export type TailStream = EventEmitter & { kill: () => void };

/** Injectable for tests; real impl tails ONE session's transcript over `docker exec`. */
export type SpawnTail = (containerId: string, sessionId: string) => TailStream;

export type ContainerWatcherDeps = { appendMessage: AppendMessageFn; spawnTail?: SpawnTail };

// Container HOME is /home/forge (see forge-runtime.Dockerfile); cwd is /workspace.
// Claude Code writes one transcript per session into this shared project dir, so
// the watcher MUST target a single <sessionId>.jsonl — tailing *.jsonl would mix
// other conversations' history into this one.
const TRANSCRIPT_DIR = `${CLAUDE_HOME}/.claude/projects/${encodedCwd(CONTAINER_WORKDIR)}`;
export const transcriptPath = (sessionId: string): string => `${TRANSCRIPT_DIR}/${sessionId}.jsonl`;

const defaultSpawnTail: SpawnTail = (containerId, sessionId) => {
  const file = transcriptPath(sessionId);
  const script =
    `until [ -f '${file}' ]; do sleep 0.25; done; ` +
    `exec tail -n +1 -F '${file}'`;
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
  sessionId: string,
  deps: ContainerWatcherDeps,
): { stop: () => void } {
  const spawnTail = deps.spawnTail ?? defaultSpawnTail;
  const stream = spawnTail(containerId, sessionId);
  stream.on('line', (line: string) => {
    const parsed = parseTranscriptLine(line);
    if (!parsed) return;
    void Promise.resolve(deps.appendMessage(conversationId, {
      role: parsed.message.role, content: parsed.message.content,
    })).catch(() => {});
  });
  return { stop: () => { stream.kill(); } };
}
