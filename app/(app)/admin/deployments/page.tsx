import { notFound } from 'next/navigation';
import { isProdMode } from '@/lib/mode';
import { DeploymentsClient } from './DeploymentsClient';

export const dynamic = 'force-dynamic';

export default function AdminDeploymentsPage() {
  if (!isProdMode()) notFound();
  return <DeploymentsClient />;
}
