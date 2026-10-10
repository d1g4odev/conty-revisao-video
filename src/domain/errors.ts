export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "DURATION_REQUIRED"
  | "COMMENT_OUT_OF_RANGE"
  | "VERSION_NOT_CURRENT"
  | "DELIVERY_ALREADY_APPROVED"
  | "DELIVERY_NOT_APPROVABLE";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  DURATION_REQUIRED: 422,
  COMMENT_OUT_OF_RANGE: 422,
  VERSION_NOT_CURRENT: 409,
  DELIVERY_ALREADY_APPROVED: 409,
  DELIVERY_NOT_APPROVABLE: 409,
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const notFound = (entity: string, id: string): DomainError =>
  new DomainError("NOT_FOUND", `${entity} ${id} not found`, { entity, id });
