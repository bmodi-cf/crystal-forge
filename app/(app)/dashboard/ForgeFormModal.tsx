'use client';

import { useEffect } from 'react';
import { useForm, Controller, type Control, type Path } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { Forge } from '@/lib/services/types';
import type { GroupDto } from '@/lib/services/groups';

const NAME_REGEX = /^[A-Za-z0-9 _-]+$/;

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Max 120 characters')
    .regex(
      NAME_REGEX,
      'Name may contain letters, numbers, spaces, underscores and dashes only',
    ),
  description: z.string().trim().max(500, 'Max 500 characters').optional().or(z.literal('')),
  groups: z.array(z.string().min(1)).min(1, 'Pick at least one group'),
});

const editSchema = z.object({
  displayName: z.string().trim().max(120, 'Max 120 characters').optional().or(z.literal('')),
  description: z.string().trim().max(500, 'Max 500 characters').optional().or(z.literal('')),
  groups: z.array(z.string().min(1)).min(1, 'Pick at least one group'),
});

type CreateValues = z.infer<typeof createSchema>;
type EditValues = z.infer<typeof editSchema>;

type Props =
  | {
      open: boolean;
      mode: 'create';
      allGroups: GroupDto[];
      myGroups: string[];
      isAdmin: boolean;
      onCancel: () => void;
      onSaved: () => void;
      forge?: never;
    }
  | {
      open: boolean;
      mode: 'edit';
      allGroups: GroupDto[];
      myGroups: string[];
      isAdmin: boolean;
      forge: Forge;
      onCancel: () => void;
      onSaved: () => void;
    };

export function ForgeFormModal(props: Props) {
  if (props.mode === 'create') return <CreateModal {...props} />;
  return <EditModal {...props} />;
}

function CreateModal(
  props: Extract<Props, { mode: 'create' }>,
): React.ReactElement {
  const { open, allGroups, myGroups, isAdmin, onCancel, onSaved } = props;
  const initial: CreateValues = { name: '', description: '', groups: [] };

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: initial,
  });

  useEffect(() => {
    if (open) reset(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onSubmit(values: CreateValues) {
    const body = JSON.stringify({
      name: values.name,
      description: values.description || '',
      groups: values.groups,
    });
    let res: Response;
    try {
      res = await fetch('/api/forges', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch {
      toast.error('Network error — please try again.');
      return;
    }
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const msg = payload?.error ?? `Request failed (${res.status})`;
      toast.error(msg);
      return;
    }
    toast.success('Forge created.');
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Forge</DialogTitle>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="forge-name">Name</Label>
            <Input id="forge-name" autoFocus {...register('name')} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-xs text-[#ff9f9f]">{errors.name.message}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="forge-description">Description</Label>
            <Textarea id="forge-description" rows={3} {...register('description')} aria-invalid={!!errors.description} />
            {errors.description && <p className="text-xs text-[#ff9f9f]">{errors.description.message}</p>}
          </div>

          <GroupChips
            control={control}
            allGroups={allGroups}
            myGroups={myGroups}
            isAdmin={isAdmin}
            error={errors.groups?.message}
          />

          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditModal(
  props: Extract<Props, { mode: 'edit' }>,
): React.ReactElement {
  const { open, allGroups, myGroups, isAdmin, forge, onCancel, onSaved } = props;
  const initial: EditValues = {
    displayName: forge.displayName ?? '',
    description: forge.description ?? '',
    groups: forge.groups,
  };

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: initial,
  });

  useEffect(() => {
    if (open) reset(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onSubmit(values: EditValues) {
    const body = JSON.stringify({
      displayName: values.displayName || null,
      description: values.description || null,
      groups: values.groups,
    });
    let res: Response;
    try {
      res = await fetch(`/api/forges/${forge.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch {
      toast.error('Network error — please try again.');
      return;
    }
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const msg = payload?.error ?? `Request failed (${res.status})`;
      toast.error(msg);
      return;
    }
    toast.success('Forge updated.');
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Forge</DialogTitle>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="forge-display-name">Display name</Label>
            <Input
              id="forge-display-name"
              autoFocus
              placeholder={forge.name}
              {...register('displayName')}
              aria-invalid={!!errors.displayName}
            />
            {errors.displayName && <p className="text-xs text-[#ff9f9f]">{errors.displayName.message}</p>}
            <p className="text-[11px] text-ink-faint">Shown on cards. Leave blank to use the internal name.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Internal name</Label>
            <div className="rounded-md border border-border bg-white/[0.02] px-3 py-2 text-sm text-ink-dim">
              {forge.name}
            </div>
            <p className="text-[11px] text-ink-faint">Used for the forge URL; immutable.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="forge-description">Description</Label>
            <Textarea
              id="forge-description"
              rows={3}
              {...register('description')}
              aria-invalid={!!errors.description}
            />
            {errors.description && <p className="text-xs text-[#ff9f9f]">{errors.description.message}</p>}
          </div>

          <GroupChips
            control={control}
            allGroups={allGroups}
            myGroups={myGroups}
            isAdmin={isAdmin}
            error={errors.groups?.message}
          />

          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupChips<T extends { groups: string[] }>({
  control,
  allGroups,
  myGroups,
  isAdmin,
  error,
}: {
  control: Control<T>;
  allGroups: GroupDto[];
  myGroups: string[];
  isAdmin: boolean;
  error: string | undefined;
}) {
  const memberOf = new Set(myGroups);
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Groups</Label>
      <Controller
        control={control}
        name={'groups' as Path<T>}
        render={({ field }) => {
          const selected = new Set(field.value as string[]);
          function toggle(name: string) {
            const next = new Set(selected);
            if (next.has(name)) next.delete(name); else next.add(name);
            field.onChange(Array.from(next));
          }
          return (
            <div className="flex flex-wrap gap-1.5">
              {allGroups.map((g) => {
                const isOn = selected.has(g.name);
                // Non-admins may only assign groups they belong to. A foreign
                // group already on the forge stays clickable so it can be
                // removed; once removed it cannot be re-added.
                const isDisabled = !isAdmin && !memberOf.has(g.name) && !isOn;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggle(g.name)}
                    aria-pressed={isOn}
                    disabled={isDisabled}
                    title={isDisabled ? 'You are not a member of this group' : undefined}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[11px] font-medium transition',
                      isOn
                        ? 'border-gold/40 bg-gold/[0.15] text-gold-soft'
                        : 'border-border bg-white/[0.04] text-ink-dim hover:border-border-strong',
                      isDisabled && 'cursor-not-allowed opacity-40 hover:border-border',
                    )}
                  >
                    {g.name}
                  </button>
                );
              })}
            </div>
          );
        }}
      />
      {error && <p className="text-xs text-[#ff9f9f]">{error}</p>}
    </div>
  );
}
