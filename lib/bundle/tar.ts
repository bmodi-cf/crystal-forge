import { createHash } from 'node:crypto';

/**
 * Minimal ustar packing for bundle layers (three small text files).
 *
 * Hand-rolled rather than pulled from npm: the repo has no tar dependency and
 * this needs ~80 lines. The output is a valid ustar stream, which is what makes
 * `docker pull` work on a bundle as a manual fallback (spec §1.2).
 *
 * mtime is pinned to 0 so re-cutting identical content yields an identical
 * digest — the digest is a guard (spec §5), so it must not drift with the clock.
 */

const BLOCK = 512;
const NAME_MAX = 100;

export type TarEntry = { name: string; body: Buffer };

/** Octal field: `width - 1` zero-padded digits plus a trailing NUL. */
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, 'utf8') > NAME_MAX) {
    throw new Error(`tar entry name too long (>${NAME_MAX} bytes): ${name}`);
  }
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, NAME_MAX, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii'); // mode
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii'); // mtime — fixed, see above
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder: 8 spaces
  h.write('0', 156, 1, 'ascii'); // typeflag: regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');

  let sum = 0;
  for (const byte of h) sum += byte;
  // Classic checksum encoding: 6 octal digits, NUL, space.
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function padding(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

export function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e.name, e.body.length), e.body, padding(e.body.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive
  return Buffer.concat(parts);
}

export function readTar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  while (offset + BLOCK <= buf.length) {
    const h = buf.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break; // end-of-archive
    const name = h.subarray(0, NAME_MAX).toString('utf8').replace(/\0[\s\S]*$/, '');
    const sizeField = h.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, '');
    const size = Number.parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`corrupt tar: bad size field for entry ${JSON.stringify(name)}`);
    }
    const start = offset + BLOCK;
    if (start + size > buf.length) {
      throw new Error(`corrupt tar: entry ${JSON.stringify(name)} runs past end of archive`);
    }
    out.set(name, Buffer.from(buf.subarray(start, start + size)));
    offset = start + size + padding(size).length;
  }
  return out;
}

/** Registry-shaped content digest: `sha256:<hex>`. */
export function sha256Digest(buf: Buffer): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}
