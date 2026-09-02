import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { buildSeries, RANGES, type UsageRange, type UsageSeries } from '@/lib/host/series';
import type { SessionUser } from './types';

export const USAGE_RANGES = Object.keys(RANGES) as UsageRange[];

/** Fallback cadence for gap detection when the sampler is disabled (e2e). */
const DEFAULT_SAMPLE_INTERVAL_MS = 300_000;

export async function getUsageSeries(
  currentUser: SessionUser,
  range: UsageRange,
): Promise<UsageSeries> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  const spec = RANGES[range];
  if (!spec) {
    throw new ValidationError('Unknown range', {
      range: [`Must be one of ${USAGE_RANGES.join(', ')}`],
    });
  }

  const rows = await prisma.hostSample.findMany({
    where: { at: { gte: new Date(Date.now() - spec.windowMs) } },
    orderBy: { at: 'asc' },
  });

  return buildSeries(rows, {
    range,
    sampleIntervalMs: env.FORGE_USAGE_SAMPLE_MS || DEFAULT_SAMPLE_INTERVAL_MS,
  });
}
