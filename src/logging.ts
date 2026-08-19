export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const order = { debug: 10, info: 20, warn: 30, error: 40 } as const;

const safeContextKeys = new Set([
  "actorId",
  "auditCompletionStatus",
  "batches",
  "callId",
  "cleanupStatus",
  "deletedConnectTickets",
  "deletedOAuthStates",
  "deletedOperatorSessions",
  "deletedReviewCsrfTokens",
  "durationMs",
  "errorClass",
  "errorCode",
  // Why a token rejection was refused, and a purpose-salted digest of which
  // token. Neither is the value or the repository lookup hash. Without these on
  // the allowlist an operator sees "[REDACTED]" for both — and no test catches
  // it, because tests inject a mock logger that never redacts.
  "rejectionReason",
  "tokenIdHash",
  "host",
  "method",
  "originalErrorCode",
  "oauthStage",
  "path",
  "port",
  "recordId",
  "requestId",
  "resultStatus",
  "state",
  "tenantId",
  "toolName",
]);

function scrubMessage(message: string): string {
  return message
    .replace(/\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*\b/gi, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:code|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b(access_token|refresh_token|client_secret)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]");
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return scrubMessage(value);
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        !safeContextKeys.has(key) ? "[REDACTED]" : redact(child),
      ]),
    );
  }
  return value;
}

export function createLogger(config: { logLevel: keyof typeof order }): Logger {
  const threshold = order[config.logLevel];
  const write = (level: keyof typeof order, message: string, context?: Record<string, unknown>) => {
    if (order[level] < threshold) return;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      message: scrubMessage(message),
      ...(context ? { context: redact(context) } : {}),
    };
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
