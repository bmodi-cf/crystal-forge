import { describe, it, expect, vi } from 'vitest';
import { startContainerTranscriptWatcher, transcriptPath } from './container-transcript-watcher';
import { EventEmitter } from 'node:events';

function fakeStream() {
  const ee = new EventEmitter() as EventEmitter & { kill: () => void };
  ee.kill = vi.fn();
  return ee;
}

describe('startContainerTranscriptWatcher', () => {
  it('tails only the conversation session id and appends parsed lines', async () => {
    const stream = fakeStream();
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    const spawnTail = vi.fn(() => stream);
    const w = startContainerTranscriptWatcher('conv1', 'cid', 'sess-1', { appendMessage, spawnTail });

    // It must tail this session's file, not every transcript in the shared dir.
    expect(spawnTail).toHaveBeenCalledWith('cid', 'sess-1');

    stream.emit('line', JSON.stringify({ sessionId: 'sess-1', message: { role: 'assistant', content: 'hi' } }));
    await Promise.resolve();
    expect(appendMessage).toHaveBeenCalledWith('conv1', { role: 'assistant', content: 'hi' });

    w.stop();
    expect(stream.kill).toHaveBeenCalled();
  });

  it('transcriptPath targets a single <sessionId>.jsonl, never a glob', () => {
    const p = transcriptPath('sess-1');
    expect(p.endsWith('/sess-1.jsonl')).toBe(true);
    expect(p).not.toContain('*');
  });
});
