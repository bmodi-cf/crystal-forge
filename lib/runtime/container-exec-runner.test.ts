import { describe, it, expect } from 'vitest';
import { containerExecRunner } from './container-exec-runner';
import { FakeContainerManager } from './container/fake-container-manager';

describe('containerExecRunner', () => {
  it('maps RunOpts.cwd to exec workdir and forwards the command', async () => {
    const m = new FakeContainerManager();
    const id = await m.create({ name: 'x', image: 'img' });
    const runner = containerExecRunner(m, id);
    const res = await runner.run('pnpm', ['install'], { cwd: '/workspace', logPath: '/tmp/x.log' });
    expect(res.exitCode).toBe(0);
    expect(m.execCalls[0]).toMatchObject({
      id, cmd: 'pnpm', args: ['install'],
      opts: { workdir: '/workspace', logPath: '/tmp/x.log' },
    });
  });
});
