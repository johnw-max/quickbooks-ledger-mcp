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

/**
 * A schema failure is deterministic: the same input fails the same way forever.
 * Reporting it as an upstream provider fault names the wrong layer and, worse,
 * marks it retryable — which invites a caller to retry an input that can never
 * succeed, and hides the real cause behind a transient-looking error. Classify
 * it as the deterministic validation failure it is.
 */
function isSchemaValidationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; issues?: unknown };
  return candidate.name === "ZodError" && Array.isArray(candidate.issues);
}

/**
 * A caller that is told only "something is invalid" cannot correct itself; it
 * can only guess, and an Agent guessing at a document shape burns turns while
 * the ledger stays empty. The field paths are the caller's own request
 * structure, so naming them leaks nothing the caller did not send. Values and
 * Zod messages stay out: those can echo document contents back into a
 * conversation transcript.
 */
function invalidRequestFields(error: unknown): string[] {
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const fields = new Set<string>();
  for (const issue of issues) {
    const path = (issue as { path?: unknown }).path;
    if (!Array.isArray(path) || path.length === 0) continue;
    let rendered = "";
    let renderable = true;
    for (const segment of path) {
      if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
        rendered += `[${segment}]`;
      } else if (typeof segment === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(segment)) {
        rendered += rendered === "" ? segment : `.${segment}`;
      } else {
        renderable = false;
        break;
      }
    }
    if (renderable && rendered.length > 0 && rendered.length <= 128) fields.add(rendered);
    if (fields.size >= 16) break;
  }
  return [...fields];
}

export function toSafeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (isSchemaValidationError(error)) {
    const invalidFields = invalidRequestFields(error);
    return new AppError("VALIDATION_FAILED", "The accounting request failed deterministic validation.", {
      httpStatus: 422,
      retryable: false,
      details: {
        reasonCodes: ["REQUEST_SCHEMA_INVALID"],
        providerMutationPossible: false,
        ...(invalidFields.length > 0 ? { invalidFields } : {}),
      },
      cause: error,
    });
  }

  return new AppError("PROVIDER_ERROR", "The upstream accounting request failed.", {
    httpStatus: 502,
    retryable: true,
    cause: error,
  });
}
