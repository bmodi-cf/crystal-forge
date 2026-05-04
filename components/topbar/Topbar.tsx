import Image from 'next/image';
import type { SessionUser } from '@/lib/services/types';
import { UserMenu } from './UserMenu';

export function Topbar({ user }: { user: SessionUser }) {
  return (
    <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-[rgba(2,16,31,0.75)] px-8 backdrop-blur supports-[backdrop-filter]:bg-[rgba(2,16,31,0.6)]">
      <div className="flex items-center gap-3.5">
        <Image src="/crystal-fountains-logo.png" alt="Crystal Fountains" width={3596} height={806} className="h-7 w-auto" priority />
        <div className="h-5 w-px bg-border-strong" />
        <div className="text-xs font-medium uppercase tracking-[0.28em] text-ink-dim">
          <b className="font-semibold text-gold-soft">Crystal</b> Forge
        </div>
      </div>
      <UserMenu user={user} />
    </header>
  );
}
