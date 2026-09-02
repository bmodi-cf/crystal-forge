'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const BASE_ITEMS = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/groups', label: 'Groups' },
  // Mode-independent: each dashboard samples the host it runs on, so prod gets
  // this page too.
  { href: '/admin/usage', label: 'Usage' },
];

// Prod deploys pinned images; dev promotes branches. The two never coexist, and
// each one's page 404s in the other mode — so the nav shows exactly one.
const PROMOTIONS = { href: '/admin/promotions', label: 'Promotions' };
const DEPLOYMENTS = { href: '/admin/deployments', label: 'Deployments' };

export function AdminNav({ prodMode }: { prodMode: boolean }) {
  const pathname = usePathname();
  const items = [...BASE_ITEMS, prodMode ? DEPLOYMENTS : PROMOTIONS];
  return (
    <aside className="w-44 shrink-0">
      <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-faint">Admin</div>
      <nav className="flex flex-col gap-1">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-2 text-sm transition ${
                active ? 'bg-panel text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
