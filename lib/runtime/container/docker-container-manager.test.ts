import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { DockerContainerManager, UPLOAD_SCRIPT } from './docker-container-manager';

function recorder(inspectOut = 'true|\n') {
  const calls: { args: string[] }[] = [];
  return {
    calls,
    capture: async (_cmd: string, args: string[]) => {
      calls.push({ args });
      if (args[0] === 'create' || args[0] === 'start') return 'container123\n';
      if (args[0] === 'inspect') return inspectOut;
      return '';
    },
  };
}

describe('DockerContainerManager argv', () => {
  it('builds a create command with publish, volumes, network, env, labels', async () => {
    const rec = recorder();
    const m = new DockerContainerManager({ capture: rec.capture });
    const id = await m.create({
      name: 'forge-x',
      image: 'crystal-forge-runtime:latest',
      labels: { 'crystal-forge.forgeId': 'f1' },
      env: { PORT: '3000', DATABASE_URL: 'postgres://r:p@crystal-forge-pg:5432/forge_x' },
      publish: { hostIp: '127.0.0.1', hostPort: 3042, containerPort: 3000 },
      volumes: [{ volume: 'forge-x', target: '/workspace' }],
      network: 'crystal-forge-net',
    });
    expect(id).toBe('container123');
    const argv = rec.calls[0]!.args.join(' ');
    expect(argv).toContain('create --name forge-x');
    expect(argv).toContain('--label crystal-forge.forgeId=f1');
    expect(argv).toContain('--publish 127.0.0.1:3042:3000');
    expect(argv).toContain('--volume forge-x:/workspace');
    expect(argv).toContain('--network crystal-forge-net');
    expect(argv).toContain('--env PORT=3000');
    expect(argv).toContain('crystal-forge-runtime:latest sleep infinity');
  });

  it('appends :ro to a mount marked readOnly (host bind of the forge env file)', async () => {
    const rec = recorder();
    const m = new DockerContainerManager({ capture: rec.capture });
    await m.create({
      name: 'forge-x',
      image: 'reg.example.com/x:v1',
      volumes: [{ volume: '/etc/crystal-forge/forge-env/x.env', target: '/app/.env', readOnly: true }],
      command: [],
    });
    const argv = rec.calls[0]!.args.join(' ');
    expect(argv).toContain('--volume /etc/crystal-forge/forge-env/x.env:/app/.env:ro');
  });

  it('inspect returns running=true with no port when there is no host binding', async () => {
    const rec = recorder('true|\n');
    const m = new DockerContainerManager({ capture: rec.capture });
    const status = await m.inspect('container123');
    expect(status).toEqual({ exists: true, running: true });
    // Single call templates both running-state and the 3000/tcp host port.
    expect(rec.calls[0]!.args[0]).toBe('inspect');
    expect(rec.calls[0]!.args.at(-1)).toBe('container123');
  });

  it('inspect parses the published host port when 3000/tcp is bound', async () => {
    const rec = recorder('true|3042\n');
    const m = new DockerContainerManager({ capture: rec.capture });
    const status = await m.inspect('container123');
    expect(status).toEqual({ exists: true, running: true, port: 3042 });
  });

  it('inspect reports a stopped container (running=false), port still parsed', async () => {
    const rec = recorder('false|3042\n');
    const m = new DockerContainerManager({ capture: rec.capture });
    const status = await m.inspect('container123');
    expect(status).toEqual({ exists: true, running: false, port: 3042 });
  });

  it('inspect returns exists=false when docker inspect fails', async () => {
    const m = new DockerContainerManager({
      capture: async () => { throw new Error('No such object'); },
    });
    expect(await m.inspect('gone')).toEqual({ exists: false, running: false });
  });

  it('exec with detached uses -d and omits the interactive flags', async () => {
    const calls: string[][] = [];
    const runner = { run: async (_cmd: string, args: string[]) => { calls.push(args); return { exitCode: 0 }; } };
    const m = new DockerContainerManager({ runner });
    await m.exec('c1', 'sh', ['-c', 'pnpm dev'], { detached: true, workdir: '/workspace' });
    const argv = calls[0]!.join(' ');
    expect(argv.startsWith('exec -d')).toBe(true);
    expect(argv).not.toContain('-i');
    expect(argv).not.toContain('-t');
    expect(argv).toContain('-w /workspace');
    expect(argv).toContain('c1 sh -c pnpm dev');
  });
});

describe('DockerContainerManager.writeUpload', () => {
  function harness(result: { exitCode: number; stdout: string; stderr: string }) {
    const calls: { cmd: string; args: string[]; stdin: Readable }[] = [];
    const mgr = new DockerContainerManager({
      spawnStream: async (cmd, args, stdin) => { calls.push({ cmd, args, stdin }); return result; },
    });
    return { mgr, calls };
  }

  it('passes the filename as an env var, never in the script', async () => {
    const { mgr, calls } = harness({ exitCode: 0, stdout: 'uploads/a b.png\n', stderr: '' });
    const res = await mgr.writeUpload('c1', { name: 'a b.png', body: Readable.from(['x']) });

    expect(res).toEqual({ path: 'uploads/a b.png' });
    const { cmd, args } = calls[0]!;
    expect(cmd).toBe('docker');
    expect(args).toEqual([
      'exec', '-i', '-w', '/workspace', '-e', 'UPLOAD_NAME=a b.png',
      'c1', 'sh', '-c', UPLOAD_SCRIPT,
    ]);
    // The script is a fixed constant — the untrusted name is nowhere inside it.
    expect(args[9]).not.toContain('a b.png');
  });

  it('is not fooled by a shell-metacharacter filename', async () => {
    const { mgr, calls } = harness({ exitCode: 0, stdout: 'uploads/x.txt\n', stderr: '' });
    const evil = '"; rm -rf / #';
    await mgr.writeUpload('c1', { name: evil, body: Readable.from(['x']) });
    expect(calls[0]!.args).toContain(`UPLOAD_NAME=${evil}`);
    expect(calls[0]!.args[9]).toBe(UPLOAD_SCRIPT);
  });

  it('returns the last stdout line as the path, tolerating trailing noise', async () => {
    const { mgr } = harness({ exitCode: 0, stdout: 'uploads/logo-2.png\n', stderr: '' });
    const res = await mgr.writeUpload('c1', { name: 'logo.png', body: Readable.from(['x']) });
    expect(res.path).toBe('uploads/logo-2.png');
  });

  it('throws with stderr when the exec exits non-zero', async () => {
    const { mgr } = harness({ exitCode: 1, stdout: '', stderr: 'No space left on device\n' });
    await expect(mgr.writeUpload('c1', { name: 'x.txt', body: Readable.from(['x']) }))
      .rejects.toThrow(/No space left on device/);
  });

  it('throws when the exec succeeds but prints no path', async () => {
    const { mgr } = harness({ exitCode: 0, stdout: '\n', stderr: '' });
    await expect(mgr.writeUpload('c1', { name: 'x.txt', body: Readable.from(['x']) }))
      .rejects.toThrow(/no path/i);
  });
});
