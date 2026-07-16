// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { canEdit, canReadForge, canWriteForge, forgeReadFilter } from './acl';
import type { SessionUser } from './services/types';

const member: SessionUser = {
  id: 'user-maya', entraOid: null, email: 'maya@example.com', name: 'Maya', initials: 'M',
  groups: ['Engineering', 'R&D'], isAdmin: false, role: 'DEVELOPER',
};
const stranger: SessionUser = {
  id: 'user-stranger', entraOid: null, email: 's@example.com', name: 'Stranger', initials: 'S',
  groups: ['Sales'], isAdmin: false, role: 'DEVELOPER',
};
const admin: SessionUser = {
  id: 'user-admin', entraOid: null, email: 'a@example.com', name: 'Admin', initials: 'A',
  groups: [], isAdmin: true, role: 'ADMIN',
};
const forge = {
  id: 'forge-1',
  createdById: 'user-tom',
  groups: ['Engineering'],
};

describe('canEdit', () => {
  const base = { id: 'u', entraOid: null, email: 'e', name: 'n', initials: 'N', groups: [] };
  it('allows ADMIN', () => {
    expect(canEdit({ ...base, role: 'ADMIN', isAdmin: true })).toBe(true);
  });
  it('allows DEVELOPER', () => {
    expect(canEdit({ ...base, role: 'DEVELOPER', isAdmin: false })).toBe(true);
  });
  it('denies DEFAULT_USER', () => {
    expect(canEdit({ ...base, role: 'DEFAULT_USER', isAdmin: false })).toBe(false);
  });
});

describe('canReadForge', () => {
  it('allows a user whose group overlaps with the forge', () => {
    expect(canReadForge(member, forge)).toBe(true);
  });
  it('denies a user with no group overlap', () => {
    expect(canReadForge(stranger, forge)).toBe(false);
  });
  it('always allows admins', () => {
    expect(canReadForge(admin, forge)).toBe(true);
  });
  it('allows the creator even with no group overlap', () => {
    const orphan = { ...forge, createdById: stranger.id, groups: ['HR'] };
    expect(canReadForge(stranger, orphan)).toBe(true);
  });
});

describe('canWriteForge', () => {
  it('denies a non-creator non-admin even if they can read', () => {
    expect(canWriteForge(member, forge)).toBe(false);
  });
  it('allows the creator', () => {
    expect(canWriteForge({ ...member, id: 'user-tom' }, forge)).toBe(true);
  });
  it('allows admins regardless of creator', () => {
    expect(canWriteForge(admin, forge)).toBe(true);
  });
});

describe('forgeReadFilter', () => {
  it('admin → no filter (empty where)', () => {
    expect(forgeReadFilter(admin)).toEqual({});
  });
  it('non-admin → groups-overlap OR creator predicate', () => {
    const filter = forgeReadFilter(member);
    expect(filter).toEqual({
      OR: [
        { groups: { some: { group: { name: { in: ['Engineering', 'R&D'] } } } } },
        { createdById: member.id },
      ],
    });
  });
  it('member of zero groups → still matches forges they created', () => {
    const noGroups = { ...member, groups: [] };
    const filter = forgeReadFilter(noGroups);
    expect(filter).toEqual({
      OR: [
        { groups: { some: { group: { name: { in: [] } } } } },
        { createdById: noGroups.id },
      ],
    });
  });
});
