// lib/github/octokit-client.test.ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { OctokitGitHubClient } from './octokit-client';
import type { ForgeFiles } from './types';
import { BranchProtectionUnavailableError } from './types';

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
  // Default: pretend the template populate is already complete (so
  // waitForTemplatePopulate's package.json poll succeeds) and any other
  // contents read 404s (no pre-existing forge files).
  const defaultGetContent = async (args: GetContentArgs) => {
    if (args.path === 'package.json') return { data: { type: 'file', sha: 'sha-pkg' } };
    throw status(404);
  };
  return {
    repos: {
      createOrUpdateFileContents: vi.fn(putBehavior),
      getContent: vi.fn(getContentBehavior ?? defaultGetContent),
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
  claudeSettings: '{"hooks":{}}\n',
  claudeBlockScript: '#!/usr/bin/env bash\nexit 0\n',
  claudeMd: '# Forge: Aquaflow\n',
};

describe('OctokitGitHubClient.writeForgeFiles', () => {
  it('issues PUTs for all four forge files on the happy path', async () => {
    const calls: Array<{ path: string; content: string }> = [];
    const octokit = makeOctokitWith(async ({ path, content }) => {
      calls.push({ path, content });
      return { data: {} };
    });
    const client = newClient(octokit);

    await client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles);

    expect(calls.map((c) => c.path)).toEqual([
      'forge.config.json',
      '.env.example',
      '.claude/settings.local.json',
      '.claude/hooks/block-dangerous-commands.sh',
      'CLAUDE.md',
    ]);
    // Bodies round-trip through base64 unchanged.
    const decodedConfig = Buffer.from(calls[0]!.content, 'base64').toString('utf8');
    expect(JSON.parse(decodedConfig)).toEqual(exampleFiles.forgeConfig);
    expect(Buffer.from(calls[1]!.content, 'base64').toString('utf8')).toBe(exampleFiles.envExample);
    expect(Buffer.from(calls[2]!.content, 'base64').toString('utf8')).toBe(exampleFiles.claudeSettings);
    expect(Buffer.from(calls[3]!.content, 'base64').toString('utf8')).toBe(exampleFiles.claudeBlockScript);
    expect(Buffer.from(calls[4]!.content, 'base64').toString('utf8')).toBe(exampleFiles.claudeMd);
  });

  it('retries on 404 and eventually succeeds', async () => {
    let calls = 0;
    const octokit = makeOctokitWith(async () => {
      calls++;
      // Fail on the first two attempts of the first PUT (forge.config.json).
      // Third attempt succeeds, then the remaining three PUTs succeed first try.
      if (calls < 3) throw status(404);
      return { data: {} };
    });
    const client = newClient(octokit);

    await client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles);

    // 2 failed retries + 1 success on file #1 + 1 success on each of files #2/#3/#4/#5 = 7.
    expect(calls).toBe(7);
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

    // File #1: initial PUT (no sha) → 422 → GET → retry PUT (with sha) → success.
    // Files #2/#3/#4/#5: PUT (no sha) → success.
    expect(putCalls).toHaveLength(6);
    expect(putCalls[0]?.path).toBe('forge.config.json');
    expect(putCalls[0]?.sha).toBeUndefined();
    expect(putCalls[1]?.path).toBe('forge.config.json');
    expect(putCalls[1]?.sha).toBe('sha-of-forge.config.json');
    expect(putCalls[2]?.path).toBe('.env.example');
    expect(putCalls[2]?.sha).toBeUndefined();
    expect(putCalls[3]?.path).toBe('.claude/settings.local.json');
    expect(putCalls[4]?.path).toBe('.claude/hooks/block-dangerous-commands.sh');
    expect(putCalls[5]?.path).toBe('CLAUDE.md');
  });

  it('on 422 with no existing file (GET 404), throws the original 422', async () => {
    let putCalls = 0;
    const octokit = makeOctokitWith(
      async () => {
        putCalls++;
        throw status(422);
      },
      // package.json exists (populate done) but the targeted forge files do not.
      async ({ path }) => {
        if (path === 'package.json') return { data: { type: 'file', sha: 'sha-pkg' } };
        throw status(404);
      },
    );
    const client = newClient(octokit);

    await expect(
      client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles),
    ).rejects.toMatchObject({ status: 422 });
    expect(putCalls).toBe(1);
  });

  it('waits for template populate (package.json) before issuing PUTs', async () => {
    let pkgGets = 0;
    const putCalls: PutArgs[] = [];
    const octokit = makeOctokitWith(
      async (args) => { putCalls.push(args); return {}; },
      async ({ path }) => {
        if (path === 'package.json') {
          pkgGets++;
          // Simulate populate completing on the 3rd poll.
          if (pkgGets < 3) throw status(404);
          return { data: { type: 'file', sha: 'sha-pkg' } };
        }
        throw status(404);
      },
    );
    const client = newClient(octokit);

    await client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles);

    expect(pkgGets).toBe(3);
    // Writes only happen after populate confirms, in the canonical order.
    expect(putCalls.map((c) => c.path)).toEqual([
      'forge.config.json',
      '.env.example',
      '.claude/settings.local.json',
      '.claude/hooks/block-dangerous-commands.sh',
      'CLAUDE.md',
    ]);
  });

  it('throws if template populate never completes within the retry budget', async () => {
    const octokit = makeOctokitWith(
      async () => ({}),
      async () => { throw status(404); }, // populate never succeeds; package.json stays 404
    );
    const client = newClient(octokit);

    await expect(
      client.writeForgeFiles('bmodi-cf/aquaflow', exampleFiles),
    ).rejects.toThrow(/template populate/i);
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

describe('OctokitGitHubClient.archiveRepo', () => {
  type UpdateArgs = { owner: string; repo: string; archived?: boolean };
  type GetArgs = { owner: string; repo: string };

  function makeOctokitForArchive(
    updateBehavior: (args: UpdateArgs) => Promise<unknown>,
    getBehavior?: (args: GetArgs) => Promise<unknown>,
  ): Octokit {
    return {
      repos: {
        update: vi.fn(updateBehavior),
        get: vi.fn(getBehavior ?? (async () => ({ data: { archived: false } }))),
      },
    } as unknown as Octokit;
  }

  it('issues update with archived: true on the happy path', async () => {
    const calls: UpdateArgs[] = [];
    const octokit = makeOctokitForArchive(async (args) => {
      calls.push(args);
      return { data: {} };
    });
    const client = newClient(octokit);

    await client.archiveRepo('bmodi-cf/showcase-gallery');

    expect(calls).toEqual([
      { owner: 'bmodi-cf', repo: 'showcase-gallery', archived: true },
    ]);
  });

  it('swallows a 404 (repo already gone)', async () => {
    const octokit = makeOctokitForArchive(async () => {
      throw status(404);
    });
    const client = newClient(octokit);

    await expect(
      client.archiveRepo('bmodi-cf/showcase-gallery'),
    ).resolves.toBeUndefined();
  });

  it('treats a 403 on an already-archived repo as success (idempotent)', async () => {
    // GitHub rejects any update to an archived repo with 403 "read-only".
    const octokit = makeOctokitForArchive(
      async () => {
        throw status(403);
      },
      async () => ({ data: { archived: true } }),
    );
    const client = newClient(octokit);

    await expect(
      client.archiveRepo('bmodi-cf/showcase-gallery'),
    ).resolves.toBeUndefined();
  });

  it('rethrows a 403 that is a genuine permission error (repo not archived)', async () => {
    const octokit = makeOctokitForArchive(
      async () => {
        throw status(403);
      },
      async () => ({ data: { archived: false } }),
    );
    const client = newClient(octokit);

    await expect(
      client.archiveRepo('bmodi-cf/showcase-gallery'),
    ).rejects.toMatchObject({ status: 403 });
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

describe('OctokitGitHubClient.setBranchProtection', () => {
  const opts = { requiredChecks: ['build'], requireUpToDate: true };

  function protectionClient(err: Error) {
    const stub = {
      repos: { updateBranchProtection: vi.fn().mockRejectedValue(err) },
    } as unknown as Octokit;
    return new OctokitGitHubClient({
      owner: 'o', templateRepo: 't/r',
      appId: '1', privateKey: 'k', installationId: 'i',
      octokit: stub,
    });
  }

  it('maps the plan-limitation 403 to BranchProtectionUnavailableError', async () => {
    const planErr = status(403);
    planErr.message = 'Upgrade to GitHub Pro or make this repository public to enable this feature.';
    await expect(
      protectionClient(planErr).setBranchProtection('o/private-repo', 'main', opts),
    ).rejects.toBeInstanceOf(BranchProtectionUnavailableError);
  });

  it('lets other 403s (e.g. insufficient permissions) surface unchanged', async () => {
    const permErr = status(403);
    permErr.message = 'Resource not accessible by integration';
    await expect(
      protectionClient(permErr).setBranchProtection('o/private-repo', 'main', opts),
    ).rejects.toMatchObject({ status: 403, name: 'Error' });
  });
});
