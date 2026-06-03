/**
 * The origin where a running forge's dev server can be reached from the
 * Crystal Forge process. Today forges run on loopback; when they move to
 * per-forge Docker containers, this is the ONLY place that changes.
 */
export function runtimeOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}
