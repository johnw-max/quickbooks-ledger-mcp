import { AppError } from "../errors.js";
import {
  QUICKBOOKS_ACCOUNTING_SCOPE,
  type QuickBooksOAuthConfig,
  type QuickBooksTokenSet,
} from "./quickbooksTypes.js";

const AUTHORIZE_ENDPOINT = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

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
  let response: Response;
  try {
    response = await request(TOKEN_ENDPOINT, {
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
    throw new AppError("PROVIDER_ERROR", "QuickBooks OAuth could not be reached.", {
      httpStatus: 502,
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
    throw new AppError(
      response.status === 400 || response.status === 401 ? "NOT_CONNECTED" : "PROVIDER_ERROR",
      "QuickBooks OAuth rejected the authorization request; reconnection is required.",
      { httpStatus: response.status === 400 || response.status === 401 ? 409 : 502 },
    );
  }
  return parseTokenSet(decoded, now);
}

export function buildQuickBooksAuthorizationUrl(
  config: QuickBooksOAuthConfig,
  state: string,
): string {
  if (!state || state.length < 32) {
    throw new AppError("CONFIGURATION_ERROR", "QuickBooks OAuth state must contain at least 32 characters.", {
      httpStatus: 500,
    });
  }
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QUICKBOOKS_ACCOUNTING_SCOPE);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeQuickBooksAuthorizationCode(options: {
  config: QuickBooksOAuthConfig;
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
    options.request ?? fetch,
    options.now ?? new Date(),
  );
}

export async function refreshQuickBooksToken(options: {
  config: QuickBooksOAuthConfig;
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
    options.request ?? fetch,
    options.now ?? new Date(),
  );
}
