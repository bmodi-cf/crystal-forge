'use client';
import { useCallback, useRef, useState } from 'react';
import { UPLOAD_BYTE_LIMIT } from '@/lib/runtime/upload-name';

export type UploadItem = {
  key: number;
  name: string;
  percent: number;
  status: 'uploading' | 'done' | 'error';
  path?: string;
  error?: string;
};

export type UploadsApi = {
  items: UploadItem[];
  start: (files: File[]) => void;
  cancel: (key: number) => void;
  dismiss: (key: number) => void;
};

/** Milliseconds a completed line lingers before it clears itself. */
const DONE_LINGER_MS = 5_000;

/**
 * Upload files to a forge's workspace, one request per file.
 *
 * XMLHttpRequest rather than fetch: xhr.upload.onprogress is the only broadly
 * reliable upload-progress signal, and at a 100 MB cap a silent minute would
 * read as a hang.
 */
export function useUploads(forgeId: string, onUploaded: (path: string) => void): UploadsApi {
  const [items, setItems] = useState<UploadItem[]>([]);
  const nextKey = useRef(1);
  const xhrs = useRef(new Map<number, XMLHttpRequest>());

  const patch = useCallback((key: number, fields: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...fields } : it)));
  }, []);

  const dismiss = useCallback((key: number) => {
    xhrs.current.delete(key);
    setItems((prev) => prev.filter((it) => it.key !== key));
  }, []);

  const start = useCallback((files: File[]) => {
    for (const f of files) {
      const key = nextKey.current++;
      setItems((prev) => [...prev, { key, name: f.name, percent: 0, status: 'uploading' }]);

      if (f.size > UPLOAD_BYTE_LIMIT) {
        patch(key, { status: 'error', error: `${f.name} is larger than the 100 MB limit` });
        continue;
      }

      const xhr = new XMLHttpRequest();
      xhrs.current.set(key, xhr);
      xhr.open('POST', `/api/forges/${forgeId}/uploads?name=${encodeURIComponent(f.name)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          patch(key, { percent: Math.round((e.loaded / e.total) * 100) });
        }
      };
      xhr.onload = () => {
        xhrs.current.delete(key);
        let parsed: { path?: string; error?: string } = {};
        try { parsed = JSON.parse(xhr.responseText) as typeof parsed; } catch { /* non-JSON */ }
        if (xhr.status === 200 && parsed.path) {
          patch(key, { status: 'done', percent: 100, path: parsed.path });
          onUploaded(parsed.path);
          setTimeout(() => dismiss(key), DONE_LINGER_MS);
        } else {
          patch(key, { status: 'error', error: parsed.error ?? `Upload failed (${xhr.status})` });
        }
      };
      xhr.onerror = () => {
        xhrs.current.delete(key);
        patch(key, { status: 'error', error: 'Network error' });
      };
      xhr.onabort = () => {
        xhrs.current.delete(key);
        patch(key, { status: 'error', error: 'Cancelled' });
      };
      xhr.send(f);
    }
  }, [forgeId, onUploaded, patch, dismiss]);

  const cancel = useCallback((key: number) => {
    const xhr = xhrs.current.get(key);
    if (xhr) xhr.abort();
    else patch(key, { status: 'error', error: 'Cancelled' });
  }, [patch]);

  return { items, start, cancel, dismiss };
}
