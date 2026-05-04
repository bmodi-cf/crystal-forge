import { PrismaClient, ForgeStatus, ForgeTone } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

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
  { email: 'maya.chen@crystalfountains.com',  name: 'Maya Chen',   initials: 'MC', groups: ['Engineering', 'R&D'] },
  { email: 'tom.reed@crystalfountains.com',   name: 'Tom Reed',    initials: 'TR', groups: ['Operations', 'Service'] },
  { email: 'alice.green@crystalfountains.com', name: 'Alice Green', initials: 'AG', groups: ['Marketing'] },
  { email: 'admin@crystalfountains.com',      name: 'Platform Admin', initials: 'PA', groups: [], isAdmin: true },
] as const;

type ForgeSeed = {
  name: string;
  description: string;
  status: ForgeStatus;
  tone: ForgeTone;
  initials: string;
  groups: readonly string[];
  createdByEmail: string;
};

const FORGES: ForgeSeed[] = [
  { name: 'Aquaflow Designer', description: 'Hydraulic modeling and nozzle simulation toolkit for fountain projects.', status: 'active', tone: 'navy', initials: 'AD', groups: ['Engineering', 'R&D'], createdByEmail: 'maya.chen@crystalfountains.com' },
  { name: 'Site Survey Pro',   description: 'Field-data capture for onsite installation teams. Photo, sketch, GPS.', status: 'active', tone: 'gold', initials: 'SS', groups: ['Operations', 'Service'], createdByEmail: 'tom.reed@crystalfountains.com' },
  { name: 'QuoteBuilder',      description: 'Generate detailed customer quotes from BOM templates and pricing rules.', status: 'active', tone: 'navy', initials: 'QB', groups: ['Sales', 'Finance'], createdByEmail: 'tom.reed@crystalfountains.com' },
  { name: 'Maintenance Hub',   description: 'Service ticket dispatch, schedules, and parts ordering for installed sites.', status: 'active', tone: 'grey', initials: 'MH', groups: ['Service', 'Operations'], createdByEmail: 'tom.reed@crystalfountains.com' },
  { name: 'BrandKit Manager',  description: 'Centralised assets, brand guidelines and approved imagery.', status: 'draft', tone: 'gold', initials: 'BK', groups: ['Marketing'], createdByEmail: 'alice.green@crystalfountains.com' },
  { name: 'PeoplePulse',       description: 'Employee onboarding, PTO requests and internal directory.', status: 'active', tone: 'navy', initials: 'PP', groups: ['HR'], createdByEmail: 'admin@crystalfountains.com' },
  { name: 'Forge Labs',        description: 'Sandbox environment for prototyping new internal tooling.', status: 'draft', tone: 'grey', initials: 'FL', groups: ['Engineering', 'R&D'], createdByEmail: 'maya.chen@crystalfountains.com' },
  { name: 'InvoiceBridge',     description: 'Sync customer invoices between Crystal ERP and external accounting.', status: 'active', tone: 'navy', initials: 'IB', groups: ['Finance'], createdByEmail: 'tom.reed@crystalfountains.com' },
  { name: 'Showcase Gallery',  description: 'Public-facing project portfolio with case studies and renders.', status: 'archived', tone: 'grey', initials: 'SG', groups: ['Marketing', 'Sales'], createdByEmail: 'alice.green@crystalfountains.com' },
];

async function main() {
  console.log('🧹 Resetting seeded tables...');
  // Order matters: leaf tables first
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.forgeGroup.deleteMany();
  await prisma.forge.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.account.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.group.deleteMany();

  console.log('🌱 Seeding groups...');
  const groupRecords = await Promise.all(
    GROUPS.map((name) => prisma.group.create({ data: { name } }))
  );
  const groupByName = new Map(groupRecords.map((g) => [g.name, g] as const));

  console.log('🌱 Seeding users...');
  const userRecords = await Promise.all(
    USERS.map(async (u) => {
      const user = await prisma.user.create({
        data: { email: u.email, name: u.name, initials: u.initials },
      });
      for (const groupName of u.groups) {
        const group = groupByName.get(groupName);
        if (!group) throw new Error(`Unknown group: ${groupName}`);
        await prisma.userGroup.create({ data: { userId: user.id, groupId: group.id } });
      }
      if ('isAdmin' in u && u.isAdmin) {
        await prisma.userRole.create({ data: { userId: user.id, role: 'admin' } });
      }
      return user;
    })
  );
  const userByEmail = new Map(userRecords.map((u) => [u.email, u] as const));

  console.log('🌱 Seeding forges...');
  for (const f of FORGES) {
    const creator = userByEmail.get(f.createdByEmail);
    if (!creator) throw new Error(`Unknown creator: ${f.createdByEmail}`);
    const forge = await prisma.forge.create({
      data: {
        name: f.name,
        description: f.description,
        status: f.status,
        tone: f.tone,
        initials: f.initials,
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
