import { describe, it, expect, vi } from 'vitest';
import { startContainerTranscriptWatcher } from './container-transcript-watcher';
import { EventEmitter } from 'node:events';

function fakeStream() {
  const ee = new EventEmitter() as EventEmitter & { kill: () => void };
  ee.kill = vi.fn();
  return ee;
}

describe('startContainerTranscriptWatcher', () => {
  it('parses tailed lines into setClaudeSessionId + appendMessage', async () => {
    const stream = fakeStream();
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    const setClaudeSessionId = vi.fn().mockResolvedValue(undefined);
    const w = startContainerTranscriptWatcher('conv1', 'cid', {
      appendMessage, setClaudeSessionId,
      spawnTail: () => stream,
    });
    stream.emit('line', JSON.stringify({ sessionId: 's1', message: { role: 'assistant', content: 'hi' } }));
    await Promise.resolve();
    expect(setClaudeSessionId).toHaveBeenCalledWith('conv1', 's1');
    expect(appendMessage).toHaveBeenCalledWith('conv1', { role: 'assistant', content: 'hi' });
    w.stop();
    expect(stream.kill).toHaveBeenCalled();
  });
});
