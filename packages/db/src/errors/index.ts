/**
 * Database Error Classes
 *
 * Custom error classes for database operations.
 * Use instanceof checks instead of fragile string matching.
 */

/**
 * Base error class for database errors.
 */
export abstract class DatabaseError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Error thrown when a record is not found.
 */
export class NotFoundError extends DatabaseError {
  readonly code = "NOT_FOUND" as const;

  constructor(message = "Record not found") {
    super(message);
  }
}

/**
 * Error thrown when attempting to create a duplicate record.
 */
export class DuplicateError extends DatabaseError {
  readonly code = "DUPLICATE" as const;

  constructor(message = "Record already exists") {
    super(message);
  }
}

/**
 * Error thrown when a database operation fails.
 */
export class DatabaseOperationError extends DatabaseError {
  readonly code = "DATABASE_OPERATION_FAILED" as const;

  constructor(message = "Database operation failed") {
    super(message);
  }
}
