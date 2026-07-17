'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/promotions', label: 'Promotions' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <aside className="w-44 shrink-0">
      <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-faint">Admin</div>
      <nav className="flex flex-col gap-1">
        {ITEMS.map((item) => {
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
