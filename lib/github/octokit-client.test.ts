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

describe('OctokitGitHubClient.getScopedInstallationToken', () => {
  it('requests a token scoped to the repo with contents+PR write and returns token+expiry', async () => {
    const authCalls: unknown[] = [];
    const octokit = {
      auth: async (opts: unknown) => {
        authCalls.push(opts);
        return { token: 'ghs_scoped', expiresAt: '2026-07-16T12:00:00.000Z' };
      },
    } as unknown as Octokit;
    const client = new OctokitGitHubClient({
      owner: 'test-owner',
      templateRepo: 'test-owner/tmpl',
      appId: '1', privateKey: 'k', installationId: '2',
      octokit,
    });
    const res = await client.getScopedInstallationToken('test-owner/aquaflow');
    expect(res).toEqual({ token: 'ghs_scoped', expiresAt: '2026-07-16T12:00:00.000Z' });
    expect(authCalls[0]).toEqual({
      type: 'installation',
      repositoryNames: ['aquaflow'],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
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

describe('OctokitGitHubClient.getRefCheckResults', () => {
  type Run = {
    name: string;
    status: string;
    conclusion: string | null;
    started_at: string;
    id: number;
  };

  function checksClient(runs: Run[]) {
    const stub = {
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: runs } })) },
    } as unknown as Octokit;
    return newClient(stub);
  }

  function run(name: string, id: number, started_at: string, conclusion: string | null): Run {
    return {
      name,
      id,
      started_at,
      status: conclusion ? 'completed' : 'in_progress',
      conclusion,
    };
  }

  // A commit can carry check runs from more than one suite: the same head can be
  // (or have been) the head of several PRs into main, each firing its own
  // promote-gates run. Mirrors trakralpha2 @ 0fd1b677, which had two suites.
  it('keeps only the most recent run per check name', async () => {
    const client = checksClient([
      run('lint', 2, '2026-08-17T20:16:51Z', 'success'),
      run('build', 2, '2026-08-17T20:16:29Z', 'success'),
      run('lint', 1, '2026-08-17T18:21:05Z', 'failure'),
      run('build', 1, '2026-08-17T18:22:18Z', 'failure'),
    ]);

    const gates = await client.getRefCheckResults('o/r', 'deadbeef');

    expect(gates).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'success' },
    ]);
  });

  it('reports a re-run still in flight rather than its stale success', async () => {
    const client = checksClient([
      run('tests', 1, '2026-08-17T18:26:52Z', 'success'),
      run('tests', 2, '2026-08-17T20:14:20Z', null),
    ]);

    const gates = await client.getRefCheckResults('o/r', 'deadbeef');

    expect(gates).toEqual([{ name: 'tests', status: 'in_progress', conclusion: null }]);
  });

  it('breaks ties on run id when two runs share a start time', async () => {
    const client = checksClient([
      run('build', 7, '2026-08-17T20:14:43Z', 'failure'),
      run('build', 9, '2026-08-17T20:14:43Z', 'success'),
    ]);

    const gates = await client.getRefCheckResults('o/r', 'deadbeef');

    expect(gates).toEqual([{ name: 'build', status: 'completed', conclusion: 'success' }]);
  });
});

describe('OctokitGitHubClient.getPullRequest', () => {
  function prClient(data: Record<string, unknown>) {
    const stub = {
      pulls: { get: vi.fn(async () => ({ data })) },
    } as unknown as Octokit;
    return newClient(stub);
  }

  const base = {
    number: 4,
    state: 'open',
    merged: false,
    head: { sha: 'deadbeef' },
    commits: 6,
    changed_files: 28,
    additions: 853,
    deletions: 316,
  };

  // A conflicted PR is why gates can go missing: GitHub cannot build the merge
  // ref, so it never dispatches the pull_request-triggered promote-gates run.
  // Mirrors crystal-lattice PR #4 @ 2020e6ab.
  it('surfaces a conflicted PR as not mergeable', async () => {
    const client = prClient({ ...base, mergeable: false, mergeable_state: 'dirty' });

    const pr = await client.getPullRequest('o/r', 4);

    expect(pr.mergeable).toBe(false);
    expect(pr.mergeableState).toBe('dirty');
    expect(pr.headSha).toBe('deadbeef');
  });

  it('passes through a clean PR', async () => {
    const client = prClient({ ...base, mergeable: true, mergeable_state: 'clean' });

    const pr = await client.getPullRequest('o/r', 4);

    expect(pr.mergeable).toBe(true);
    expect(pr.mergeableState).toBe('clean');
  });

  // GitHub computes mergeability asynchronously and answers null until it has.
  // Callers must not read that as "conflicted".
  it('keeps an uncomputed mergeability as null rather than false', async () => {
    const client = prClient({ ...base, mergeable: null, mergeable_state: 'unknown' });

    const pr = await client.getPullRequest('o/r', 4);

    expect(pr.mergeable).toBeNull();
    expect(pr.mergeableState).toBe('unknown');
  });

  it('falls back to unknown when the field is absent', async () => {
    const client = prClient(base);

    const pr = await client.getPullRequest('o/r', 4);

    expect(pr.mergeable).toBeNull();
    expect(pr.mergeableState).toBe('unknown');
  });
});

describe('OctokitGitHubClient.mergeBranch', () => {
  function mergeClient(behavior: () => Promise<unknown>) {
    const merge = vi.fn(behavior);
    const stub = { repos: { merge } } as unknown as Octokit;
    return { client: newClient(stub), merge };
  }

  it('merges head into base and returns the merge commit', async () => {
    const { client, merge } = mergeClient(async () => ({ status: 201, data: { sha: 'merge-sha' } }));

    const result = await client.mergeBranch('o/r', 'dev', 'main');

    expect(result).toEqual({ sha: 'merge-sha', conflicted: false, alreadyUpToDate: false });
    expect(merge).toHaveBeenCalledWith({ owner: 'o', repo: 'r', base: 'dev', head: 'main' });
  });

  // 204: base already contains head. The common case right after a release.
  it('reports nothing-to-merge as already up to date', async () => {
    const { client } = mergeClient(async () => ({ status: 204, data: undefined }));

    expect(await client.mergeBranch('o/r', 'dev', 'main')).toEqual({
      sha: null,
      conflicted: false,
      alreadyUpToDate: true,
    });
  });

  // 409: real conflicts. Not an error the caller should crash on — the back-merge
  // is best-effort and a human has to resolve it.
  it('reports a conflict instead of throwing', async () => {
    const { client } = mergeClient(async () => { throw status(409); });

    expect(await client.mergeBranch('o/r', 'dev', 'main')).toEqual({
      sha: null,
      conflicted: true,
      alreadyUpToDate: false,
    });
  });

  it('still throws on unexpected failures', async () => {
    const { client } = mergeClient(async () => { throw status(500); });

    await expect(client.mergeBranch('o/r', 'dev', 'main')).rejects.toThrow(/500/);
  });
});
