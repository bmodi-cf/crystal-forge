export function slugifyForgeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export function slugToDbName(slug: string): string {
  return slug.replace(/-/g, '_');
}

/** Scoped login role name for a forge database. Preserves the safe charset. */
export function dbNameToRole(dbName: string): string {
  return `${dbName}_app`;
}
