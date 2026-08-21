import { hostname } from 'node:os';
import { prisma } from '@/lib/prisma';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { isProdMode } from '@/lib/mode';
import { slugifyForgeName, slugToDbName } from '@/lib/github/slug';
import { getRegistryClient } from '@/lib/registry/client';
import type { RegistryClient } from '@/lib/registry/types';
import { getGitHubClient } from '@/lib/github/client';
import type { GitHubClient } from '@/lib/github/types';
import { dumpForgeDatabase, readAppliedMigrations } from '@/lib/db/dump';
import { pushBundle, seedRepo } from '@/lib/bundle/registry-bundle';
import type { BundleContents } from '@/lib/bundle/types';
import type { SessionUser } from './types';

const MIGRATIONS_DIR = 'prisma/migrations';

function assertAdmin(user: SessionUser): void {
  if (!user.isAdmin) throw new ForbiddenError('Admin only');
}

/** Cutting reads the pilot's dev database and repo; prod can do neither. */
function assertPilot(): void {
  if (isProdMode()) {
    throw new ForbiddenError('Bundles are cut on the pilot dashboard, not in production');
  }
}

export type FirstReleaseCandidate = {
  promotionId: string;
  forgeId: string;
  forgeName: string;
  slug: string;
  version: string;
  headSha: string;
  decidedAt: string;
  /** Seed tags already in the registry — a cut is a re-cut when this is non-empty. */
  bundleTags: string[];
};

/**
 * Forges at exactly one accepted promotion — the definition of "first release"
 * (spec §2), and already a fact in `promotion_requests`.
 *
 * Kept separate from `listPendingPromotions`, which filters to ACTIVE statuses
 * and therefore can never show an accepted one.
 */
export async function listFirstReleaseCandidates(
  currentUser: SessionUser,
  registry: RegistryClient = getRegistryClient(),
): Promise<FirstReleaseCandidate[]> {
  assertAdmin(currentUser);
  const accepted = await prisma.promotionRequest.findMany({
    where: { status: 'accepted' },
    include: { forge: { select: { id: true, name: true } } },
    orderBy: { decidedAt: 'desc' },
  });

  const countByForge = new Map<string, number>();
  for (const row of accepted) {
    countByForge.set(row.forgeId, (countByForge.get(row.forgeId) ?? 0) + 1);
  }

  const firsts = accepted.filter((row) => countByForge.get(row.forgeId) === 1);
  return Promise.all(
    firsts.map(async (row) => {
      const slug = slugifyForgeName(row.forge.name);
      let bundleTags: string[] = [];
      try {
        bundleTags = await registry.listTags(seedRepo(slug));
      } catch (err) {
        // A registry blip must not hide the candidate; it only hides the hint.
        console.error('[first-release] listTags failed for %s: %s', seedRepo(slug), err);
      }
      return {
        promotionId: row.id,
        forgeId: row.forgeId,
        forgeName: row.forge.name,
        slug,
        version: row.targetVersion,
        headSha: row.headSha,
        decidedAt: (row.decidedAt ?? row.updatedAt).toISOString(),
        bundleTags,
      };
    }),
  );
}

export type CutDeps = {
  registry?: RegistryClient;
  github?: GitHubClient;
  dump?: (opts: { dbName: string }) => Promise<string>;
  readMigrations?: (dbName: string) => Promise<string[] | null>;
};

export type CutResult = {
  repo: string;
  tag: string;
  manifestDigest: string;
  migrations: string[];
  bytes: number;
};

/**
 * Dump the forge database, pack it with the inventory row and provenance, and
 * push it to `<slug>-seed:<version>` (spec §2).
 *
 * Re-cutting overwrites the tag. Pilot cannot know whether prod has consumed a
 * bundle already, so the once-only guard lives on prod (spec §5).
 */
export async function cutBundle(
  currentUser: SessionUser,
  promotionId: string,
  deps: CutDeps = {},
): Promise<CutResult> {
  assertAdmin(currentUser);
  assertPilot();

  const registry = deps.registry ?? getRegistryClient();
  const github = deps.github ?? getGitHubClient();
  const dump = deps.dump ?? ((opts: { dbName: string }) => dumpForgeDatabase(opts));
  const readMigrations = deps.readMigrations ?? readAppliedMigrations;

  const promotion = await prisma.promotionRequest.findUnique({
    where: { id: promotionId },
    include: { forge: true },
  });
  if (!promotion) throw new NotFoundError('promotion', promotionId);
  if (promotion.status !== 'accepted') {
    throw new ValidationError(
      `Promotion ${promotionId} is not accepted (status ${promotion.status}); a bundle can ` +
        'only be cut from a released promotion',
      {},
    );
  }

  // First release only: exactly one accepted promotion for this forge.
  const acceptedCount = await prisma.promotionRequest.count({
    where: { forgeId: promotion.forgeId, status: 'accepted' },
  });
  if (acceptedCount !== 1) {
    throw new ValidationError(
      `${promotion.forge.name} has ${acceptedCount} accepted releases; a bundle is a ` +
        'first release mechanism only. Move the data by hand, or design an ongoing sync.',
      {},
    );
  }

  const forge = promotion.forge;
  const slug = slugifyForgeName(forge.name);
  const dbName = slugToDbName(slug);
  const version = promotion.targetVersion;

  // The app image this bundle seeds. Its digest pins not just the version but
  // the specific build (spec §5 version match).
  const appImageDigest = await registry.manifestDigest(slug, version);
  if (!appImageDigest) {
    throw new ValidationError(
      `No app image ${slug}:${version} in the registry; release the promotion before ` +
        'cutting its bundle',
      {},
    );
  }

  // Migration parity (spec §2): the database's applied migrations must be a
  // subset of the repo's at the released sha. Only pilot can check this — it is
  // the only side that can see both.
  const applied = await readMigrations(dbName);
  if (applied === null) {
    throw new ValidationError(
      `Database ${dbName} does not exist on this host; nothing to bundle`,
      {},
    );
  }
  const inRepo = new Set(
    await github.listDirectoryAtRef(forge.repoFullName, MIGRATIONS_DIR, promotion.headSha),
  );
  const ahead = applied.filter((m) => !inRepo.has(m));
  if (ahead.length > 0) {
    throw new ValidationError(
      `${forge.name}'s database has migrations the released commit does not: ` +
        `${ahead.join(', ')}. Dev has moved past ${version}, so this data's schema is ahead ` +
        'of the image. Release the newer schema first.',
      { migrations: ahead },
    );
  }

  const dataSql = await dump({ dbName });

  const contents: BundleContents = {
    forge: {
      name: forge.name,
      displayName: forge.displayName,
      description: forge.description,
      slug,
      repoFullName: forge.repoFullName,
      deployVersion: version,
    },
    dataSql,
    bundle: {
      version,
      sourceHost: hostname(),
      cutAt: new Date().toISOString(),
      appImageDigest,
      migrations: applied,
    },
  };

  const pushed = await pushBundle(registry, slug, contents);
  return { ...pushed, migrations: applied, bytes: Buffer.byteLength(dataSql, 'utf8') };
}
