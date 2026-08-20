import { AppError } from "../errors.js";
import {
  intuitTraceId,
  QUICKBOOKS_ACCOUNTING_SCOPE,
  type QuickBooksEnvironment,
  type QuickBooksOAuthConfig,
  type QuickBooksTokenSet,
} from "./quickbooksTypes.js";

export interface QuickBooksOAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
}

/** An OAuth configuration plus the transport, so tests and harnesses can inject one. */
export interface QuickBooksOAuthTransportConfig extends QuickBooksOAuthConfig {
  request?: typeof fetch;
}

/**
 * Intuit's published OAuth 2.0 endpoints. These are the fallback, not the
 * source of truth: the discovery document is consulted first. Every value here
 * was read back from both discovery documents on 2026-08-20 and matched
 * exactly, which is what makes falling back to them safe rather than a guess.
 */
const FALLBACK_ENDPOINTS: QuickBooksOAuthEndpoints = Object.freeze({
  authorizationEndpoint: "https://appcenter.intuit.com/connect/oauth2",
  tokenEndpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocationEndpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
});

const DISCOVERY_DOCUMENT: Readonly<Record<QuickBooksEnvironment, string>> = Object.freeze({
  sandbox: "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration",
  production: "https://developer.api.intuit.com/.well-known/openid_configuration",
});

/**
 * A day. The endpoints have not moved in the lifetime of OAuth 2.0 at Intuit,
 * so re-reading them per authorization would buy nothing and would put a
 * network round trip in front of a user-facing redirect. A day still means a
 * long-running server picks up an endpoint change without a redeploy, which is
 * the whole point of reading discovery rather than hardcoding.
 */
const DISCOVERY_TTL_MS = 24 * 60 * 60_000;

/**
 * A discovery outage must cost one fetch every five minutes, not one fetch per
 * authorization: the fallback is cached under the same key so an outage is
 * served from memory, and five minutes is short enough that recovery is picked
 * up promptly.
 */
const DISCOVERY_FALLBACK_TTL_MS = 5 * 60_000;

/**
 * Shorter than the token timeout on purpose. Discovery sits in front of a
 * browser redirect and has a correct answer to fall back on, so waiting on it
 * is never worth more than a few seconds.
 */
const DISCOVERY_TIMEOUT_MS = 5_000;

const discoveryCache = new Map<QuickBooksEnvironment, {
  endpoints: QuickBooksOAuthEndpoints;
  expiresAt: number;
}>();

/**
 * The cache is process-global, so a test that stubs discovery has to start from
 * an empty one. This is the only reason it exists; runtime code never clears it.
 */
export function resetQuickBooksOAuthDiscovery(): void {
  discoveryCache.clear();
}

/**
 * The authorization endpoint becomes a browser redirect target and the token
 * and revocation endpoints receive our client secret over HTTP Basic. A
 * discovery document that has been tampered with or mis-served must therefore
 * never be able to point any of them somewhere else: anything that is not an
 * https Intuit host is refused here and the published constant is used instead.
 */
function intuitEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
  const host = url.hostname.toLowerCase();
  if (host !== "intuit.com" && !host.endsWith(".intuit.com")) return undefined;
  return url.toString();
}

async function readDiscoveryDocument(
  environment: QuickBooksEnvironment,
  request: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await request(DISCOVERY_DOCUMENT[environment], {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`QuickBooks discovery responded with HTTP ${response.status}.`);
  const document = await response.json() as unknown;
  if (!document || typeof document !== "object") {
    throw new Error("QuickBooks discovery did not return a document object.");
  }
  return document as Record<string, unknown>;
}

/**
 * Resolves Intuit's OAuth endpoints from the discovery document for the
 * configured environment, per field, falling back to the published constants
 * for anything discovery does not supply or supplies unusably.
 *
 * A discovery failure is not an error. Authorization, token exchange and
 * revocation all have a correct endpoint without it, so failing here would
 * take down the flow it is meant to keep current.
 */
export async function quickBooksOAuthEndpoints(
  config: QuickBooksOAuthTransportConfig,
): Promise<QuickBooksOAuthEndpoints> {
  const now = Date.now();
  const cached = discoveryCache.get(config.environment);
  if (cached && cached.expiresAt > now) return cached.endpoints;

  let endpoints = FALLBACK_ENDPOINTS;
  let ttl = DISCOVERY_FALLBACK_TTL_MS;
  try {
    const document = await readDiscoveryDocument(config.environment, config.request ?? fetch);
    endpoints = {
      authorizationEndpoint: intuitEndpoint(document.authorization_endpoint) ??
        FALLBACK_ENDPOINTS.authorizationEndpoint,
      tokenEndpoint: intuitEndpoint(document.token_endpoint) ?? FALLBACK_ENDPOINTS.tokenEndpoint,
      revocationEndpoint: intuitEndpoint(document.revocation_endpoint) ??
        FALLBACK_ENDPOINTS.revocationEndpoint,
    };
    ttl = DISCOVERY_TTL_MS;
  } catch {
    // Intentionally silent and non-fatal: the caller gets the published
    // endpoints, which is the correct answer, just not a freshly confirmed one.
  }
  discoveryCache.set(config.environment, { endpoints, expiresAt: now + ttl });
  return endpoints;
}

interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  x_refresh_token_expires_in?: unknown;
  token_type?: unknown;
}
function parsePositiveSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new AppError("PROVIDER_ERROR", `QuickBooks OAuth did not return a valid ${field}.`, {
      httpStatus: 502,
    });
  }
  return value;
}

function parseTokenSet(value: OAuthTokenResponse, now: Date): QuickBooksTokenSet {
  if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string") {
    throw new AppError("PROVIDER_ERROR", "QuickBooks OAuth returned an incomplete token set.", {
      httpStatus: 502,
    });
  }
  const accessSeconds = parsePositiveSeconds(value.expires_in, "access-token lifetime");
  const refreshSeconds = parsePositiveSeconds(value.x_refresh_token_expires_in, "refresh-token lifetime");
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    accessTokenExpiresAt: new Date(now.getTime() + accessSeconds * 1_000),
    refreshTokenExpiresAt: new Date(now.getTime() + refreshSeconds * 1_000),
    tokenType: typeof value.token_type === "string" ? value.token_type : "bearer",
  };
}

function clientAuthorization(config: QuickBooksOAuthConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")}`;
}

async function tokenRequest(
  config: QuickBooksOAuthConfig,
  body: URLSearchParams,
  request: typeof fetch,
  now: Date,
): Promise<QuickBooksTokenSet> {
  const endpoints = await quickBooksOAuthEndpoints({ ...config, request });
  let response: Response;
  try {
    response = await request(endpoints.tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: clientAuthorization(config),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AppError("PROVIDER_UNAVAILABLE", "QuickBooks OAuth could not be reached.", {
      httpStatus: 503,
      retryable: true,
      cause: error,
    });
  }

  let decoded: OAuthTokenResponse = {};
  try {
    decoded = await response.json() as OAuthTokenResponse;
  } catch {
    // A safe provider error below is preferable to returning the upstream HTML body.
  }
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new AppError("NOT_CONNECTED", "QuickBooks OAuth rejected the authorization grant; reconnection is required.", {
        httpStatus: 409,
      });
    }
    if (response.status === 403) {
      throw new AppError("FORBIDDEN", "QuickBooks OAuth denied this application or accounting scope.", {
        httpStatus: 403,
      });
    }
    if (response.status === 429) {
      throw new AppError("RATE_LIMITED", "QuickBooks OAuth temporarily rate-limited the request.", {
        httpStatus: 429,
        retryable: true,
      });
    }
    if (response.status >= 500) {
      throw new AppError("PROVIDER_UNAVAILABLE", "QuickBooks OAuth is temporarily unavailable.", {
        httpStatus: 503,
        retryable: true,
      });
    }
    throw new AppError("PROVIDER_ERROR", "QuickBooks OAuth rejected the authorization request.", {
      httpStatus: 502,
    });
  }
  return parseTokenSet(decoded, now);
}

export async function buildQuickBooksAuthorizationUrl(
  config: QuickBooksOAuthTransportConfig,
  state: string,
): Promise<string> {
  if (!state || state.length < 32) {
    throw new AppError("CONFIGURATION_ERROR", "QuickBooks OAuth state must contain at least 32 characters.", {
      httpStatus: 500,
    });
  }
  const endpoints = await quickBooksOAuthEndpoints(config);
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QUICKBOOKS_ACCOUNTING_SCOPE);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeQuickBooksAuthorizationCode(options: {
  config: QuickBooksOAuthTransportConfig;
  code: string;
  request?: typeof fetch;
  now?: Date;
}): Promise<QuickBooksTokenSet> {
  if (!options.code) {
    throw new AppError("AUTH_REQUIRED", "QuickBooks OAuth callback did not include an authorization code.", {
      httpStatus: 401,
    });
  }
  return tokenRequest(
    options.config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.config.redirectUri,
    }),
    options.request ?? options.config.request ?? fetch,
    options.now ?? new Date(),
  );
}

export async function refreshQuickBooksToken(options: {
  config: QuickBooksOAuthTransportConfig;
  refreshToken: string;
  request?: typeof fetch;
  now?: Date;
}): Promise<QuickBooksTokenSet> {
  if (!options.refreshToken) {
    throw new AppError("NOT_CONNECTED", "QuickBooks refresh credentials are missing; reconnection is required.", {
      httpStatus: 409,
    });
  }
  return tokenRequest(
    options.config,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
    }),
    options.request ?? options.config.request ?? fetch,
    options.now ?? new Date(),
  );
}

/**
 * What Intuit's ledger of grants says after we asked it to drop one.
 *
 * REVOKED is Intuit confirming it dropped the grant. ALREADY_INVALID is Intuit
 * refusing the token as one it does not hold — which reaches the same end
 * state, no live grant, and so is a successful disconnect, but it is a
 * different fact and is reported as one rather than being flattened into
 * "revoked". Anything else is an error and the grant must be assumed live.
 */
export type QuickBooksProviderRevocation = "REVOKED" | "ALREADY_INVALID";

export interface QuickBooksRevocationResult {
  outcome: QuickBooksProviderRevocation;
  intuitTid?: string;
}

/**
 * Revokes one Intuit grant. Intuit's revoke deviates from RFC 7009: it takes a
 * JSON body rather than a form, and answers 400 for a token it does not
 * recognise instead of the RFC's 200. Passing the refresh token drops the whole
 * grant, which is what a customer disconnecting means; passing an access token
 * would leave the refresh token live.
 *
 * Every non-success outcome throws, because the caller's next act is to record
 * locally that the customer is disconnected, and it may only do that once
 * Intuit has said the grant is gone.
 */
export async function revokeQuickBooksToken(options: {
  config: QuickBooksOAuthTransportConfig;
  refreshToken: string;
  request?: typeof fetch;
}): Promise<QuickBooksRevocationResult> {
  if (!options.refreshToken) {
    throw new AppError("NOT_CONNECTED", "QuickBooks refresh credentials are missing; there is no Intuit grant to revoke.", {
      httpStatus: 409,
    });
  }
  const request = options.request ?? options.config.request ?? fetch;
  const endpoints = await quickBooksOAuthEndpoints({ ...options.config, request });

  let response: Response;
  try {
    response = await request(endpoints.revocationEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: clientAuthorization(options.config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: options.refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AppError("PROVIDER_UNAVAILABLE", "QuickBooks token revocation could not be reached; the Intuit grant must be assumed live.", {
      httpStatus: 503,
      retryable: true,
      cause: error,
    });
  }

  const intuitTid = intuitTraceId(response.headers);
  const trace = intuitTid ? { intuitTid } : {};
  if (response.ok) return { outcome: "REVOKED", ...trace };
  if (response.status === 400) {
    // The request shape is fixed by this function and exercised by every
    // revoke, so a 400 can only be about the one variable part: the token.
    // Intuit does not hold it, so the customer has no live grant either way.
    return { outcome: "ALREADY_INVALID", ...trace };
  }
  if (response.status === 401) {
    throw new AppError("CONFIGURATION_ERROR", "Intuit rejected this application's credentials at the revocation endpoint; the customer's grant was not revoked.", {
      httpStatus: 500,
      details: { failureLayer: "PROVIDER_AUTHORIZATION", ...trace },
    });
  }
  if (response.status === 429) {
    throw new AppError("RATE_LIMITED", "Intuit temporarily rate-limited the revocation request; the grant is still live.", {
      httpStatus: 429,
      retryable: true,
      details: trace,
    });
  }
  if (response.status >= 500) {
    throw new AppError("PROVIDER_UNAVAILABLE", "Intuit could not process the revocation request; the grant must be assumed live.", {
      httpStatus: 503,
      retryable: true,
      details: trace,
    });
  }
  throw new AppError("PROVIDER_ERROR", "Intuit refused the revocation request; the grant must be assumed live.", {
    httpStatus: 502,
    details: { providerHttpStatus: response.status, ...trace },
  });
}
