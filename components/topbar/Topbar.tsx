import Image from 'next/image';
import Link from 'next/link';
import { canEdit } from '@/lib/acl';
import { cn } from '@/lib/utils';
import type { SessionUser } from '@/lib/services/types';
import { isProdMode } from '@/lib/mode';
import { UserMenu } from './UserMenu';

export function Topbar({ user }: { user: SessionUser }) {
  // Dev mode IS the pilot dashboard — Edit and Promote are live, so anything
  // done here is throwaway. Make that impossible to mistake for production.
  const pilot = !isProdMode();

  return (
    <header
      data-pilot={pilot ? 'true' : undefined}
      className={cn(
        'sticky top-0 z-50 flex h-16 items-center justify-between border-b px-8',
        // No `relative` here: it lands in tailwind-merge's `position` group and
        // would silently drop `sticky`, unpinning the bar. `sticky` is already a
        // positioned ancestor for the chip and hazard strip.
        pilot
          ? 'border-[#a33b3b] bg-[#7f1d1d]'
          : 'border-border bg-[rgba(2,16,31,0.75)] backdrop-blur supports-[backdrop-filter]:bg-[rgba(2,16,31,0.6)]',
      )}
    >
      <div className="flex items-center gap-3.5">
        <Image src="/crystal-fountains-logo.png" alt="Crystal Fountains" width={3596} height={806} className="h-7 w-auto" priority />
        <div className={cn('h-5 w-px', pilot ? 'bg-white/25' : 'bg-border-strong')} />
        <div className={cn('text-xs font-medium uppercase tracking-[0.28em]', pilot ? 'text-white/70' : 'text-ink-dim')}>
          <b className={cn('font-semibold', pilot ? 'text-white' : 'text-gold-soft')}>Crystal</b> Forge
        </div>
      </div>

      {pilot && <PilotChip />}

      <div className={cn('flex items-center gap-6', pilot && '[&_a]:text-white/75 [&_a:hover]:text-white')}>
        {pilot && canEdit(user) && (
          <Link
            href="/dashboard"
            className="text-xs font-medium uppercase tracking-[0.18em] text-ink-dim transition hover:text-ink"
          >
            Edit
          </Link>
        )}
        <Link
          href="/launch"
          className="text-xs font-medium uppercase tracking-[0.18em] text-ink-dim transition hover:text-ink"
        >
          Launch
        </Link>
        {user.isAdmin && (
          <Link
            href="/admin"
            className="text-xs font-medium uppercase tracking-[0.18em] text-ink-dim transition hover:text-ink"
          >
            Admin
          </Link>
        )}
        <UserMenu user={user} />
      </div>

      {pilot && (
        // Hazard edging along the bottom lip of the bar.
        <div aria-hidden="true" className="pilot-hazard pointer-events-none absolute inset-x-0 bottom-0 h-1.5" />
      )}
    </header>
  );
}

/**
 * Centred on the viewport rather than placed in the flex flow, so the chip sits
 * dead centre regardless of how wide the brand block or the nav happen to be.
 * `pointer-events-none` keeps it from swallowing clicks aimed at the nav.
 */
function PilotChip() {
  return (
    <div className="pointer-events-none absolute left-1/2 -translate-x-1/2">
      <div
        title="Pilot environment — changes here are not production"
        className="relative overflow-hidden rounded-md border border-white/45 bg-white/10 px-5 py-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
      >
        {/* text-indent cancels the trailing letter-space so PILOT stays optically centred */}
        <span className="text-base font-bold uppercase tracking-[0.5em] text-white [text-indent:0.5em]">
          PILOT
        </span>
        <span
          aria-hidden="true"
          className="pilot-glint absolute inset-y-0 -left-1/3 w-1/3 skew-x-12 bg-gradient-to-r from-transparent via-white/55 to-transparent"
        />
      </div>
    </div>
  );
}
