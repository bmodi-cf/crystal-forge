// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseCookieHeader, sessionTokenFromCookies } from './upgrade-cookie';

describe('parseCookieHeader', () => {
  it('parses a cookie header into a map', () => {
    expect(parseCookieHeader('a=1; b=two; c=')).toEqual({ a: '1', b: 'two', c: '' });
  });
  it('returns empty for undefined', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });
});

describe('sessionTokenFromCookies', () => {
  it('prefers the __Secure- cookie, falls back to the plain one', () => {
    expect(sessionTokenFromCookies({ '__Secure-authjs.session-token': 'sec', 'authjs.session-token': 'plain' })).toBe('sec');
    expect(sessionTokenFromCookies({ 'authjs.session-token': 'plain' })).toBe('plain');
  });
  it('returns null when no session cookie is present', () => {
    expect(sessionTokenFromCookies({ other: 'x' })).toBeNull();
  });
});
