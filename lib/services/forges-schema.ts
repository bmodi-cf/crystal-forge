import { z } from 'zod';

export const createForgeInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Max 120 characters'),
  description: z.string().trim().max(500, 'Max 500 characters').optional().or(z.literal('')),
  groups: z.array(z.string().min(1)).min(1, 'Pick at least one group'),
});

export type CreateForgeInput = z.infer<typeof createForgeInput>;

export const updateForgeInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Max 120 characters').optional(),
  description: z.string().trim().max(500, 'Max 500 characters').nullable().optional(),
  groups: z.array(z.string().min(1)).min(1, 'Pick at least one group').optional(),
});

export type UpdateForgeInput = z.infer<typeof updateForgeInput>;
