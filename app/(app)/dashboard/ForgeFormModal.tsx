'use client';

import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
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

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Max 120 characters'),
  description: z.string().trim().max(500, 'Max 500 characters').optional().or(z.literal('')),
  groups: z.array(z.string().min(1)).min(1, 'Pick at least one group'),
});

/** Zod v4-compatible resolver (v4 uses .issues, not .errors) */
function zodV4Resolver<TFieldValues extends FieldValues>(
  schema: z.ZodTypeAny,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Resolver<TFieldValues, any> {
  return (async (values: TFieldValues) => {
    const result = await schema.safeParseAsync(values);
    if (result.success) {
      return { values: result.data as TFieldValues, errors: {} };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errors: Record<string, any> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      if (!errors[path]) {
        errors[path] = { message: issue.message, type: issue.code };
      }
    }
    return { values: {} as TFieldValues, errors: errors as FieldErrors<TFieldValues> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as unknown as Resolver<TFieldValues, any>;
}

type FormValues = z.infer<typeof formSchema>;

type Props =
  | {
      open: boolean;
      mode: 'create';
      allGroups: GroupDto[];
      onCancel: () => void;
      onSaved: () => void;
      forge?: never;
    }
  | {
      open: boolean;
      mode: 'edit';
      allGroups: GroupDto[];
      forge: Forge;
      onCancel: () => void;
      onSaved: () => void;
    };

export function ForgeFormModal(props: Props) {
  const { open, mode, allGroups, onCancel, onSaved } = props;
  const initial: FormValues =
    mode === 'edit'
      ? { name: props.forge.name, description: props.forge.description ?? '', groups: props.forge.groups }
      : { name: '', description: '', groups: [] };

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodV4Resolver(formSchema),
    defaultValues: initial,
  });

  useEffect(() => {
    if (open) reset(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onSubmit(values: FormValues) {
    const url = mode === 'edit' ? `/api/forges/${props.forge.id}` : '/api/forges';
    const method = mode === 'edit' ? 'PATCH' : 'POST';
    const body = JSON.stringify({
      name: values.name,
      description: values.description || null,
      groups: values.groups,
    });
    let res: Response;
    try {
      res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body });
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
    toast.success(mode === 'edit' ? 'Forge updated.' : 'Forge created.');
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? 'Edit Forge' : 'New Forge'}</DialogTitle>
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

          <div className="flex flex-col gap-1.5">
            <Label>Groups</Label>
            <Controller
              control={control}
              name="groups"
              render={({ field }) => {
                const selected = new Set(field.value);
                function toggle(name: string) {
                  const next = new Set(selected);
                  if (next.has(name)) next.delete(name); else next.add(name);
                  field.onChange(Array.from(next));
                }
                return (
                  <div className="flex flex-wrap gap-1.5">
                    {allGroups.map((g) => {
                      const isOn = selected.has(g.name);
                      return (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => toggle(g.name)}
                          aria-pressed={isOn}
                          className={cn(
                            'rounded-md border px-2 py-1 text-[11px] font-medium transition',
                            isOn
                              ? 'border-gold/40 bg-gold/[0.15] text-gold-soft'
                              : 'border-border bg-white/[0.04] text-ink-dim hover:border-border-strong',
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
            {errors.groups && <p className="text-xs text-[#ff9f9f]">{errors.groups.message}</p>}
          </div>

          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
