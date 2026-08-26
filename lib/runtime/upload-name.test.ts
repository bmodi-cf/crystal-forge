import { describe, it, expect } from 'vitest';
import { sanitizeUploadName, UPLOAD_BYTE_LIMIT } from './upload-name';

describe('sanitizeUploadName', () => {
  it('keeps an ordinary filename intact', () => {
    expect(sanitizeUploadName('Site Survey v2.pdf')).toBe('Site Survey v2.pdf');
  });

  it('reduces a path to its basename', () => {
    expect(sanitizeUploadName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadName('/absolute/logo.png')).toBe('logo.png');
    expect(sanitizeUploadName('C:\\Users\\bmodi\\notes.txt')).toBe('notes.txt');
  });

  it('strips control characters and newlines', () => {
    expect(sanitizeUploadName('bad\nname\u0000.txt')).toBe('badname.txt');
  });

  it('strips leading dots so uploads are never hidden files', () => {
    expect(sanitizeUploadName('.env')).toBe('env');
    expect(sanitizeUploadName('...gitconfig')).toBe('gitconfig');
  });

  it('falls back to "upload" when nothing usable remains', () => {
    expect(sanitizeUploadName('')).toBe('upload');
    expect(sanitizeUploadName('.')).toBe('upload');
    expect(sanitizeUploadName('..')).toBe('upload');
    expect(sanitizeUploadName('   ')).toBe('upload');
    expect(sanitizeUploadName('\u0000\u0001')).toBe('upload');
  });

  it('caps length at 255 characters, preserving the extension', () => {
    const out = sanitizeUploadName(`${'a'.repeat(300)}.png`);
    expect(out).toHaveLength(255);
    expect(out.endsWith('.png')).toBe(true);
  });

  it('caps length when there is no usable extension', () => {
    expect(sanitizeUploadName('b'.repeat(300))).toHaveLength(255);
  });

  it('exposes a 100 MB byte limit', () => {
    expect(UPLOAD_BYTE_LIMIT).toBe(104_857_600);
  });
});
