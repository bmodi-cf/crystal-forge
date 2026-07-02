export type BumpLevel = 'major' | 'minor' | 'patch';

const RE = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(
  v: string,
): { major: number; minor: number; patch: number } | null {
  const m = RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function nextVersion(current: string | null, bump: BumpLevel): string {
  const parsed = current ? parseVersion(current) : null;
  if (!parsed) return 'v1.0.0';
  if (bump === 'major') return `v${parsed.major + 1}.0.0`;
  if (bump === 'minor') return `v${parsed.major}.${parsed.minor + 1}.0`;
  return `v${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return (
    pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch
  );
}
