'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

type DevUser = { email: string; name: string };

export function LoginPanel({ devUsers }: { devUsers: DevUser[] }) {
  const [pending, setPending] = useState(false);
  const [devEmail, setDevEmail] = useState(devUsers[0]?.email ?? '');

  async function handleEntra() {
    setPending(true);
    await signIn('microsoft-entra-id', { callbackUrl: '/' });
  }

  async function handleDev() {
    if (!devEmail) return;
    setPending(true);
    const res = await fetch('/api/dev/switch-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: devEmail }),
    });
    if (res.ok) {
      window.location.href = '/';
    } else {
      setPending(false);
      alert(`Dev sign-in failed: ${res.status}`);
    }
  }

  return (
    <div
      className="flex flex-col items-center gap-3.5 opacity-0"
      style={{ animation: 'fadeUp 400ms ease-out 100ms forwards' }}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.32em] text-[#969696]">Sign in to continue</div>

      <button
        type="button"
        disabled={pending}
        onClick={handleEntra}
        className="inline-flex min-w-[340px] items-center justify-center gap-3.5 rounded-[10px] border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] px-7 py-4 font-medium text-ink shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_12px_30px_-12px_rgba(0,0,0,0.7)] transition disabled:opacity-50 hover:-translate-y-px hover:border-gold/55 hover:bg-gradient-to-b hover:from-gold/[0.08] hover:to-white/[0.02]"
      >
        <span className="grid h-[18px] w-[18px] grid-cols-2 grid-rows-2 gap-0.5" aria-hidden>
          <span className="bg-[#F25022]" />
          <span className="bg-[#7FBA00]" />
          <span className="bg-[#00A4EF]" />
          <span className="bg-[#FFB900]" />
        </span>
        <span>{pending ? 'Redirecting to Microsoft…' : 'Login with Microsoft Entra ID'}</span>
      </button>

      {devUsers.length > 0 && (
        <div className="mt-2 flex w-full min-w-[340px] flex-col gap-2 rounded-[10px] border border-dashed border-white/10 p-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-faint">Dev sign-in (seeded users)</div>
          <div className="flex gap-2">
            <select
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
              className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm text-ink"
            >
              {devUsers.map((u) => (
                <option key={u.email} value={u.email}>{u.name} — {u.email}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || !devEmail}
              onClick={handleDev}
              className="rounded-md border border-border-strong bg-panel-2 px-4 py-2 text-sm text-ink hover:border-gold/45 disabled:opacity-50"
            >
              Sign in
            </button>
          </div>
        </div>
      )}

      <div className="mt-1 text-[12.5px] text-ink-dim">
        Trouble signing in? <a className="border-b border-gold-soft/25 text-gold-soft hover:border-gold" href="#">Contact your administrator</a>
      </div>
    </div>
  );
}
