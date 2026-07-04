'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { nextVersion } from '@/lib/versioning/semver';

export type BumpLevel = 'major' | 'minor' | 'patch';

const LEVELS: { value: BumpLevel; label: string }[] = [
  { value: 'major', label: 'Major' },
  { value: 'minor', label: 'Minor' },
  { value: 'patch', label: 'Patch' },
];

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  forgeName: string;
  /** Last accepted release version (e.g. "v1.2.0"), or null before any release. */
  currentVersion: string | null;
  onConfirm: (bump: BumpLevel) => Promise<void>;
};

export function RequestPromotionDialog({
  open,
  onOpenChange,
  forgeName,
  currentVersion,
  onConfirm,
}: Props) {
  const [bump, setBump] = useState<BumpLevel>('minor');
  const [busy, setBusy] = useState(false);

  // Reset on close so the next open starts fresh at the Minor default.
  const close = () => {
    setBump('minor');
    onOpenChange(false);
  };

  const resultantVersion = nextVersion(currentVersion, bump);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request production release — {forgeName}</DialogTitle>
          <DialogDescription>
            Opens a <code>dev → main</code> pull request and runs the gates. An admin approves the release.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          {LEVELS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setBump(value)}
              disabled={busy}
              aria-pressed={bump === value}
              className={cn(
                'rounded-md border px-3 py-1.5 text-[12px] font-medium disabled:opacity-50',
                bump === value ? 'border-gold/40 bg-gold/[0.15] text-gold-soft' : 'border-border text-ink-dim',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-[12px] text-ink-dim">
          <span>
            Current version:{' '}
            {currentVersion ? (
              <span className="font-medium text-ink">{currentVersion}</span>
            ) : (
              <span className="italic">no releases yet</span>
            )}
          </span>
          <span aria-hidden>→</span>
          <span>
            New version: <span className="font-medium text-gold-soft">{resultantVersion}</span>
          </span>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="gold"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(bump);
                close();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Starting…' : 'Start Production Release'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
