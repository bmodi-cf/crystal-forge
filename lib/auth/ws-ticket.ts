import { createHmac, timingSafeEqual } from 'node:crypto';

export type TicketPayload = {
  conversationId: string;
  userId: string;
  exp: number; // ms epoch
};

export function signTicket(payload: TicketPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyTicket(token: string, secret: string): TicketPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest();
  let actual: Buffer;
  try { actual = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketPayload;
  } catch { return null; }
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
  if (typeof payload.conversationId !== 'string' || typeof payload.userId !== 'string') return null;
  return payload;
}
