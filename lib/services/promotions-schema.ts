import { z } from 'zod';

export const requestPromotionInput = z.object({
  bumpLevel: z.enum(['major', 'minor', 'patch']).default('patch'),
});
export type RequestPromotionInput = z.infer<typeof requestPromotionInput>;

export const rejectPromotionInput = z.object({
  reason: z.string().max(500).optional(),
});
export type RejectPromotionInput = z.infer<typeof rejectPromotionInput>;
