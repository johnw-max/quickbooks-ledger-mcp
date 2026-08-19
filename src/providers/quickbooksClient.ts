import { AppError } from "../errors.js";
import { classifyQuickBooksProviderWriteFailure } from "./quickbooksWriteOutcome.js";
import type {
  QuickBooksEnvironment,
  QuickBooksQueryResponse,
  QuickBooksTokenSource,
} from "./quickbooksTypes.js";

interface QuickBooksFaultError {
  Message?: unknown;
  Detail?: unknown;
  code?: unknown;
  element?: unknown;
}

interface QuickBooksFaultBody {
  Fault?: { Error?: QuickBooksFaultError[]; type?: unknown };
  time?: unknown;
}

export interface QuickBooksClientOptions {
  realmId: string;
  environment: QuickBooksEnvironment;
  tokenSource: QuickBooksTokenSource;
  request?: typeof fetch;
  minorVersion?: number;
  timeoutMs?: number;
}

export interface QuickBooksRequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  requestId?: string;
  isWrite?: boolean;
  multipart?: FormData;
}

function baseUrl(environment: QuickBooksEnvironment, realmId: string): string {
  const host = environment === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
  return `${host}/v3/company/${encodeURIComponent(realmId)}`;
}

function safeFaultDetails(body: QuickBooksFaultBody): Record<string, unknown> | undefined {
  const errors = body.Fault?.Error;
  if (!errors?.length) return undefined;
  return {
    providerErrors: errors.slice(0, 5).map((error) => ({
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.element === "string" ? { element: error.element } : {}),
    })),
  };
}

/**
 * Every error built here comes from a Provider HTTP response that was received
 * and parsed: the request reached the far side, it answered, and the answer
 * carried a status. This is the only place in the client that observes that, so
 * this is where the write outcome is decided and stamped as evidence for the
 * durable ledger. Transport failures, aborts and timeouts never reach this
 * function and are never anything but UNKNOWN.
 *
 * The evidence is deliberately independent of the AppError code. VALIDATION_-
 * FAILED, NOT_FOUND and FORBIDDEN are all raised locally as well, so a caller
 * that keyed on the code would eventually call a local failure a Provider
 * refusal.
 */
function errorForResponse(
  status: number,
  body: QuickBooksFaultBody,
  options: QuickBooksRequestOptions,
): AppError {
  const faultRecognised = Array.isArray(body.Fault?.Error) && body.Fault.Error.length > 0;
  const details = {
    ...safeFaultDetails(body),
    providerResponseCompleted: true,
    providerHttpStatus: status,
    providerFaultRecognised: faultRecognised,
    ...(options.isWrite ? {
      providerWriteOutcome: classifyQuickBooksProviderWriteFailure({
        responseCompleted: true,
        httpStatus: status,
        faultRecognised,
        uploadEndpoint: options.multipart !== undefined,
      }),
    } : {}),
  };
  if (status === 401) {
    return new AppError("NOT_CONNECTED", "QuickBooks authorization is no longer valid; reconnection is required.", {
      httpStatus: 409,
      details,
    });
  }
  if (status === 403) {
    return new AppError("FORBIDDEN", "QuickBooks denied access to this company or accounting capability.", {
      httpStatus: 403,
      details,
    });
  }
  if (status === 404) {
    return new AppError("NOT_FOUND", "The requested QuickBooks record was not found.", {
      httpStatus: 404,
      details,
    });
  }
  if (status === 400) {
    return new AppError("VALIDATION_FAILED", "QuickBooks rejected the accounting request.", {
      httpStatus: 400,
      details,
    });
  }
  if (status === 409) {
    return new AppError("CONFLICT", "QuickBooks rejected the request because the record changed.", {
      httpStatus: 409,
      details,
    });
  }
  if (status === 429) {
    return new AppError("RATE_LIMITED", "QuickBooks temporarily rate-limited the accounting request.", {
      httpStatus: 429,
      retryable: true,
      details,
    });
  }
  if (status >= 500) {
    return new AppError("PROVIDER_UNAVAILABLE", "QuickBooks is temporarily unavailable.", {
      httpStatus: 503,
      retryable: true,
      details,
    });
  }
  return new AppError("PROVIDER_ERROR", "QuickBooks could not complete the accounting request.", {
    httpStatus: 502,
    retryable: status === 429 || status >= 500,
    details,
  });
}

export class QuickBooksApiClient {
  readonly realmId: string;
  readonly #root: string;
  readonly #tokenSource: QuickBooksTokenSource;
  readonly #request: typeof fetch;
  readonly #minorVersion: number | undefined;
  readonly #timeoutMs: number;

  constructor(options: QuickBooksClientOptions) {
    if (!/^\d{3,32}$/.test(options.realmId)) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks realmId must be a numeric company identifier.", {
        httpStatus: 500,
      });
    }
    this.realmId = options.realmId;
    this.#root = baseUrl(options.environment, options.realmId);
    this.#tokenSource = options.tokenSource;
    this.#request = options.request ?? fetch;
    this.#minorVersion = options.minorVersion;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async query<T extends Record<string, unknown>>(query: string): Promise<QuickBooksQueryResponse<T>> {
    return this.request<QuickBooksQueryResponse<T>>("/query", { query: { query } });
  }

  async request<T>(path: string, options: QuickBooksRequestOptions = {}): Promise<T> {
    const accessToken = await this.#tokenSource.accessToken();
    const first = await this.#send<T>(path, options, accessToken);
    if (first.kind === "success") return first.value;
    if (first.status !== 401) throw errorForResponse(first.status, first.body, options);

    const refreshedAccessToken = await this.#tokenSource.refreshAccessToken();
    const second = await this.#send<T>(path, options, refreshedAccessToken);
    if (second.kind === "success") return second.value;
    throw errorForResponse(second.status, second.body, options);
  }

  async #send<T>(
    path: string,
    options: QuickBooksRequestOptions,
    accessToken: string,
  ): Promise<
    | { kind: "success"; value: T }
    | { kind: "error"; status: number; body: QuickBooksFaultBody }
  > {
    const url = new URL(`${this.#root}${path}`);
    if (this.#minorVersion !== undefined) url.searchParams.set("minorversion", String(this.#minorVersion));
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (options.requestId) url.searchParams.set("requestid", options.requestId);

    let response: Response;
    try {
      response = await this.#request(url, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(options.body === undefined || options.multipart ? {} : { "Content-Type": "application/json" }),
        },
        ...(options.multipart
          ? { body: options.multipart }
          : options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (options.isWrite) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks write result is unknown; automatic retry is forbidden until the durable execution attempt is resolved.", {
          httpStatus: 502,
          retryable: false,
          details: {
            requestId: options.requestId ?? "missing",
            // No response cycle completed, so nothing is known about Intuit's
            // ledger. Stated rather than left absent, so the durable layer
            // reads one vocabulary everywhere.
            providerWriteOutcome: "UNKNOWN",
            providerMutationPossible: true,
            automaticRearmAllowed: false,
          },
          cause: error,
        });
      }
      throw new AppError("PROVIDER_UNAVAILABLE", "QuickBooks could not be reached.", {
        httpStatus: 503,
        retryable: true,
        cause: error,
      });
    }

    let body: unknown = {};
    try {
      body = await response.json() as unknown;
    } catch {
      // Do not expose upstream HTML or proxy bodies.
    }
    if (response.ok) return { kind: "success", value: body as T };
    if (options.isWrite && response.status >= 500) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks write result is unknown; automatic retry is forbidden until the durable execution attempt is resolved.", {
        httpStatus: 502,
        retryable: false,
        details: {
          requestId: options.requestId ?? "missing",
          providerStatus: response.status,
          // Intuit answered, but a 5xx can follow a write that was applied.
          providerWriteOutcome: "UNKNOWN",
          providerMutationPossible: true,
          automaticRearmAllowed: false,
        },
      });
    }
    return { kind: "error", status: response.status, body: body as QuickBooksFaultBody };
  }
}
