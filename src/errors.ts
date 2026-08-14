export type AppErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NOT_CONNECTED"
  | "AMBIGUOUS_CONNECTION"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "READBACK_MISMATCH"
  | "WRITE_RESULT_UNKNOWN"
  | "WRITE_RESULT_UNKNOWN_NO_ID"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "CONFIGURATION_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: AppErrorCode,
    message: string,
    options: {
      httpStatus?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toSafeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("PROVIDER_ERROR", "The upstream accounting request failed.", {
    httpStatus: 502,
    retryable: true,
    cause: error,
  });
}
