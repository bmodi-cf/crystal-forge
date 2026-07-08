import { NextResponse } from 'next/server';

/**
 * True when the dashboard runs in production mode. Read from process.env at
 * call time (not the parsed env snapshot) so it is test-settable, mirroring
 * how promotions.ts reads process.env.REGISTRY_HOST.
 */
export function isProdMode(): boolean {
  return process.env.FORGE_DASHBOARD_MODE === 'prod';
}

/**
 * Guard for edit-mode route handlers: returns a 404 response in prod mode so
 * the route is inert, else null (caller proceeds). Usage:
 *   const g = devOnlyRouteGuard(); if (g) return g;
 */
export function devOnlyRouteGuard(): NextResponse | null {
  return isProdMode() ? NextResponse.json({ error: 'Not found' }, { status: 404 }) : null;
}
