import { UsageClient } from './UsageClient';

// Always fresh: the series changes every 5 minutes and must never be cached.
export const dynamic = 'force-dynamic';

export default function AdminUsagePage() {
  return <UsageClient />;
}
