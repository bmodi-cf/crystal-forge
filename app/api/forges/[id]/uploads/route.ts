import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { respondToServiceError } from '@/lib/http';
import { devOnlyRouteGuard } from '@/lib/mode';
import { UPLOAD_BYTE_LIMIT } from '@/lib/runtime/upload-name';
import { getRuntimeService } from '@/lib/services/runtime';

/**
 * Stream a file into the forge's checkout at /workspace/uploads/.
 *
 * The body is raw bytes with the filename in ?name= — deliberately not
 * multipart, because request.formData() would buffer the whole file (cap:
 * 100 MB) in the dashboard's heap. One file per request; the client fires
 * several in parallel for a multi-file drop.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/uploads'>,
) {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;

  const name = new URL(req.url).searchParams.get('name');
  if (!name) return NextResponse.json({ error: 'Missing name parameter' }, { status: 400 });

  // Cheap pre-check so an honestly-declared oversize upload is refused before
  // any container work. The service is the authoritative enforcer.
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > UPLOAD_BYTE_LIMIT) {
    return NextResponse.json({ error: 'File exceeds the 100 MB limit' }, { status: 413 });
  }
  if (!req.body) return NextResponse.json({ error: 'Missing body' }, { status: 400 });

  const body = Readable.fromWeb(req.body as unknown as NodeWebReadableStream);
  // A cancelled upload kills the docker exec, whose trap sweeps the .part file.
  req.signal.addEventListener('abort', () => body.destroy(new Error('client aborted upload')));

  try {
    const { path } = await getRuntimeService().uploadToWorkspace(session.user, id, name, body);
    return NextResponse.json({ path });
  } catch (err) {
    return respondToServiceError(err);
  }
}
