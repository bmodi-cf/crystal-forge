import { describe, it, expect } from 'vitest';
import { parseCpuLine, parseMeminfo } from './proc';

const PROC_STAT = `cpu  6071251 13104 4865847 109790958 906528 0 105246 0 0 0
cpu0 6071251 13104 4865847 109790958 906528 0 105246 0 0 0
intr 1234567
ctxt 987654
`;

const MEMINFO = `MemTotal:       16373060 kB
MemFree:          468224 kB
MemAvailable:    6505424 kB
Buffers:          123456 kB
`;

describe('parseCpuLine', () => {
  it('sums every field into total and picks out idle and iowait', () => {
    // 6071251 + 13104 + 4865847 + 109790958 + 906528 + 0 + 105246 = 121752934
    expect(parseCpuLine(PROC_STAT)).toEqual({
      total: 121_752_934n,
      idle: 109_790_958n,
      iowait: 906_528n,
    });
  });

  it('reads only the aggregate line, not per-core lines', () => {
    const doubled = `cpu  1 0 1 8 0 0 0\ncpu0 999 999 999 999 999 999 999\n`;
    expect(parseCpuLine(doubled)).toEqual({ total: 10n, idle: 8n, iowait: 0n });
  });

  it('tolerates kernels reporting fewer columns', () => {
    expect(parseCpuLine('cpu  10 0 5 85\n')).toEqual({ total: 100n, idle: 85n, iowait: 0n });
  });

  it('throws when there is no aggregate cpu line', () => {
    expect(() => parseCpuLine('intr 1\n')).toThrow(/aggregate cpu line/i);
  });
});

describe('parseMeminfo', () => {
  it('converts kB to bytes', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      total: 16_766_013_440n,
      available: 6_661_554_176n,
    });
  });

  it('throws when MemAvailable is absent', () => {
    expect(() => parseMeminfo('MemTotal: 100 kB\n')).toThrow(/MemAvailable/);
  });

  it('throws when MemTotal is absent', () => {
    expect(() => parseMeminfo('MemAvailable: 100 kB\n')).toThrow(/MemTotal/);
  });
});
