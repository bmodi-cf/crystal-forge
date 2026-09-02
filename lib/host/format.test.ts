import { describe, it, expect } from 'vitest';
import { toGiB, formatGiB, formatPct } from './format';

describe('formatGiB', () => {
  it('formats base-1024 GiB, which reads lower than docker base-1000 GB', () => {
    // `docker system df` prints this same byte count as "52.46GB".
    expect(formatGiB(52_456_054_966)).toBe('48.9 GiB');
  });

  it('formats a whole number of GiB', () => {
    expect(formatGiB(16 * 1024 ** 3)).toBe('16.0 GiB');
  });

  it('renders an em dash for a null reading', () => {
    expect(formatGiB(null)).toBe('—');
  });

  it('honours a digits override', () => {
    expect(formatGiB(52_456_054_966, 2)).toBe('48.85 GiB');
  });
});

describe('toGiB', () => {
  it('returns a plain number for chart axes', () => {
    expect(toGiB(1024 ** 3)).toBe(1);
  });
});

describe('formatPct', () => {
  it('rounds to whole percent by default', () => {
    expect(formatPct(37.4)).toBe('37 %');
  });

  it('renders an em dash for a null reading', () => {
    expect(formatPct(null)).toBe('—');
  });
});
