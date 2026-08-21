import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { isProdMode } from '@/lib/mode';
import { slugifyForgeName, slugToDbName, dbNameToRole } from '@/lib/github/slug';
import { getRegistryClient } from '@/lib/registry/client';
import type { RegistryClient } from '@/lib/registry/types';
import { getGitHubClient } from '@/lib/github/client';
import type { GitHubClient } from '@/lib/github/types';
import {
  dumpForgeDatabase,
  readAppliedMigrations,
  restoreForgeDatabase,
  readSeedMarker,
  seedMarkerSql,
} from '@/lib/db/dump';
import { getDatabaseProvisioner } from '@/lib/db/provisioner';
import type { DatabaseProvisioner } from '@/lib/db/types';
import { pushBundle, seedRepo, pullBundle, slugFromSeedRepo } from '@/lib/bundle/registry-bundle';
import type { BundleContents } from '@/lib/bundle/types';
import { parseVersion } from '@/lib/versioning/semver';
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

/** Importing writes prod's inventory and provisions prod's databases. */
function assertProd(): void {
  if (!isProdMode()) {
    throw new ForbiddenError('Bundles are imported on the production dashboard, not the pilot');
  }
}

export type BundleCandidate = {
  slug: string;
  repo: string;
  versions: string[];
};

/**
 * Un-imported bundles, discovered from the registry catalog (spec §3.1).
 *
 * The catalog is the only possible source: prod has no `Forge` row for a forge
 * it has never imported, so its own database cannot name one.
 *
 * A registry outage degrades to an empty list rather than an error — the
 * existing inventory table and status must stay unaffected (spec §6).
 */
export async function listBundleCandidates(
  currentUser: SessionUser,
  registry: RegistryClient = getRegistryClient(),
): Promise<BundleCandidate[]> {
  assertAdmin(currentUser);
  assertProd();

  let repos: string[];
  try {
    repos = await registry.listRepositories();
  } catch (err) {
    console.error('[first-release] registry catalog unavailable: %s', err);
    return [];
  }

  const known = new Set(
    (await prisma.forge.findMany({ select: { name: true } })).map((f) => slugifyForgeName(f.name)),
  );

  const candidates: BundleCandidate[] = [];
  for (const repo of repos) {
    const slug = slugFromSeedRepo(repo);
    if (!slug || known.has(slug)) continue;
    try {
      const versions = (await registry.listTags(repo)).filter((t) => parseVersion(t) !== null);
      if (versions.length > 0) candidates.push({ slug, repo, versions });
    } catch (err) {
      console.error('[first-release] listTags failed for %s: %s', repo, err);
    }
  }
  return candidates.sort((a, b) => a.slug.localeCompare(b.slug));
}

export type ImportDeps = {
  registry?: RegistryClient;
  provisioner?: DatabaseProvisioner;
  restore?: (opts: {
    dbName: string; role: string; password: string; sql: string;
  }) => Promise<void>;
  readMarker?: (dbName: string) => Promise<{ bundleDigest: string; version: string } | null>;
  randomPassword?: () => string;
};

export type ImportResult = {
  forgeId: string;
  slug: string;
  version: string;
  bundleDigest: string;
  deployEnabled: boolean;
};

/**
 * Apply a bundle (spec §3.2). The step order is what keeps the reconciler out
 * of the way: `listDesiredForges` returns only `deployEnabled: true` rows with a
 * non-null `deployVersion`, so the forge is invisible to it until step 6.
 *
 *   1. Pull and verify the bundle; check the marker.
 *   2. Write the Forge row with deployEnabled: false.
 *   3. createDatabase (idempotent) -> provisionRole -> setRolePassword.
 *   4. Restore data.sql as the app role...
 *   5. ...with the marker insert in the same transaction.
 *   6. Set deployEnabled: true and deployVersion — the handoff.
 */
export async function importBundle(
  currentUser: SessionUser,
  slug: string,
  version: string,
  deps: ImportDeps = {},
): Promise<ImportResult> {
  assertAdmin(currentUser);
  assertProd();

  const registry = deps.registry ?? getRegistryClient();
  const provisioner = deps.provisioner ?? getDatabaseProvisioner();
  const restore = deps.restore ?? ((o: Parameters<typeof restoreForgeDatabase>[0]) =>
    restoreForgeDatabase(o));
  const readMarker = deps.readMarker ?? readSeedMarker;
  const randomPassword = deps.randomPassword ?? (() => randomBytes(24).toString('hex'));

  if (parseVersion(version) === null) {
    throw new ValidationError(`${version} is not a vMAJOR.MINOR.PATCH tag`, {});
  }

  const dbName = slugToDbName(slug);
  const role = dbNameToRole(dbName);

  // --- Step 1: pull + verify ------------------------------------------------
  const { contents, manifestDigest } = await pullBundle(registry, slug, version);
  if (contents.bundle.version !== version) {
    throw new ValidationError(
      `Bundle ${seedRepo(slug)}:${version} declares version ${contents.bundle.version}`,
      {},
    );
  }

  // Version match: the bundle must seed a build prod can actually run.
  const appDigest = await registry.manifestDigest(slug, version);
  if (!appDigest) {
    throw new ValidationError(
      `No app image ${slug}:${version} in the registry — prod cannot run the version this ` +
        'bundle seeds',
      {},
    );
  }
  if (appDigest !== contents.bundle.appImageDigest) {
    throw new ValidationError(
      `Bundle ${seedRepo(slug)}:${version} was cut for a different build of ${version} ` +
        `(bundle records ${contents.bundle.appImageDigest}, registry has ${appDigest}). ` +
        'Re-cut the bundle against the image now tagged.',
      {},
    );
  }

  // Already known: prod having the row means this is not a first release.
  const existing = await prisma.forge.findUnique({ where: { name: contents.forge.name } });
  if (existing) {
    throw new ValidationError(
      `${contents.forge.name} is already known to this dashboard; a bundle is a ` +
        'first-release mechanism only',
      {},
    );
  }

  // Already imported: a readable refusal. The unconditional CREATE TABLE in
  // seedMarkerSql is the race-proof version of this same check.
  const marker = await readMarker(dbName);
  if (marker) {
    throw new ValidationError(
      `Database ${dbName} was already seeded (${marker.version}, bundle ` +
        `${marker.bundleDigest}). Re-seeding means dropping the database by hand.`,
      {},
    );
  }

  // --- Step 2: inventory row, deliberately disabled ------------------------
  const forge = await prisma.forge.create({
    data: {
      name: contents.forge.name,
      displayName: contents.forge.displayName,
      description: contents.forge.description,
      repoFullName: contents.forge.repoFullName,
      // The bundle carries no users. Attribute the row to the admin importing
      // it: createdById is a FK into *this* dashboard's users table.
      createdById: currentUser.id,
      deployEnabled: false,
      deployVersion: null,
    },
  });

  // --- Step 3: database, role, password ------------------------------------
  const password = randomPassword();
  try {
    await provisioner.createDatabase(dbName);
  } catch (err) {
    if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  await provisioner.provisionRole(dbName, role);
  await provisioner.setRolePassword(role, password);

  // --- Steps 4+5: data and marker, one transaction -------------------------
  await restore({
    dbName,
    role,
    password,
    sql: contents.dataSql + '\n' + seedMarkerSql(manifestDigest, version),
  });

  // --- Step 6: hand off to the reconciler ---------------------------------
  await prisma.forge.update({
    where: { id: forge.id },
    data: { deployEnabled: true, deployVersion: version },
  });

  return { forgeId: forge.id, slug, version, bundleDigest: manifestDigest, deployEnabled: true };
}
