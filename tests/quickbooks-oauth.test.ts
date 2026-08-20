import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildQuickBooksAuthorizationUrl,
  exchangeQuickBooksAuthorizationCode,
  quickBooksOAuthEndpoints,
  refreshQuickBooksToken,
  resetQuickBooksOAuthDiscovery,
  revokeQuickBooksToken,
} from "../src/providers/quickbooksOAuth.js";
import {
  INTUIT_DISCOVERY_DOCUMENT,
  intuitCalls,
  intuitOAuthTransport,
  intuitTokenResponse,
  jsonResponse,
} from "./helpers/intuitOAuthTransport.js";

const config = {
  clientId: "qbo-client",
  clientSecret: "qbo-secret",
  redirectUri: "https://agent2.zcloak.ai/oauth/quickbooks/callback",
  environment: "sandbox" as const,
};

const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_ENDPOINT = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

/** The discovery cache is process-global, so every test starts from an empty one. */
beforeEach(() => {
  resetQuickBooksOAuthDiscovery();
});

describe("QuickBooks OAuth", () => {
  it("builds the official accounting-scope authorization URL with exact state and redirect", async () => {
    const state = "s".repeat(32);
    const url = new URL(await buildQuickBooksAuthorizationUrl(
      { ...config, request: intuitOAuthTransport() },
      state,
    ));

    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(url.searchParams.get("client_id")).toBe("qbo-client");
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("exchanges a code and retains both Intuit token expiries", async () => {
    const request = intuitOAuthTransport({ token: () => intuitTokenResponse() });
    const now = new Date("2026-08-05T00:00:00.000Z");

    const result = await exchangeQuickBooksAuthorizationCode({ config, code: "code-a", request, now });

    expect(result).toEqual({
      accessToken: "access-a",
      refreshToken: "refresh-a",
      accessTokenExpiresAt: new Date("2026-08-05T01:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2026-11-13T00:00:00.000Z"),
      tokenType: "bearer",
    });
    const [tokenCall] = intuitCalls(request, TOKEN_ENDPOINT);
    expect(tokenCall?.[0]).toBe(TOKEN_ENDPOINT);
    expect(tokenCall?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: `Basic ${Buffer.from("qbo-client:qbo-secret").toString("base64")}`,
      }),
    });
    const body = (tokenCall?.[1] as { body: URLSearchParams }).body;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-a");
  });

  it("uses the newly rotated refresh token returned by Intuit", async () => {
    const request = intuitOAuthTransport({
      token: () => intuitTokenResponse({ access_token: "access-new", refresh_token: "refresh-new" }),
    });

    const result = await refreshQuickBooksToken({ config, refreshToken: "refresh-old", request });

    expect(result.refreshToken).toBe("refresh-new");
    const [tokenCall] = intuitCalls(request, TOKEN_ENDPOINT);
    const body = (tokenCall?.[1] as { body: URLSearchParams }).body;
    expect(body.get("refresh_token")).toBe("refresh-old");
  });

  it.each([
    [401, "NOT_CONNECTED", false],
    [403, "FORBIDDEN", false],
    [429, "RATE_LIMITED", true],
    [503, "PROVIDER_UNAVAILABLE", true],
  ] as const)("classifies OAuth HTTP %i as %s", async (status, code, retryable) => {
    const request = intuitOAuthTransport({ token: () => jsonResponse({}, { status }) });
    await expect(refreshQuickBooksToken({ config, refreshToken: "refresh-old", request }))
      .rejects.toMatchObject({ code, retryable });
  });

  it("classifies an unreachable OAuth provider as temporarily unavailable", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(refreshQuickBooksToken({ config, refreshToken: "refresh-old", request }))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });
});

describe("Intuit OAuth discovery", () => {
  it("reads the endpoints from the discovery document for the configured environment", async () => {
    const request = intuitOAuthTransport();

    const sandbox = await quickBooksOAuthEndpoints({ ...config, request });
    resetQuickBooksOAuthDiscovery();
    const production = await quickBooksOAuthEndpoints({ ...config, environment: "production", request });

    expect(sandbox).toEqual({
      authorizationEndpoint: INTUIT_DISCOVERY_DOCUMENT.authorization_endpoint,
      tokenEndpoint: INTUIT_DISCOVERY_DOCUMENT.token_endpoint,
      revocationEndpoint: INTUIT_DISCOVERY_DOCUMENT.revocation_endpoint,
    });
    expect(production).toEqual(sandbox);
    expect(intuitCalls(request, "openid_sandbox_configuration")).toHaveLength(1);
    expect(intuitCalls(request, "/.well-known/openid_configuration")).toHaveLength(1);
  });

  it("caches the document instead of re-reading it for every authorization", async () => {
    const request = intuitOAuthTransport({ token: () => intuitTokenResponse() });

    await buildQuickBooksAuthorizationUrl({ ...config, request }, "s".repeat(32));
    await buildQuickBooksAuthorizationUrl({ ...config, request }, "t".repeat(32));
    await refreshQuickBooksToken({ config, refreshToken: "refresh-old", request });

    expect(intuitCalls(request, "/.well-known/")).toHaveLength(1);
  });

  it.each([
    ["an unreachable document", intuitOAuthTransport({
      discovery: () => { throw new Error("discovery down"); },
      token: () => intuitTokenResponse(),
    })],
    ["an HTTP 503 document", intuitOAuthTransport({
      discovery: () => jsonResponse({}, { status: 503 }),
      token: () => intuitTokenResponse(),
    })],
    ["a document that is not an object", intuitOAuthTransport({
      discovery: () => jsonResponse("\"not-a-document\""),
      token: () => intuitTokenResponse(),
    })],
  ])("falls back to the published endpoints when discovery returns %s", async (_label, request) => {
    const endpoints = await quickBooksOAuthEndpoints({ ...config, request });

    expect(endpoints).toEqual({
      authorizationEndpoint: "https://appcenter.intuit.com/connect/oauth2",
      tokenEndpoint: TOKEN_ENDPOINT,
      revocationEndpoint: REVOKE_ENDPOINT,
    });
    // Authorization and token exchange still work: falling back is the correct
    // behaviour, not an error.
    const url = new URL(await buildQuickBooksAuthorizationUrl({ ...config, request }, "s".repeat(32)));
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    await expect(refreshQuickBooksToken({ config, refreshToken: "refresh-old", request }))
      .resolves.toMatchObject({ accessToken: "access-a" });
  });

  it("retries a failed discovery sooner than a successful one", async () => {
    const request = intuitOAuthTransport({ discovery: () => jsonResponse({}, { status: 503 }) });

    await quickBooksOAuthEndpoints({ ...config, request });
    await quickBooksOAuthEndpoints({ ...config, request });
    const cachedFailure = intuitCalls(request, "/.well-known/").length;

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
      await quickBooksOAuthEndpoints({ ...config, request });
    } finally {
      vi.useRealTimers();
    }

    expect(cachedFailure).toBe(1);
    expect(intuitCalls(request, "/.well-known/")).toHaveLength(2);
  });

  it("refuses a discovered endpoint that is not an https Intuit host", async () => {
    const request = intuitOAuthTransport({
      discovery: () => jsonResponse({
        ...INTUIT_DISCOVERY_DOCUMENT,
        authorization_endpoint: "https://appcenter.intuit.com.attacker.example/connect/oauth2",
        token_endpoint: "http://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        revocation_endpoint: 42,
      }),
    });

    await expect(quickBooksOAuthEndpoints({ ...config, request })).resolves.toEqual({
      authorizationEndpoint: "https://appcenter.intuit.com/connect/oauth2",
      tokenEndpoint: TOKEN_ENDPOINT,
      revocationEndpoint: REVOKE_ENDPOINT,
    });
  });

  it("uses a discovered endpoint that discovery actually moved", async () => {
    const moved = "https://oauth.platform.intuit.com/oauth2/v2/tokens/bearer";
    const request = intuitOAuthTransport({
      discovery: () => jsonResponse({ ...INTUIT_DISCOVERY_DOCUMENT, token_endpoint: moved }),
      token: () => intuitTokenResponse(),
    });

    await refreshQuickBooksToken({ config, refreshToken: "refresh-old", request });

    expect(intuitCalls(request, moved)).toHaveLength(1);
    expect(intuitCalls(request, "/oauth2/v1/tokens/bearer")).toHaveLength(0);
  });
});

describe("Intuit grant revocation", () => {
  it("posts the refresh token as JSON with HTTP Basic client authentication", async () => {
    const request = intuitOAuthTransport({
      revoke: () => new Response("", { status: 200, headers: { intuit_tid: "tid-revoke-a" } }),
    });

    await expect(revokeQuickBooksToken({ config, refreshToken: "refresh-a", request }))
      .resolves.toEqual({ outcome: "REVOKED", intuitTid: "tid-revoke-a" });

    const [revokeCall] = intuitCalls(request, REVOKE_ENDPOINT);
    expect(revokeCall?.[0]).toBe(REVOKE_ENDPOINT);
    expect(revokeCall?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: `Basic ${Buffer.from("qbo-client:qbo-secret").toString("base64")}`,
        "Content-Type": "application/json",
      }),
    });
    expect(JSON.parse((revokeCall?.[1] as { body: string }).body)).toEqual({ token: "refresh-a" });
  });

  it("reports a token Intuit does not hold as already invalid rather than as a failure", async () => {
    const request = intuitOAuthTransport({ revoke: () => jsonResponse({}, { status: 400 }) });

    await expect(revokeQuickBooksToken({ config, refreshToken: "refresh-stale", request }))
      .resolves.toEqual({ outcome: "ALREADY_INVALID" });
  });

  it.each([
    [401, "CONFIGURATION_ERROR"],
    [429, "RATE_LIMITED"],
    [500, "PROVIDER_UNAVAILABLE"],
    [418, "PROVIDER_ERROR"],
  ] as const)("raises %i as %s so the grant is never assumed dead", async (status, code) => {
    const request = intuitOAuthTransport({ revoke: () => jsonResponse({}, { status }) });

    await expect(revokeQuickBooksToken({ config, refreshToken: "refresh-a", request }))
      .rejects.toMatchObject({ code });
  });

  it("treats an unreachable revocation endpoint as a live grant", async () => {
    const request = intuitOAuthTransport({
      revoke: () => { throw new Error("connection reset"); },
    });

    await expect(revokeQuickBooksToken({ config, refreshToken: "refresh-a", request }))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("revokes at the endpoint discovery named", async () => {
    const moved = "https://developer.api.intuit.com/v3/oauth2/tokens/revoke";
    const request = intuitOAuthTransport({
      discovery: () => jsonResponse({ ...INTUIT_DISCOVERY_DOCUMENT, revocation_endpoint: moved }),
      revoke: () => new Response("", { status: 200 }),
    });

    await revokeQuickBooksToken({ config, refreshToken: "refresh-a", request });

    expect(intuitCalls(request, moved)).toHaveLength(1);
  });
});
