import type { Forge } from '@/lib/services/types';

/** Gradient/border/text treatment for a forge's tone-colored initials block. */
export const TONE_CLASSES: Record<Forge['tone'], string> = {
  navy: 'bg-gradient-to-br from-[rgba(0,46,92,0.9)] to-[rgba(0,28,56,0.9)] text-[#9ec6ee] border-[rgba(60,110,170,0.4)]',
  gold: 'bg-gradient-to-br from-[rgba(185,160,96,0.25)] to-[rgba(140,119,71,0.4)] text-gold-soft border-[rgba(185,160,96,0.45)]',
  grey: 'bg-gradient-to-br from-[rgba(150,150,150,0.25)] to-[rgba(80,80,80,0.4)] text-[#e0e0e0] border-[rgba(150,150,150,0.4)]',
};
