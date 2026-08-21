// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { writeTar, readTar, sha256Digest } from './tar';

describe('writeTar / readTar', () => {
  it('round-trips several entries, including one that does not fill a block', () => {
    const entries = [
      { name: 'forge.json', body: Buffer.from('{"name":"Second Set of Eyes"}', 'utf8') },
      { name: 'data.sql', body: Buffer.from('x'.repeat(1500), 'utf8') },
      { name: 'bundle.json', body: Buffer.from('{}', 'utf8') },
    ];

    const back = readTar(writeTar(entries));

    expect([...back.keys()].sort()).toEqual(['bundle.json', 'data.sql', 'forge.json']);
    expect(back.get('forge.json')!.toString('utf8')).toBe('{"name":"Second Set of Eyes"}');
    expect(back.get('data.sql')!.length).toBe(1500);
    expect(back.get('bundle.json')!.toString('utf8')).toBe('{}');
  });

  it('pads every entry to a 512-byte block and ends with two zero blocks', () => {
    const tar = writeTar([{ name: 'a.txt', body: Buffer.from('hi') }]);
    // one header + one padded body + two terminator blocks
    expect(tar.length).toBe(512 * 4);
    expect(tar.subarray(512 * 2).every((b) => b === 0)).toBe(true);
  });

  it('is deterministic: identical content yields an identical digest', () => {
    const make = () => writeTar([{ name: 'data.sql', body: Buffer.from('SELECT 1;') }]);
    expect(sha256Digest(make())).toBe(sha256Digest(make()));
  });

  it('round-trips an empty entry', () => {
    const back = readTar(writeTar([{ name: 'empty', body: Buffer.alloc(0) }]));
    expect(back.get('empty')!.length).toBe(0);
  });

  it('refuses a name longer than the 100-byte ustar field', () => {
    expect(() => writeTar([{ name: 'n'.repeat(101), body: Buffer.alloc(0) }])).toThrow(/too long/i);
  });

  it('sha256Digest returns a registry-shaped digest', () => {
    expect(sha256Digest(Buffer.from(''))).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
