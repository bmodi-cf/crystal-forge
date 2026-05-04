'use client';

import { signOut } from 'next-auth/react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SessionUser } from '@/lib/services/types';
import { ChevronDown, LogOut, UserCircle, Bell, HelpCircle } from 'lucide-react';

export function UserMenu({ user }: { user: SessionUser }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2.5 rounded-full border border-transparent px-2.5 py-1.5 transition hover:border-border-strong hover:bg-panel">
        <Avatar className="h-8 w-8 bg-gradient-to-br from-gold to-gold-deep text-[#1a1408] ring-1 ring-gold/30">
          <AvatarFallback className="bg-transparent text-xs font-semibold">{user.initials}</AvatarFallback>
        </Avatar>
        <div className="hidden flex-col items-start leading-tight sm:flex">
          <span className="text-[13px] font-medium text-ink">{user.name}</span>
          <span className="text-[11px] text-ink-dim">{user.email}</span>
        </div>
        <ChevronDown className="h-3.5 w-3.5 text-ink-dim" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-[220px] border-border-strong bg-[#0a1a2c] text-ink" align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.18em] text-ink-faint">Account</DropdownMenuLabel>
          <DropdownMenuItem className="gap-2.5"><UserCircle className="h-3.5 w-3.5" /> Profile settings</DropdownMenuItem>
          <DropdownMenuItem className="gap-2.5"><Bell className="h-3.5 w-3.5" /> Notifications</DropdownMenuItem>
          <DropdownMenuItem className="gap-2.5"><HelpCircle className="h-3.5 w-3.5" /> Help & support</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="bg-border" />
        <DropdownMenuGroup>
          <DropdownMenuItem
            className="gap-2.5 text-[#e89393] focus:bg-[rgba(217,104,104,0.12)] focus:text-[#ff9f9f]"
            onSelect={() => signOut({ callbackUrl: '/login' })}
          >
            <LogOut className="h-3.5 w-3.5" /> Logout
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
