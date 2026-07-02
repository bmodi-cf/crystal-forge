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

export type BumpLevel = 'major' | 'minor' | 'patch';

const LEVELS: BumpLevel[] = ['major', 'minor', 'patch'];

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  forgeName: string;
  onConfirm: (bump: BumpLevel) => Promise<void>;
};

export function RequestPromotionDialog({ open, onOpenChange, forgeName, onConfirm }: Props) {
  const [bump, setBump] = useState<BumpLevel>('patch');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onOpenChange(false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request production release — {forgeName}</DialogTitle>
          <DialogDescription>
            Opens a <code>dev → main</code> pull request and runs the gates. An admin approves the release.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setBump(l)}
              disabled={busy}
              aria-pressed={bump === l}
              className={cn(
                'rounded-md border px-3 py-1.5 text-[12px] font-medium disabled:opacity-50',
                bump === l ? 'border-gold/40 bg-gold/[0.15] text-gold-soft' : 'border-border text-ink-dim',
              )}
            >
              {l}
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="gold"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(bump);
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Requesting…' : 'Request release'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
