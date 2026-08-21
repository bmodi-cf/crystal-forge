import { z } from 'zod';
import { ValidationError } from '@/lib/errors';
import { parseVersion } from '@/lib/versioning/semver';

/** The three files in a bundle layer (spec §1). */
export const BUNDLE_FILES = {
  forge: 'forge.json',
  data: 'data.sql',
  bundle: 'bundle.json',
} as const;

const semverTag = z.string().refine((v) => parseVersion(v) !== null, {
  message: 'must be a vMAJOR.MINOR.PATCH tag',
});

const contentDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 hex>');

/**
 * The inventory row, as carried across the gap.
 *
 * `repoFullName` is here because `Forge.repoFullName` is NOT NULL UNIQUE and
 * prod cannot derive it — the owner is configuration, not a function of the
 * slug. `createdById` is deliberately NOT here: it is a FK into the *importing*
 * dashboard's users table, so the import sets it to the admin doing the import
 * rather than shipping a user across.
 */
export const forgeJsonSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  slug: z.string().min(1),
  repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"'),
  deployVersion: semverTag,
});

/**
 * Provenance and the one guard prod can check locally.
 *
 * `appImageDigest` is a guard (spec §5 version match). `sourceHost`, `cutAt`
 * and `migrations` are provenance only — see spec §1 for why the migration
 * fingerprint cannot be re-checked on import.
 */
export const bundleJsonSchema = z.object({
  version: semverTag,
  sourceHost: z.string().min(1),
  cutAt: z.string().min(1),
  appImageDigest: contentDigest,
  migrations: z.array(z.string()),
});

export type ForgeJson = z.infer<typeof forgeJsonSchema>;
export type BundleJson = z.infer<typeof bundleJsonSchema>;

export type BundleContents = {
  forge: ForgeJson;
  dataSql: string;
  bundle: BundleJson;
};

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, file: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `Bundle ${file} is malformed`,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }
  return parsed.data;
}

export function parseForgeJson(raw: unknown): ForgeJson {
  return parseOrThrow(forgeJsonSchema, raw, BUNDLE_FILES.forge);
}

export function parseBundleJson(raw: unknown): BundleJson {
  return parseOrThrow(bundleJsonSchema, raw, BUNDLE_FILES.bundle);
}
