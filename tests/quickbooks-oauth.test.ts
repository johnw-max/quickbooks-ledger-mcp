import { describe, expect, it, vi } from "vitest";
import {
  buildQuickBooksAuthorizationUrl,
  exchangeQuickBooksAuthorizationCode,
  refreshQuickBooksToken,
} from "../src/providers/quickbooksOAuth.js";

const config = {
  clientId: "qbo-client",
  clientSecret: "qbo-secret",
  redirectUri: "https://agent2.zcloak.ai/oauth/quickbooks/callback",
  environment: "sandbox" as const,
};

describe("QuickBooks OAuth", () => {
  it("builds the official accounting-scope authorization URL with exact state and redirect", () => {
    const state = "s".repeat(32);
    const url = new URL(buildQuickBooksAuthorizationUrl(config, state));

    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(url.searchParams.get("client_id")).toBe("qbo-client");
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("exchanges a code and retains both Intuit token expiries", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-a",
      refresh_token: "refresh-a",
      expires_in: 3_600,
      x_refresh_token_expires_in: 8_640_000,
      token_type: "bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const now = new Date("2026-08-05T00:00:00.000Z");

    const result = await exchangeQuickBooksAuthorizationCode({ config, code: "code-a", request, now });

    expect(result).toEqual({
      accessToken: "access-a",
      refreshToken: "refresh-a",
      accessTokenExpiresAt: new Date("2026-08-05T01:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2026-11-13T00:00:00.000Z"),
      tokenType: "bearer",
    });
    expect(request).toHaveBeenCalledWith(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("qbo-client:qbo-secret").toString("base64")}`,
        }),
      }),
    );
    const body = request.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-a");
  });

  it("uses the newly rotated refresh token returned by Intuit", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3_600,
      x_refresh_token_expires_in: 8_640_000,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await refreshQuickBooksToken({ config, refreshToken: "refresh-old", request });

    expect(result.refreshToken).toBe("refresh-new");
    const body = request.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("refresh_token")).toBe("refresh-old");
  });

  it.each([
    [401, "NOT_CONNECTED", false],
    [403, "FORBIDDEN", false],
    [429, "RATE_LIMITED", true],
    [503, "PROVIDER_UNAVAILABLE", true],
  ] as const)("classifies OAuth HTTP %i as %s", async (status, code, retryable) => {
    const request = vi.fn().mockResolvedValue(new Response("{}", {
      status,
      headers: { "Content-Type": "application/json" },
    }));
    await expect(refreshQuickBooksToken({ config, refreshToken: "refresh-old", request }))
      .rejects.toMatchObject({ code, retryable });
  });

  it("classifies an unreachable OAuth provider as temporarily unavailable", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(refreshQuickBooksToken({ config, refreshToken: "refresh-old", request }))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });
});
