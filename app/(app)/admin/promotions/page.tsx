import { notFound } from 'next/navigation';
import { isProdMode } from '@/lib/mode';
import { PromotionsClient } from './PromotionsClient';

export const dynamic = 'force-dynamic';

export default function AdminPromotionsPage() {
  if (isProdMode()) notFound();
  return <PromotionsClient />;
}
