import { z } from 'zod';

export const deployForgeInput = z.object({
  version: z.string().min(1),
});
