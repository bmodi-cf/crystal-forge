// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NotFoundError, ForbiddenError, ValidationError, AppError } from './errors';

describe('error classes', () => {
  it('NotFoundError extends AppError with code', () => {
    const e = new NotFoundError('forge', 'abc');
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toContain('forge');
    expect(e.message).toContain('abc');
  });

  it('ForbiddenError carries code FORBIDDEN', () => {
    const e = new ForbiddenError('Cannot edit forge owned by someone else');
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toBe('Cannot edit forge owned by someone else');
  });

  it('ValidationError carries code VALIDATION and field issues', () => {
    const e = new ValidationError('Invalid input', { name: ['Required'] });
    expect(e.code).toBe('VALIDATION');
    expect(e.issues).toEqual({ name: ['Required'] });
  });
});

describe('runtime error classes', () => {
  it('RuntimeBusyError carries name + message', async () => {
    const { RuntimeBusyError } = await import('./errors');
    const e = new RuntimeBusyError('x');
    expect(e.name).toBe('RuntimeBusyError');
    expect(e.message).toBe('x');
    expect(e.code).toBe('RUNTIME_BUSY');
  });

  it('RuntimeCapacityError carries name + message', async () => {
    const { RuntimeCapacityError } = await import('./errors');
    const e = new RuntimeCapacityError('x');
    expect(e.name).toBe('RuntimeCapacityError');
    expect(e.code).toBe('RUNTIME_CAPACITY');
  });
});
