// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { signTicket, verifyTicket } from './ws-ticket';

const SECRET = 'a'.repeat(32);

describe('ws-ticket', () => {
  it('signs and verifies a ticket', () => {
    const payload = { conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 };
    const tok = signTicket(payload, SECRET);
    expect(verifyTicket(tok, SECRET)).toEqual(payload);
  });

  it('rejects an expired ticket', () => {
    const payload = { conversationId: 'c1', userId: 'u1', exp: Date.now() - 1 };
    const tok = signTicket(payload, SECRET);
    expect(verifyTicket(tok, SECRET)).toBeNull();
  });

  it('rejects a tampered ticket', () => {
    const payload = { conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 };
    const tok = signTicket(payload, SECRET);
    // Flip a payload character.
    const [body, sig] = tok.split('.');
    const tampered = body!.slice(0, -1) + (body!.slice(-1) === 'A' ? 'B' : 'A') + '.' + sig!;
    expect(verifyTicket(tampered, SECRET)).toBeNull();
  });

  it('rejects a wrong-secret ticket', () => {
    const payload = { conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 };
    const tok = signTicket(payload, SECRET);
    expect(verifyTicket(tok, 'b'.repeat(32))).toBeNull();
  });

  it('rejects a malformed ticket', () => {
    expect(verifyTicket('garbage', SECRET)).toBeNull();
    expect(verifyTicket('only-one-part', SECRET)).toBeNull();
    expect(verifyTicket('two.parts.three', SECRET)).toBeNull();
  });
});
