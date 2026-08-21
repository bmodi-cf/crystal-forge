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
import { assertSafeIdentifier } from '@/lib/db/identifiers';
import type { DatabaseProvisioner } from '@/lib/db/types';
import { pushBundle, seedRepo, pullBundle, slugFromSeedRepo } from '@/lib/bundle/registry-bundle';
import type { BundleContents } from '@/lib/bundle/types';
import { parseVersion } from '@/lib/versioning/semver';
import type { SessionUser } from './types';

const MIGRATIONS_DIR = 'prisma/migrations';

/**
 * Ceiling on a bundle's `data.sql`, enforced right after the dump.
 *
 * Nothing in the cut path streams: the dump is concatenated into one string,
 * `packLayer` builds a tar buffer and then a gzip buffer from it, and
 * `pushBundle` hands the whole layer over as a single `Uint8Array`. Peak
 * resident memory is therefore roughly 4-5x the dump. The pilot is a
 * single-vCPU VM whose forge containers have no resource limits and which has
 * already been hung once by resource exhaustion, and an OOM here kills the
 * dashboard process that owns every running forge — so refuse loudly at a size
 * we know is survivable rather than discovering the limit by taking the host
 * down. A forge past this size needs the by-hand `pg_dump`/`psql` path.
 */
const MAX_DUMP_BYTES = 256 * 1024 * 1024;

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
  /** Test seam only: lets a test exercise the guard without allocating 256 MB. */
  maxDumpBytes?: number;
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
  const bytes = Buffer.byteLength(dataSql, 'utf8');
  const maxDumpBytes = deps.maxDumpBytes ?? MAX_DUMP_BYTES;
  if (bytes > maxDumpBytes) {
    throw new ValidationError(
      `${forge.name}'s dump is ${bytes} bytes, over the ${maxDumpBytes}-byte bundle limit. ` +
        'Packing and pushing it needs several times that in memory and would risk taking the ' +
        'pilot down. Move this database by hand instead: pg_dump on the pilot, psql into the ' +
        'production database.',
      { bytes: [String(bytes)] },
    );
  }

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
  return { ...pushed, migrations: applied, bytes };
}

/** Importing writes prod's inventory and provisions prod's databases. */
function assertProd(): void {
  if (!isProdMode()) {
    throw new ForbiddenError('Bundles are imported on the production dashboard, not the pilot');
  }
}

/**
 * A forge prod is genuinely running or has been deployed — as opposed to the
 * inert row a failed import leaves behind. Discovery and importBundle MUST
 * agree on this, or the UI offers rows the service refuses (or hides rows it
 * would accept, which is what happened before this was shared).
 */
function isLiveForge(f: { deployEnabled: boolean; deployVersion: string | null }): boolean {
  return f.deployEnabled || f.deployVersion !== null;
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

  // Only *live* forges hide a bundle. A disabled, version-less row is the
  // aftermath of an interrupted import, and importBundle resumes exactly that
  // row — so filtering it out here would remove the retry from the UI while
  // the service still supported it.
  const known = new Set(
    (
      await prisma.forge.findMany({
        select: { name: true, deployEnabled: true, deployVersion: true },
      })
    )
      .filter(isLiveForge)
      .map((f) => slugifyForgeName(f.name)),
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
  const restore = deps.restore ?? restoreForgeDatabase;
  const readMarker = deps.readMarker ?? readSeedMarker;
  const randomPassword = deps.randomPassword ?? (() => randomBytes(24).toString('hex'));

  if (parseVersion(version) === null) {
    throw new ValidationError(`${version} is not a vMAJOR.MINOR.PATCH tag`, {});
  }

  const dbName = slugToDbName(slug);
  // Fail fast. assertSafeIdentifier runs inside the provisioner and the restore
  // too, but `slug` reaches seedRepo() and gets interpolated into a registry
  // URL before either — and it arrives from the route path.
  assertSafeIdentifier(dbName, 'database');
  const role = dbNameToRole(dbName);

  // --- Step 1: pull + verify ------------------------------------------------
  const { contents, manifestDigest } = await pullBundle(registry, slug, version);
  if (contents.bundle.version !== version) {
    throw new ValidationError(
      `Bundle ${seedRepo(slug)}:${version} declares version ${contents.bundle.version}`,
      {},
    );
  }

  // The forge slug the pilot recorded must be the one we are importing as: it
  // is what names the database, the role and the app image, so a mismatch means
  // this bundle would be restored into the wrong forge's database.
  if (contents.forge.slug !== slug) {
    throw new ValidationError(
      `Bundle ${seedRepo(slug)}:${version} was cut for forge slug ` +
        `${contents.forge.slug}, not ${slug}`,
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

  // Already known: keyed on slug, not name. slugifyForgeName collapses case
  // and whitespace, so two distinct Forge.name values ("Work Order Tool" vs
  // "Work order tool") can still land on the very same database and role —
  // an exact-name comparison would miss that and let a second import rotate
  // a live forge's role password out from under it. A forge is genuinely
  // "already known" only once it has actually been deployed (isLiveForge).
  // A row that is disabled with no version is the inert aftermath of an
  // interrupted or failed import — see the resumable branch at Step 2 below,
  // not a refusal here.
  //
  // Every match matters, not the first one an arbitrary row order happens to
  // yield: Forge.name is unique but case- and whitespace-sensitive, so a stub
  // and a live forge can collide on the same slug (hand-written SQL can create
  // that pair even though createForge cannot). Picking the stub there would
  // rotate the *live* forge's role password in step 3 and then abort the
  // restore on its existing tables, locking a running production forge out of
  // its own database.
  const knownForges = await prisma.forge.findMany({
    select: { id: true, name: true, deployEnabled: true, deployVersion: true },
  });
  const sameSlug = knownForges.filter((f) => slugifyForgeName(f.name) === slug);
  const live = sameSlug.find(isLiveForge);
  if (live) {
    throw new ValidationError(
      `${live.name} is already known to this dashboard; a bundle is a ` +
        'first-release mechanism only',
      {},
    );
  }
  if (sameSlug.length > 1) {
    throw new ValidationError(
      `${sameSlug.length} forge rows already share the slug ${slug} ` +
        `(${sameSlug.map((f) => JSON.stringify(f.name)).join(', ')}). None is deployed, so ` +
        'none can be resumed safely — reconcile them by hand before importing.',
      {},
    );
  }
  const existing = sameSlug[0] ?? null;

  // Already imported: a readable refusal. The unconditional CREATE TABLE in
  // seedMarkerSql is the race-proof version of this same check, and remains
  // the sole authority on it — this one only makes a stuck stub's state
  // legible before that point.
  const marker = await readMarker(dbName);
  if (marker) {
    throw new ValidationError(
      `Database ${dbName} was already seeded (${marker.version}, bundle ` +
        `${marker.bundleDigest}). Re-seeding means dropping the database by hand.`,
      {},
    );
  }

  // --- Step 2: inventory row, deliberately disabled -------------------------
  // `existing`, if present, is the *only* row on this slug and is guaranteed
  // disabled with no version (a live sibling, or a second non-live one, threw
  // above) and has no marker (checked just above) — the inert aftermath of a
  // prior attempt that never finished.
  // Resume it rather than creating a second row for the same slug, so a
  // failed or crashed import stays retryable instead of getting stuck behind
  // its own "already known" guard.
  const forge = existing
    ? existing
    : await prisma.forge.create({
        data: {
          name: contents.forge.name,
          displayName: contents.forge.displayName,
          description: contents.forge.description,
          repoFullName: contents.forge.repoFullName,
          // The bundle carries no users. Attribute the row to the admin
          // importing it: createdById is a FK into *this* dashboard's users
          // table.
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
