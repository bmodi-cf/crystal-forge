import { PrismaClient, ForgeTone } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '@/lib/env';
import { getGitHubClient } from '@/lib/github/client';
import { slugifyForgeName, slugToDbName } from '@/lib/github/slug';
import { getDatabaseProvisioner } from '@/lib/db/provisioner';
import { renderEnvExample, renderClaudeSettings, renderBlockScript, renderClaudeMd } from '@/lib/services/forges';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
  log: ['error', 'warn'],
});

const GROUPS = [
  'Engineering',
  'Operations',
  'Sales',
  'Finance',
  'Marketing',
  'HR',
  'Service',
  'R&D',
] as const;

const USERS = [
  { email: 'maya.chen@crystalfountains.com',  name: 'Maya Chen',   initials: 'MC', groups: ['Engineering', 'R&D'], role: 'DEVELOPER' },
  { email: 'tom.reed@crystalfountains.com',   name: 'Tom Reed',    initials: 'TR', groups: ['Operations', 'Service'], role: 'DEVELOPER' },
  { email: 'alice.green@crystalfountains.com', name: 'Alice Green', initials: 'AG', groups: ['Marketing'], role: 'DEVELOPER' },
  { email: 'sam.viewer@crystalfountains.com', name: 'Sam Viewer',  initials: 'SV', groups: ['Marketing'], role: 'DEFAULT_USER' },
  { email: 'admin@crystalfountains.com',      name: 'Platform Admin', initials: 'PA', groups: [], role: 'ADMIN' },
] as const;

type ForgeSeed = {
  name: string;
  description: string;
  tone: ForgeTone;
  groups: readonly string[];
  createdByEmail: string;
};

const FORGES: ForgeSeed[] = [
  { name: 'Aquaflow Designer', description: 'Hydraulic modeling and nozzle simulation toolkit for fountain projects.', tone: 'navy', groups: ['Engineering', 'R&D'], createdByEmail: 'maya.chen@crystalfountains.com' },
  { name: 'Site Survey Pro',   description: 'Field-data capture for onsite installation teams. Photo, sketch, GPS.', tone: 'gold', groups: ['Operations', 'Service'], createdByEmail: 'tom.reed@crystalfountains.com' },
  { name: 'QuoteBuilder',      description: 'Generate detailed customer quotes from BOM templates and pricing rules.', tone: 'navy', groups: ['Sales', 'Finance'], createdByEmail: 'tom.reed@crystalfountains.com' },
  { name: 'Maintenance Hub',   description: 'Service ticket dispatch, schedules, and parts ordering for installed sites.', tone: 'grey', groups: ['Service', 'Operations'], createdByEmail: 'tom.reed@crystalfountains.com' },
  { name: 'BrandKit Manager',  description: 'Centralised assets, brand guidelines and approved imagery.', tone: 'gold', groups: ['Marketing'], createdByEmail: 'alice.green@crystalfountains.com' },
  { name: 'PeoplePulse',       description: 'Employee onboarding, PTO requests and internal directory.', tone: 'navy', groups: ['HR'], createdByEmail: 'admin@crystalfountains.com' },
  { name: 'Forge Labs',        description: 'Sandbox environment for prototyping new internal tooling.', tone: 'grey', groups: ['Engineering', 'R&D'], createdByEmail: 'maya.chen@crystalfountains.com' },
  { name: 'InvoiceBridge',     description: 'Sync customer invoices between Crystal ERP and external accounting.', tone: 'navy', groups: ['Finance'], createdByEmail: 'tom.reed@crystalfountains.com' },
  { name: 'Showcase Gallery',  description: 'Public-facing project portfolio with case studies and renders.', tone: 'grey', groups: ['Marketing', 'Sales'], createdByEmail: 'alice.green@crystalfountains.com' },
];

async function provisionForgeArtifacts(
  name: string,
  description: string,
): Promise<{ repoFullName: string }> {
  const slug = slugifyForgeName(name);
  const dbName = slugToDbName(slug);

  if (env.GITHUB_CLIENT_MODE === 'fake') {
    // Fake state is per-process and resets every seed run. Just hand back
    // a deterministic repoFullName for the DB row.
    return { repoFullName: `${env.GITHUB_REPO_OWNER}/${slug}` };
  }

  const client = getGitHubClient();
  const provisioner = getDatabaseProvisioner();

  // Adopt-on-conflict: if the repo or per-forge DB already exist (e.g. left
  // over from a prior seed), reuse them instead of failing. We never delete
  // an adopted repo on later failure — only repos this run actually created.
  let repoFullName: string;
  let adoptedRepo = false;
  try {
    const repo = await client.createRepoFromTemplate({
      name: slug,
      description,
      private: true,
    });
    repoFullName = repo.fullName;
  } catch (err) {
    if (!isRepoAlreadyExistsError(err)) throw err;
    repoFullName = `${env.GITHUB_REPO_OWNER}/${slug}`;
    adoptedRepo = true;
    console.log(`   ↪ adopting existing repo ${repoFullName}`);
  }

  try {
    await client.writeForgeFiles(repoFullName, {
      forgeConfig: {
        name,
        description: description.length > 0 ? description : null,
        slug,
        dbName,
        createdAt: new Date().toISOString(),
      },
      envExample: renderEnvExample(),
      claudeSettings: renderClaudeSettings(),
      claudeBlockScript: renderBlockScript(),
      claudeMd: renderClaudeMd(name, dbName),
    });

    try {
      await provisioner.createDatabase(dbName);
    } catch (err) {
      if (!isPgAlreadyExistsError(err)) throw err;
      console.log(`   ↪ adopting existing database ${dbName}`);
    }
  } catch (err) {
    if (!adoptedRepo) {
      try { await client.deleteRepo(repoFullName); } catch { /* logged below */ }
    }
    console.error(
      `❌ Failed to provision forge artefacts for "${name}". ` +
        `Investigate the error above before re-running the seed.`,
    );
    throw err;
  }

  return { repoFullName };
}

function isRepoAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: number; response?: { data?: { message?: string } } };
  return (
    e.status === 422 &&
    typeof e.response?.data?.message === 'string' &&
    e.response.data.message.includes('Name already exists')
  );
}

// Postgres SQLSTATE 42P04 = duplicate_database.
function isPgAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: string }).code === '42P04';
}

async function main() {
  console.log('🧹 Resetting seeded tables...');
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.forgeGroup.deleteMany();
  await prisma.forge.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.account.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.group.deleteMany();

  console.log('🌱 Seeding groups...');
  const groupRecords = await Promise.all(
    GROUPS.map((name) => prisma.group.create({ data: { name } })),
  );
  const groupByName = new Map(groupRecords.map((g) => [g.name, g] as const));

  console.log('🌱 Seeding users...');
  const userRecords = await Promise.all(
    USERS.map(async (u) => {
      const user = await prisma.user.create({
        data: { email: u.email, name: u.name, initials: u.initials, role: u.role },
      });
      for (const groupName of u.groups) {
        const group = groupByName.get(groupName);
        if (!group) throw new Error(`Unknown group: ${groupName}`);
        await prisma.userGroup.create({ data: { userId: user.id, groupId: group.id } });
      }
      return user;
    }),
  );
  const userByEmail = new Map(userRecords.map((u) => [u.email, u] as const));

  console.log(`🌱 Seeding forges (GITHUB_CLIENT_MODE=${env.GITHUB_CLIENT_MODE})...`);
  for (const f of FORGES) {
    const creator = userByEmail.get(f.createdByEmail);
    if (!creator) throw new Error(`Unknown creator: ${f.createdByEmail}`);

    const { repoFullName } = await provisionForgeArtifacts(f.name, f.description);

    const forge = await prisma.forge.create({
      data: {
        name: f.name,
        description: f.description,
        tone: f.tone,
        repoFullName,
        createdById: creator.id,
      },
    });
    for (const groupName of f.groups) {
      const group = groupByName.get(groupName);
      if (!group) throw new Error(`Unknown group: ${groupName}`);
      await prisma.forgeGroup.create({ data: { forgeId: forge.id, groupId: group.id } });
    }
  }

  console.log('✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
