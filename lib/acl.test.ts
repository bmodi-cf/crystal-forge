// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { canReadForge, canWriteForge, forgeReadFilter } from './acl';
import type { SessionUser } from './services/types';

const member: SessionUser = {
  id: 'user-maya', entraOid: null, email: 'maya@example.com', name: 'Maya', initials: 'M',
  groups: ['Engineering', 'R&D'], isAdmin: false,
};
const stranger: SessionUser = {
  id: 'user-stranger', entraOid: null, email: 's@example.com', name: 'Stranger', initials: 'S',
  groups: ['Sales'], isAdmin: false,
};
const admin: SessionUser = {
  id: 'user-admin', entraOid: null, email: 'a@example.com', name: 'Admin', initials: 'A',
  groups: [], isAdmin: true,
};
const forge = {
  id: 'forge-1',
  createdById: 'user-tom',
  groups: ['Engineering'],
};

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
  it('non-admin → groups-overlap predicate', () => {
    const filter = forgeReadFilter(member);
    expect(filter).toEqual({
      groups: { some: { group: { name: { in: ['Engineering', 'R&D'] } } } },
    });
  });
  it('member of zero groups → impossible predicate (returns no rows)', () => {
    const noGroups = { ...member, groups: [] };
    const filter = forgeReadFilter(noGroups);
    expect(filter).toEqual({
      groups: { some: { group: { name: { in: [] } } } },
    });
  });
});
