export function slugifyForgeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}
