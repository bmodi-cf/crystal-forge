export type ErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'VALIDATION';

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
