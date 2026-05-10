export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'RUNTIME_BUSY'
  | 'RUNTIME_CAPACITY';

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} ${id} not found`);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super('FORBIDDEN', message);
  }
}

export class ValidationError extends AppError {
  readonly issues: Record<string, string[]>;

  constructor(message: string, issues: Record<string, string[]>) {
    super('VALIDATION', message);
    this.issues = issues;
  }
}

export class RuntimeBusyError extends AppError {
  constructor(message: string) {
    super('RUNTIME_BUSY', message);
  }
}

export class RuntimeCapacityError extends AppError {
  constructor(message = 'No free runtime port; stop another forge first') {
    super('RUNTIME_CAPACITY', message);
  }
}
