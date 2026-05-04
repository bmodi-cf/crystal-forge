import { NextResponse } from 'next/server';
import { NotFoundError, ForbiddenError, ValidationError } from './errors';

export function respondToServiceError(err: unknown): NextResponse {
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message, issues: err.issues }, { status: 400 });
  }
  console.error('[respondToServiceError] unhandled error', err);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}
