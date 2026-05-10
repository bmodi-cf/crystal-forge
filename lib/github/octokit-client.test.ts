// lib/github/octokit-client.test.ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { OctokitGitHubClient } from './octokit-client';
import type { ForgeFiles } from './types';

function status(code: number) {
  const e = new Error(`HTTP ${code}`) as Error & { status: number };
  e.status = code;
  return e;
}

type PutArgs = {
  owner: string;
  repo: string;
  path: string;
  message: string;
  content: string;
  sha?: string;
};
type GetContentArgs = { owner: string; repo: string; path: string };

function makeOctokitWith(
  putBehavior: (args: PutArgs) => Promise<unknown>,
  getContentBehavior?: (args: GetContentArgs) => Promise<unknown>,
): Octokit {
  return {
    repos: {
      createOrUpdateFileContents: vi.fn(putBehavior),
      getContent: vi.fn(
        getContentBehavior ?? (async () => { throw status(404); }),
      ),
    },
  } as unknown as Octokit;
}

function newClient(octokit: Octokit) {
  return new OctokitGitHubClient({
    owner: 'bmodi-cf',
    templateRepo: 'bmodi-cf/crystal-forge-template-webapp',
    appId: 'unused',
    privateKey: 'unused',
    installationId: 'unused',
    octokit,
    retryDelaysMs: [0, 0, 0, 0, 0], // skip real backoff in tests
  });
}

const exampleFiles: ForgeFiles = {
  forgeConfig: {
    name: 'Aquaflow',
    description: 'Hydraulics tool',
    slug: 'aquaflow',
    dbName: 'aquaflow',
    createdAt: '2026-05-09T01:34:47.000Z',
  },
  envExample: 'DATABASE_URL=postgres://crystal:crystal@localhost:5433/aquaflow\n',
};

describe('OctokitGitHubClient.writeForgeFiles', () => {
  it('issues two PUTs (forge.config.json then .env.example) on the happy path', async () => {
    const calls: Array<{ path: string; content: string }> = [];
    const octokit = makeOctokitWith(async ({ path, content }) => {
      calls.push({ path, content });
      return { data: {} };
    });
    const client = newClient(octokit);

    await client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles);

    expect(calls.map((c) => c.path)).toEqual(['forge.config.json', '.env.example']);
    // forge.config.json body is the JSON we passed in, base64-encoded
    const decoded = Buffer.from(calls[0]!.content, 'base64').toString('utf8');
    expect(JSON.parse(decoded)).toEqual(exampleFiles.forgeConfig);
    expect(Buffer.from(calls[1]!.content, 'base64').toString('utf8')).toBe(
      exampleFiles.envExample,
    );
  });

  it('retries on 404 and eventually succeeds', async () => {
    let calls = 0;
    const octokit = makeOctokitWith(async () => {
      calls++;
      // Fail on the first two attempts of the first PUT (forge.config.json).
      // Third attempt of the first PUT succeeds, then the second PUT (.env.example) succeeds first try.
      if (calls < 3) throw status(404);
      return { data: {} };
    });
    const client = newClient(octokit);

    await client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles);

    // 2 failed retries on the first PUT + 1 successful first PUT + 1 successful second PUT = 4.
    expect(calls).toBe(4);
  });

  it('throws after exhausting all retries on 404', async () => {
    let calls = 0;
    const octokit = makeOctokitWith(async () => {
      calls++;
      throw status(404);
    });
    const client = newClient(octokit);

    await expect(
      client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles),
    ).rejects.toMatchObject({ status: 404 });

    // Initial attempt + 5 retries = 6 attempts on the first PUT, never reaches the second.
    expect(calls).toBe(6);
  });

  it('does not retry on 401', async () => {
    let calls = 0;
    const octokit = makeOctokitWith(async () => {
      calls++;
      throw status(401);
    });
    const client = newClient(octokit);

    await expect(
      client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it('on 422 with existing file, fetches SHA and retries the PUT as an update (adopted repo)', async () => {
    const putCalls: PutArgs[] = [];
    let putAttempt = 0;
    const octokit = makeOctokitWith(
      async (args) => {
        putCalls.push(args);
        putAttempt++;
        // First PUT (forge.config.json, no sha): pretend file already exists.
        if (putAttempt === 1) throw status(422);
        return { data: {} };
      },
      async ({ path }) => ({
        data: { type: 'file', sha: `sha-of-${path}` },
      }),
    );
    const client = newClient(octokit);

    await client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles);

    // Initial PUT (no sha) → 422 → GET → retry PUT (with sha) → success → second PUT (no sha) → success
    expect(putCalls).toHaveLength(3);
    expect(putCalls[0]?.path).toBe('forge.config.json');
    expect(putCalls[0]?.sha).toBeUndefined();
    expect(putCalls[1]?.path).toBe('forge.config.json');
    expect(putCalls[1]?.sha).toBe('sha-of-forge.config.json');
    expect(putCalls[2]?.path).toBe('.env.example');
    expect(putCalls[2]?.sha).toBeUndefined();
  });

  it('on 422 with no existing file (GET 404), throws the original 422', async () => {
    let putCalls = 0;
    const octokit = makeOctokitWith(
      async () => {
        putCalls++;
        throw status(422);
      },
      async () => { throw status(404); },
    );
    const client = newClient(octokit);

    await expect(
      client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles),
    ).rejects.toMatchObject({ status: 422 });
    expect(putCalls).toBe(1);
  });

  it('does not retry forever: a second 422 (with sha) propagates', async () => {
    let putCalls = 0;
    const octokit = makeOctokitWith(
      async () => {
        putCalls++;
        throw status(422);
      },
      async ({ path }) => ({ data: { type: 'file', sha: `sha-of-${path}` } }),
    );
    const client = newClient(octokit);

    await expect(
      client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles),
    ).rejects.toMatchObject({ status: 422 });
    // First PUT (no sha) + second PUT (with sha) = 2 attempts on the first file.
    expect(putCalls).toBe(2);
  });
});

describe('OctokitGitHubClient.getInstallationToken', () => {
  it('delegates to octokit auth({ type: "installation" })', async () => {
    const stub = {
      auth: vi.fn().mockResolvedValue({ token: 'ghs_xyz' }),
    } as unknown as Octokit;
    const client = new OctokitGitHubClient({
      owner: 'o', templateRepo: 't/r',
      appId: '1', privateKey: 'k', installationId: 'i',
      octokit: stub,
    });
    expect(await client.getInstallationToken()).toBe('ghs_xyz');
    expect((stub as unknown as { auth: ReturnType<typeof vi.fn> }).auth)
      .toHaveBeenCalledWith({ type: 'installation' });
  });
});
