// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUploads } from './useUploads';

class FakeXhr {
  method?: string;
  url?: string;
  sent?: unknown;
  status = 0;
  responseText = '';
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() { xhrs.push(this); }

  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader() {}
  send(b: unknown) { this.sent = b; }
  abort() { this.onabort?.(); }
}

let xhrs: FakeXhr[] = [];

beforeEach(() => {
  xhrs = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
});

afterEach(() => { vi.unstubAllGlobals(); });

function file(name: string, size = 4): File {
  const f = new File(['abcd'], name, { type: 'application/octet-stream' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('useUploads', () => {
  it('POSTs each file to the uploads route with the name in the query', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('a b.png'), file('c.txt')]); });

    expect(xhrs).toHaveLength(2);
    expect(xhrs[0]!.method).toBe('POST');
    // encodeURIComponent, so a space is %20 (not the +-form URLSearchParams gives).
    expect(xhrs[0]!.url).toBe('/api/forges/f1/uploads?name=a%20b.png');
    expect(xhrs[1]!.url).toBe('/api/forges/f1/uploads?name=c.txt');
    expect(result.current.items.map((i) => i.status)).toEqual(['uploading', 'uploading']);
  });

  it('tracks progress percentage', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('a.png')]); });
    act(() => { xhrs[0]!.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 }); });
    expect(result.current.items[0]!.percent).toBe(25);
  });

  it('reports the resolved path and calls onUploaded on success', () => {
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useUploads('f1', onUploaded));
    act(() => { result.current.start([file('a.png')]); });
    act(() => {
      xhrs[0]!.status = 200;
      xhrs[0]!.responseText = JSON.stringify({ path: 'uploads/a.png' });
      xhrs[0]!.onload?.();
    });
    expect(onUploaded).toHaveBeenCalledWith('uploads/a.png');
    expect(result.current.items[0]).toMatchObject({ status: 'done', path: 'uploads/a.png' });
  });

  it('surfaces the server error message on failure', () => {
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useUploads('f1', onUploaded));
    act(() => { result.current.start([file('a.png')]); });
    act(() => {
      xhrs[0]!.status = 409;
      xhrs[0]!.responseText = JSON.stringify({ error: 'Forge is not running; start the forge first' });
      xhrs[0]!.onload?.();
    });
    expect(onUploaded).not.toHaveBeenCalled();
    expect(result.current.items[0]).toMatchObject({
      status: 'error', error: 'Forge is not running; start the forge first',
    });
  });

  it('rejects an oversize file client-side without opening a request', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('huge.bin', 200 * 1024 * 1024)]); });
    expect(xhrs).toHaveLength(0);
    expect(result.current.items[0]).toMatchObject({ status: 'error' });
    expect(result.current.items[0]!.error).toMatch(/100 MB/);
  });

  it('cancel aborts the request and marks the item errored', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('a.png')]); });
    const key = result.current.items[0]!.key;
    act(() => { result.current.cancel(key); });
    expect(result.current.items[0]).toMatchObject({ status: 'error', error: 'Cancelled' });
  });

  it('dismiss removes an item from the list', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('a.png')]); });
    const key = result.current.items[0]!.key;
    act(() => { result.current.dismiss(key); });
    expect(result.current.items).toEqual([]);
  });
});
