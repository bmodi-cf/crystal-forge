import { z } from 'zod';

export const importBundleInput = z.object({
  version: z.string().min(1),
});
