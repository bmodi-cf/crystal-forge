'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

type Props = {
  open: boolean;
  forgeName: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmDialog({ open, forgeName, busy, onCancel, onConfirm }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{forgeName}&rdquo;?</DialogTitle>
          <DialogDescription>
            This permanently deletes the Forge and any conversations attached to it. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
