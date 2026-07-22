import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canEdit, canReadForge, canWriteForge, forgeReadFilter, toAcl } from '@/lib/acl';
import { env } from '@/lib/env';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { getGitHubClient } from '@/lib/github/client';
import type { GitHubClient } from '@/lib/github/client';
import { DEV_BRANCH, FORGE_TOPIC, PROD_BRANCH, REQUIRED_CHECKS } from '@/lib/github/branches';
import { BranchProtectionUnavailableError } from '@/lib/github/types';
import { getDatabaseProvisioner } from '@/lib/db/provisioner';
import type { DatabaseProvisioner } from '@/lib/db/provisioner';
import { slugifyForgeName, slugToDbName, dbNameToRole } from '@/lib/github/slug';
import type { Forge, SessionUser } from './types';
import type { CreateForgeInput, UpdateForgeInput } from './forges-schema';

/**
 * Renders the .env.example body committed into each cloned forge repo. The real
 * DATABASE_URL (scoped role creds, container-network pg host) is injected into
 * the forge container at runtime by the harness — this placeholder only
 * documents the variable so a fresh clone has the right shape.
 */
export function renderEnvExample(): string {
  return [
    '# DATABASE_URL is injected into the forge container at runtime by the harness.',
    'DATABASE_URL=postgres://localhost:5432/placeholder',
    '',
  ].join('\n');
}

/**
 * Body of `.claude/settings.local.json` — wires a PreToolUse hook on Bash that
 * runs the block script for every shell command the in-forge agent attempts.
 */
export function renderClaudeSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: '.claude/hooks/block-dangerous-commands.sh' },
          ],
        },
      ],
    },
  }, null, 2) + '\n';
}

/**
 * Body of `.claude/hooks/block-dangerous-commands.sh` — rejects kill/pkill/killall
 * and any reference to the host `crystal_forge` database with exit 2 (Claude
 * Code's "block this tool call" convention).
 */
export function renderBlockScript(): string {
  return `#!/usr/bin/env bash
set -e
input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")

# Block process kills — never legitimate inside a forge sandbox.
if [[ "$cmd" =~ (^|[^A-Za-z0-9_])(kill|pkill|killall)([^A-Za-z0-9_]|$) ]]; then
  printf 'Blocked: kill/pkill/killall not allowed inside a forge sandbox.\\n' >&2
  exit 2
fi

# Block any reference to the host database.
if [[ "$cmd" =~ (^|[^A-Za-z0-9_])crystal_forge([^A-Za-z0-9_]|$) ]]; then
  printf 'Blocked: cannot reference the host crystal_forge database.\\n' >&2
  exit 2
fi

exit 0
`;
}

/**
 * Body of the top-level CLAUDE.md inside each forge clone. Tells the in-forge
 * agent which DB to touch, that the dev port comes from env, and that kill
 * commands are off-limits.
 */
export function renderClaudeMd(name: string, dbName: string): string {
  return `# Forge: ${name}

You are working inside a Crystal Forge sandbox cloned to this directory.

## Sandbox rules

- Your dev server's port is provided by the \`PORT\` environment variable
  set by the host. Do not override it.
- Your database is **${dbName}**. Never touch \`crystal_forge\` or any
  database that isn't \`${dbName}\`.
- Do not run \`kill\`, \`pkill\`, \`killall\`, or any other process-killing
  command. If a port appears in use, start your server on a different
  port instead.
- Do not modify files outside this directory.

## Forge identity

See \`forge.config.json\` for \`name\`, \`description\`, \`slug\`, \`dbName\`,
\`createdAt\`.
`;
}

const forgeInclude = {
  groups: { include: { group: true } },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.ForgeInclude;

type ForgeWithRelations = Prisma.ForgeGetPayload<{ include: typeof forgeInclude }>;

function toDto(row: ForgeWithRelations): Forge {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    groups: row.groups.map((fg) => fg.group.name),
    createdBy: { id: row.createdBy.id, name: row.createdBy.name },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    repoFullName: row.repoFullName,
    repoUrl: `${env.GITHUB_BASE_URL.replace(/\/$/, '')}/${row.repoFullName}`,
  };
}

export async function listForges(currentUser: SessionUser): Promise<Forge[]> {
  const rows = await prisma.forge.findMany({
    where: forgeReadFilter(currentUser),
    include: forgeInclude,
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(toDto);
}

export async function getForge(currentUser: SessionUser, id: string): Promise<Forge> {
  const row = await prisma.forge.findUnique({
    where: { id },
    include: forgeInclude,
  });
  if (!row) {
    throw new NotFoundError('forge', id);
  }
  if (!canReadForge(currentUser, toAcl(row))) {
    throw new ForbiddenError(`Cannot read forge ${id}`);
  }
  return toDto(row);
}

/**
 * Create a Forge atomically with its GitHub repo, two committed files
 * (forge.config.json + .env.example), and a per-forge Postgres database.
 * Compensates with safeDeleteRepo / safeDropDatabase on later-stage failures.
 *
 * `client` and `provisioner` are injectable for tests; in production the
 * default factories return the singletons chosen by GITHUB_CLIENT_MODE and
 * DB_PROVISIONER_MODE.
 */
export async function createForge(
  currentUser: SessionUser,
  input: CreateForgeInput,
  client: GitHubClient = getGitHubClient(),
  provisioner: DatabaseProvisioner = getDatabaseProvisioner(),
): Promise<Forge> {
  if (!canEdit(currentUser)) {
    throw new ForbiddenError('Your role cannot create forges');
  }

  // 1. Pre-check name uniqueness in DB (cheaper than going to GitHub first).
  const dup = await prisma.forge.findUnique({ where: { name: input.name } });
  if (dup) {
    throw new ValidationError('Forge name already in use', {
      name: ['A Forge with this name already exists'],
    });
  }

  // 2. Validate group names exist before any external call.
  const groupRows = await prisma.group.findMany({ where: { name: { in: input.groups } } });
  if (groupRows.length !== input.groups.length) {
    const known = new Set(groupRows.map((g) => g.name));
    const unknown = input.groups.filter((g) => !known.has(g));
    throw new ValidationError('Unknown group(s)', { groups: unknown });
  }

  // Non-admins may only assign groups they are members of.
  if (!currentUser.isAdmin) {
    const userGroups = new Set(currentUser.groups);
    const foreign = input.groups.filter((g) => !userGroups.has(g));
    if (foreign.length > 0) {
      throw new ValidationError('Cannot assign groups you are not a member of', {
        groups: foreign,
      });
    }
  }

  // 3. Compute slug + dbName + payload.
  const description = input.description?.trim() ? input.description.trim() : null;
  const slug = slugifyForgeName(input.name);
  const dbName = slugToDbName(slug);
  const createdAt = new Date().toISOString();

  // 4. Create the GitHub repo. Errors here surface unchanged.
  const created = await client.createRepoFromTemplate({
    name: slug,
    description,
    private: true,
  });

  // 5. Write forge identity, env, and Claude sandbox config. On failure, delete the repo.
  try {
    await client.writeForgeFiles(created.fullName, {
      forgeConfig: { name: input.name, description, slug, dbName, createdAt },
      envExample: renderEnvExample(),
      claudeSettings: renderClaudeSettings(),
      claudeBlockScript: renderBlockScript(),
      claudeMd: renderClaudeMd(input.name, dbName),
    });

    // Branch dev FROM main so it inherits the just-written per-forge files,
    // then protect main. Protection is a repo setting (not templatable); dev
    // must be branched post-write (a template-copied dev would lack these files).
    await client.createBranch(created.fullName, PROD_BRANCH, DEV_BRANCH);
    try {
      await client.setBranchProtection(created.fullName, PROD_BRANCH, {
        requiredChecks: REQUIRED_CHECKS,
        requireUpToDate: true,
      });
    } catch (err) {
      // Free GitHub plans refuse protection on private repos. Promotion gates
      // are still enforced dashboard-side at accept time, so degrade rather
      // than fail creation; GitHub-side enforcement returns on a paid plan.
      if (!(err instanceof BranchProtectionUnavailableError)) throw err;
      console.warn(`[createForge] ${err.message} — created without GitHub-side protection`);
    }

    // Tag the repo so the org repo list can filter forges (topic:crystal-forge).
    // Cosmetic — never fails creation.
    try {
      await client.setRepoTopics(created.fullName, [FORGE_TOPIC]);
    } catch (err) {
      console.warn(`[createForge] failed to set topics on ${created.fullName}:`, err);
    }
  } catch (err) {
    await safeDeleteRepo(client, created.fullName);
    throw err;
  }

  // 6. Provision the per-forge database + scoped login role. On failure, delete the repo.
  try {
    await provisioner.createDatabase(dbName);
    await provisioner.provisionRole(dbName, dbNameToRole(dbName));
  } catch (err) {
    await safeDropDatabase(provisioner, dbName);
    await safeDeleteRepo(client, created.fullName);
    throw err;
  }

  // 7. Insert the Forge row. On failure, drop the database AND delete the repo.
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.forge.create({
        data: {
          name: input.name,
          description,
          createdById: currentUser.id,
          repoFullName: created.fullName,
          groups: { create: groupRows.map((g) => ({ groupId: g.id })) },
        },
        include: forgeInclude,
      });
      return toDto(row);
    });
  } catch (err) {
    await safeDropDatabase(provisioner, dbName);
    await safeDeleteRepo(client, created.fullName);
    throw err;
  }
}

export async function updateForge(
  currentUser: SessionUser,
  id: string,
  input: UpdateForgeInput,
): Promise<Forge> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.forge.findUnique({ where: { id }, include: forgeInclude });
    if (!existing) throw new NotFoundError('forge', id);

    if (!canWriteForge(currentUser, toAcl(existing))) {
      throw new ForbiddenError(`Cannot update forge ${id}`);
    }

    const data: Prisma.ForgeUpdateInput = {};
    if (input.displayName !== undefined) {
      const trimmed = input.displayName?.trim() ?? null;
      data.displayName = trimmed && trimmed.length > 0 ? trimmed : null;
    }
    if (input.description !== undefined) {
      const trimmed = input.description?.trim() ?? null;
      data.description = trimmed && trimmed.length > 0 ? trimmed : null;
    }

    if (input.groups !== undefined) {
      const groupRows = await tx.group.findMany({ where: { name: { in: input.groups } } });
      if (groupRows.length !== input.groups.length) {
        const known = new Set(groupRows.map((g) => g.name));
        const unknown = input.groups.filter((g) => !known.has(g));
        throw new ValidationError('Unknown group(s)', { groups: unknown });
      }
      if (!currentUser.isAdmin) {
        const userGroups = new Set(currentUser.groups);
        const foreign = input.groups.filter((g) => !userGroups.has(g));
        if (foreign.length > 0) {
          throw new ValidationError('Cannot assign groups you are not a member of', {
            groups: foreign,
          });
        }
      }
      await tx.forgeGroup.deleteMany({ where: { forgeId: id } });
      await tx.forgeGroup.createMany({
        data: groupRows.map((g) => ({ forgeId: id, groupId: g.id })),
      });
    }

    const updated = await tx.forge.update({
      where: { id },
      data,
      include: forgeInclude,
    });
    return toDto(updated);
  });
}

/**
 * Delete a Forge. The GitHub repo is archived first; if archive fails, the
 * Forge row is preserved (better to leave a usable Forge than a broken
 * repo<->row link).
 */
export async function deleteForge(
  currentUser: SessionUser,
  id: string,
  client: GitHubClient = getGitHubClient(),
): Promise<void> {
  const existing = await prisma.forge.findUnique({
    where: { id },
    include: forgeInclude,
  });
  if (!existing) throw new NotFoundError('forge', id);

  if (!canWriteForge(currentUser, toAcl(existing))) {
    throw new ForbiddenError(`Cannot delete forge ${id}`);
  }

  // Archive on GitHub BEFORE the DB delete. If archive fails, abort.
  await client.archiveRepo(existing.repoFullName);

  await prisma.forge.delete({ where: { id } }); // ON DELETE CASCADE wipes forge_groups
}

export async function canCurrentUserWriteForge(
  currentUser: SessionUser,
  forgeId: string,
): Promise<boolean> {
  const row = await prisma.forge.findUnique({
    where: { id: forgeId },
    include: { groups: { include: { group: true } } },
  });
  if (!row) return false;
  return canWriteForge(currentUser, toAcl(row));
}

async function safeDeleteRepo(client: GitHubClient, fullName: string): Promise<void> {
  try {
    await client.deleteRepo(fullName);
  } catch (cleanupErr) {
    console.error(
      '[createForge] orphaned repo — cleanup failed',
      { repo: fullName, cleanupErr },
    );
  }
}

async function safeDropDatabase(
  provisioner: DatabaseProvisioner,
  dbName: string,
): Promise<void> {
  try {
    await provisioner.dropDatabase(dbName);
    // Drop the scoped role after the db is gone — it then owns nothing, so the
    // drop succeeds cleanly.
    await provisioner.dropRole(dbNameToRole(dbName)).catch(() => {});
  } catch (cleanupErr) {
    console.error(
      '[createForge] orphaned database — cleanup failed',
      { dbName, cleanupErr },
    );
  }
}
