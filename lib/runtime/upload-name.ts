/** Per-file upload cap: 100 MB. */
export const UPLOAD_BYTE_LIMIT = 100 * 1024 * 1024;

const MAX_NAME_LEN = 255;

/** Truncate to `max` characters while keeping a short trailing extension. */
function truncateKeepingExt(name: string, max: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name.slice(0, max);
  const ext = name.slice(dot);
  if (ext.length >= max) return name.slice(0, max);
  return name.slice(0, max - ext.length) + ext;
}

/**
 * Reduce a client-supplied filename to a safe basename for /workspace/uploads/.
 *
 * This is about producing *sane* filenames, not about escaping: the name reaches
 * the container as an env var, never inside a shell command string. Leading dots
 * are stripped so an upload is never a hidden file, which also keeps the
 * container-side collision loop from producing names like `-2.env`.
 */
export function sanitizeUploadName(raw: string): string {
  // Split on both separators so a Windows client cannot smuggle a path through.
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'upload';
  return cleaned.length > MAX_NAME_LEN ? truncateKeepingExt(cleaned, MAX_NAME_LEN) : cleaned;
}
