import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { loadForgeAcl } from '@/lib/services/runtime';
import { loadState } from '@/lib/runtime/state';
import { handlePreviewProxy } from '@/lib/runtime/preview-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Fallback explicit type used because RouteContext<'/app/[slug]/[[...path]]'>
// is not yet generated (the .next/types build predates this route file).
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  const { slug } = await ctx.params;
  return handlePreviewProxy(req, slug, {
    // Wrap auth() in an arrow — NextAuth's `auth` is overloaded and won't
    // assign cleanly to the plain `() => Promise<...>` dep type.
    getSession: () => auth(),
    loadState,
    loadForgeAcl,
    fetch,
  });
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
