export function slugifyForgeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export function slugToDbName(slug: string): string {
  return slug.replace(/-/g, '_');
}
