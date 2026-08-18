import { describe, it, expect } from 'vitest';
import {
  promotionBlocker,
  promotionStatusLabel,
  canAcceptPromotion,
  GATE_START_GRACE_MS,
} from './promotion-blocker';

const T0 = Date.parse('2026-08-18T16:00:00.000Z');
const green = [
  { name: 'build', status: 'completed' as const, conclusion: 'success' as const },
];

function promo(over: Partial<Parameters<typeof promotionBlocker>[0]> = {}) {
  return {
    status: 'checks_running',
    createdAt: new Date(T0).toISOString(),
    summary: { gates: green, mergeable: true },
    ...over,
  };
}

describe('promotionBlocker', () => {
  it('reports a conflict when GitHub says the PR is not mergeable', () => {
    const b = promotionBlocker(promo({ summary: { gates: green, mergeable: false } }), T0);
    expect(b?.kind).toBe('conflict');
    expect(b?.message).toMatch(/conflict/i);
  });

  it('reports a conflict even when every gate is green — the merge would fail', () => {
    const b = promotionBlocker(
      promo({ status: 'awaiting_approval', summary: { gates: green, mergeable: false } }),
      T0,
    );
    expect(b?.kind).toBe('conflict');
  });

  it('does not cry conflict while GitHub is still computing mergeability', () => {
    expect(promotionBlocker(promo({ summary: { gates: green, mergeable: null } }), T0)).toBeNull();
  });

  it('stays quiet about an empty gate list inside the startup grace period', () => {
    const p = promo({ summary: { gates: [], mergeable: true } });
    expect(promotionBlocker(p, T0 + GATE_START_GRACE_MS - 1)).toBeNull();
  });

  it('reports no_gate_runs once the grace period has passed with zero runs', () => {
    const p = promo({ summary: { gates: [], mergeable: true } });
    const b = promotionBlocker(p, T0 + GATE_START_GRACE_MS + 1);
    expect(b?.kind).toBe('no_gate_runs');
    expect(b?.message).toMatch(/promote-gates/);
  });

  it('treats a never-refreshed summary as zero gate runs', () => {
    const b = promotionBlocker(promo({ summary: null }), T0 + GATE_START_GRACE_MS + 1);
    expect(b?.kind).toBe('no_gate_runs');
  });

  it('prefers the conflict over the missing-runs report — the conflict explains it', () => {
    const p = promo({ summary: { gates: [], mergeable: false } });
    expect(promotionBlocker(p, T0 + GATE_START_GRACE_MS + 1)?.kind).toBe('conflict');
  });

  it('never blocks a request that is already decided', () => {
    for (const status of ['accepted', 'rejected']) {
      const p = promo({ status, summary: { gates: [], mergeable: false } });
      expect(promotionBlocker(p, T0 + GATE_START_GRACE_MS + 1)).toBeNull();
    }
  });

  it('says nothing when gates are running normally', () => {
    expect(promotionBlocker(promo(), T0)).toBeNull();
  });
});

describe('promotionStatusLabel', () => {
  it('distinguishes "waiting to start" from "running"', () => {
    const waiting = promo({ summary: { gates: [], mergeable: true } });
    expect(promotionStatusLabel(waiting, T0)).toMatch(/waiting/i);
    expect(promotionStatusLabel(promo(), T0)).toMatch(/running/i);
  });

  it('labels a blocked request by its blocker, not by its stored status', () => {
    const conflicted = promo({ summary: { gates: green, mergeable: false } });
    expect(promotionStatusLabel(conflicted, T0)).toMatch(/conflict/i);

    const dead = promo({ summary: { gates: [], mergeable: true } });
    expect(promotionStatusLabel(dead, T0 + GATE_START_GRACE_MS + 1)).toMatch(/never started/i);
  });

  it('reads the decided and failed states plainly', () => {
    expect(promotionStatusLabel(promo({ status: 'checks_failed' }), T0)).toMatch(/failed/i);
    expect(promotionStatusLabel(promo({ status: 'awaiting_approval' }), T0)).toMatch(/approval/i);
    expect(promotionStatusLabel(promo({ status: 'accepted' }), T0)).toMatch(/accepted/i);
  });
});

describe('canAcceptPromotion', () => {
  it('allows only an unblocked request that is awaiting approval', () => {
    expect(canAcceptPromotion(promo({ status: 'awaiting_approval' }), T0)).toBe(true);
    expect(canAcceptPromotion(promo({ status: 'checks_running' }), T0)).toBe(false);
  });

  it('refuses an approved-but-conflicted request', () => {
    const p = promo({ status: 'awaiting_approval', summary: { gates: green, mergeable: false } });
    expect(canAcceptPromotion(p, T0)).toBe(false);
  });
});
