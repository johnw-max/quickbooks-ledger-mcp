import { vi } from "vitest";

/** What both Intuit discovery documents actually return, verified 2026-08-20. */
export const INTUIT_DISCOVERY_DOCUMENT = {
  issuer: "https://oauth.platform.intuit.com/op/v1",
  authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
  token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
  userinfo_endpoint: "https://sandbox-accounts.platform.intuit.com/v1/openid_connect/userinfo",
} as const;

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function intuitTokenResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    access_token: "access-a",
    refresh_token: "refresh-a",
    expires_in: 3_600,
    x_refresh_token_expires_in: 8_640_000,
    token_type: "bearer",
    ...overrides,
  });
}

export interface IntuitOAuthStubs {
  discovery?: () => Response;
  token?: () => Response;
  revoke?: () => Response;
}

/**
 * Intuit's OAuth transport is a single injected fetch used for discovery, token
 * exchange and revocation alike, so a stub has to answer by URL rather than
 * replay one Response: a Response body can only be read once, and whichever
 * call arrived second would find it already consumed.
 *
 * Anything outside the three known endpoints rejects loudly rather than
 * returning something plausible — a test that reaches an unexpected Intuit host
 * should say so, not quietly pass.
 */
export function intuitOAuthTransport(stubs: IntuitOAuthStubs = {}): typeof fetch {
  return vi.fn((input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/.well-known/openid")) {
      return Promise.resolve(stubs.discovery?.() ?? jsonResponse(INTUIT_DISCOVERY_DOCUMENT));
    }
    if (url.includes("/tokens/bearer")) {
      return stubs.token
        ? Promise.resolve(stubs.token())
        : Promise.reject(new Error(`unexpected Intuit token request: ${url}`));
    }
    if (url.includes("/oauth2/tokens/revoke")) {
      return stubs.revoke
        ? Promise.resolve(stubs.revoke())
        : Promise.reject(new Error(`unexpected Intuit revoke request: ${url}`));
    }
    return Promise.reject(new Error(`unexpected Intuit OAuth request: ${url}`));
  }) as unknown as typeof fetch;
}

/** The calls a transport stub received for one endpoint, in order. */
export function intuitCalls(request: typeof fetch, fragment: string): unknown[][] {
  const mock = request as unknown as { mock: { calls: unknown[][] } };
  return mock.mock.calls.filter(([input]) => String(input).includes(fragment));
}
