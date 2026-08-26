import { NextResponse } from 'next/server';
import {
  NotFoundError, ForbiddenError, ValidationError,
  RuntimeBusyError, RuntimeCapacityError, PayloadTooLargeError,
} from './errors';

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
  if (err instanceof RuntimeBusyError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof RuntimeCapacityError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  if (err instanceof PayloadTooLargeError) {
    return NextResponse.json({ error: err.message }, { status: 413 });
  }
  console.error('[respondToServiceError] unhandled error', err);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}
