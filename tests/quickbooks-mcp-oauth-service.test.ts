import { describe, expect, it, vi } from "vitest";
import type { QuickBooksClientManager } from "../src/quickbooks/clientManager.js";
import { InMemoryQuickBooksMcpOAuthRepository } from "../src/quickbooks/mcpOAuthRepository.js";
import { QuickBooksMcpOAuthService } from "../src/quickbooks/mcpOAuthService.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";

describe("QuickBooks MCP per-user OAuth", () => {
  it("defaults omitted scope to read-only and accepts an explicit execute step-up scope", async () => {
    const repository = new InMemoryQuickBooksMcpOAuthRepository();
    const service = new QuickBooksMcpOAuthService({
      repository,
      manager: { connect: vi.fn() } as unknown as QuickBooksClientManager,
      qbo: {
        clientId: "intuit-client",
        clientSecret: "intuit-secret",
        redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
        environment: "sandbox",
      },
      client: {
        clientId: "agent2-quickbooks",
        clientSecret: "s".repeat(48),
        redirectUris: ["https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
        accessTokenTtlSeconds: 3_600,
        refreshTokenTtlSeconds: 86_400,
      },
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 6)),
    });
    const defaultFlow = await service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
      responseType: "code",
      state: "state-read-only",
    });
    const explicitFlow = await service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
      responseType: "code",
      state: "state-step-up",
      scope: "quickbooks.read quickbooks.mutation.prepare quickbooks.mutation.execute",
    });
    expect(defaultFlow.consentUrl).toContain("state=");
    expect(explicitFlow.consentUrl).toContain("state=");
  });
  it("binds one Agent installation to its own QuickBooks actor and rotates opaque MCP tokens", async () => {
    const now = new Date("2026-08-06T00:00:00.000Z");
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "intuit-access-a",
      refresh_token: "intuit-refresh-a",
      expires_in: 3_600,
      x_refresh_token_expires_in: 8_640_000,
      token_type: "bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const connect = vi.fn(async (input: { actorId: string; realmId: string }) => ({
      connectionId: "qbc-a",
      actorId: input.actorId,
      realmId: input.realmId,
      companyName: "Sandbox Company A",
      grantedScopes: ["com.intuit.quickbooks.accounting"],
    }));
    const onActorSecurityRevoked = vi.fn().mockResolvedValue(undefined);
    const service = new QuickBooksMcpOAuthService({
      repository: new InMemoryQuickBooksMcpOAuthRepository(),
      manager: {
        connect,
        resolveSingleConnection: vi.fn(async (actorId: string) => ({
          connectionId: "qbc-a", actorId, realmId: "9341457658718743",
          companyName: "Sandbox Company A", grantedScopes: ["com.intuit.quickbooks.accounting"],
        })),
      } as unknown as QuickBooksClientManager,
      qbo: {
        clientId: "intuit-client",
        clientSecret: "intuit-secret",
        redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
        environment: "sandbox",
        request,
      },
      client: {
        clientId: "agent2-quickbooks",
        clientSecret: "s".repeat(48),
        redirectUris: ["https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
        accessTokenTtlSeconds: 3_600,
        refreshTokenTtlSeconds: 86_400,
      },
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 9)),
      clock: () => now,
      onActorSecurityRevoked,
    });

    const started = await service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
      responseType: "code",
      state: "agent2-state-a",
      scope: "quickbooks.read quickbooks.bill.prepare",
    });
    const consent = new URL(started.consentUrl);
    const callback = await service.handleQuickBooksCallback({
      browserCookie: started.browserCookie,
      state: consent.searchParams.get("state") as string,
      code: "intuit-code-a",
      realmId: "9341457658718743",
    });
    const hostRedirect = new URL(callback.redirectUrl);
    const authorizationCode = hostRedirect.searchParams.get("code") as string;

    expect(hostRedirect.origin + hostRedirect.pathname).toBe(
      "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
    );
    expect(hostRedirect.searchParams.get("state")).toBe("agent2-state-a");
    expect(callback.actorId).toMatch(/^qbo-client-[a-f0-9]{20}:user:[0-9a-f-]{36}$/u);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      actorId: callback.actorId,
      realmId: "9341457658718743",
      token: expect.objectContaining({ accessToken: "intuit-access-a", refreshToken: "intuit-refresh-a" }),
    }));

    const issued = await service.exchangeAuthorizationCode({
      clientId: "agent2-quickbooks",
      clientSecret: "s".repeat(48),
      code: authorizationCode,
      redirectUri: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
    });
    await expect(service.verifyAccessToken(issued.access_token)).resolves.toMatchObject({
      actorId: callback.actorId,
      workspaceId: expect.stringMatching(/^qbo-client-/u),
      subjectId: expect.any(String),
      agentId: "agent2-quickbooks",
      installationId: expect.stringMatching(/^qbt_/u),
      bindingId: expect.stringMatching(/^qbob_/u),
      bindingRevision: 1,
      connectionId: "qbc-a",
      scopes: ["quickbooks.read", "quickbooks.bill.prepare"],
    });

    await expect(service.exchangeAuthorizationCode({
      clientId: "agent2-quickbooks",
      clientSecret: "s".repeat(48),
      code: authorizationCode,
      redirectUri: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const refreshed = await service.refresh({
      clientId: "agent2-quickbooks",
      clientSecret: "s".repeat(48),
      refreshToken: issued.refresh_token,
    });
    await expect(service.verifyAccessToken(issued.access_token)).resolves.toMatchObject({ actorId: callback.actorId });
    await expect(service.verifyAccessToken(refreshed.access_token)).resolves.toMatchObject({ actorId: callback.actorId });
    expect(refreshed.refresh_token).not.toBe(issued.refresh_token);

    await service.revoke({
      clientId: "agent2-quickbooks",
      clientSecret: "s".repeat(48),
      token: refreshed.refresh_token,
    });
    expect(onActorSecurityRevoked).toHaveBeenCalledWith(callback.actorId);
    await expect(service.verifyAccessToken(issued.access_token)).resolves.toBeUndefined();
    await expect(service.verifyAccessToken(refreshed.access_token)).resolves.toBeUndefined();
    await expect(service.refresh({
      clientId: "agent2-quickbooks",
      clientSecret: "s".repeat(48),
      refreshToken: refreshed.refresh_token,
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("replays one refresh response during the concurrency grace, then revokes the family after it", async () => {
    let now = new Date("2026-08-06T00:00:00.000Z");
    const repository = new InMemoryQuickBooksMcpOAuthRepository();
    const onActorSecurityRevoked = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "intuit-access-a",
      refresh_token: "intuit-refresh-a",
      expires_in: 3_600,
      x_refresh_token_expires_in: 8_640_000,
      token_type: "bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const service = new QuickBooksMcpOAuthService({
      repository,
      manager: {
        connect: vi.fn(async (input: { actorId: string; realmId: string }) => ({
          connectionId: "qbc-a", actorId: input.actorId, realmId: input.realmId,
          companyName: "Sandbox", grantedScopes: ["com.intuit.quickbooks.accounting"],
        })),
        resolveSingleConnection: vi.fn(async (actorId: string) => ({
          connectionId: "qbc-a", actorId, realmId: "9341457658718743",
          companyName: "Sandbox", grantedScopes: ["com.intuit.quickbooks.accounting"],
        })),
      } as unknown as QuickBooksClientManager,
      qbo: {
        clientId: "intuit-client", clientSecret: "intuit-secret",
        redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
        environment: "sandbox", request,
      },
      client: {
        clientId: "agent2-quickbooks", clientSecret: "s".repeat(48),
        redirectUris: ["https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
        accessTokenTtlSeconds: 3_600, refreshTokenTtlSeconds: 86_400,
      },
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 7)),
      clock: () => now,
      onActorSecurityRevoked,
    });
    const started = await service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
      responseType: "code", state: "agent2-state-replay",
    });
    const consent = new URL(started.consentUrl);
    const callback = await service.handleQuickBooksCallback({
      browserCookie: started.browserCookie,
      state: consent.searchParams.get("state") as string,
      code: "intuit-code-a", realmId: "9341457658718743",
    });
    const authorizationCode = new URL(callback.redirectUrl).searchParams.get("code") as string;
    const issued = await service.exchangeAuthorizationCode({
      clientId: "agent2-quickbooks", clientSecret: "s".repeat(48), code: authorizationCode,
      redirectUri: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
    });
    const concurrentResponses = await Promise.all(Array.from({ length: 50 }, () => service.refresh({
      clientId: "agent2-quickbooks", clientSecret: "s".repeat(48), refreshToken: issued.refresh_token,
    })));
    const descendant = concurrentResponses[0] as typeof issued;
    expect(concurrentResponses.every((response) =>
      response.access_token === descendant.access_token && response.refresh_token === descendant.refresh_token
    )).toBe(true);
    const currentRetry = await service.refresh({
      clientId: "agent2-quickbooks", clientSecret: "s".repeat(48), refreshToken: descendant.refresh_token,
    });
    expect(currentRetry).toEqual(descendant);
    expect(onActorSecurityRevoked).not.toHaveBeenCalled();
    await expect(service.verifyAccessToken(issued.access_token)).resolves.toMatchObject({ actorId: callback.actorId });
    await expect(service.verifyAccessToken(descendant.access_token)).resolves.toMatchObject({ actorId: callback.actorId });

    now = new Date(now.getTime() + 10_001);
    const newest = await service.refresh({
      clientId: "agent2-quickbooks", clientSecret: "s".repeat(48), refreshToken: descendant.refresh_token,
    });
    expect(newest.refresh_token).not.toBe(descendant.refresh_token);
    await expect(service.verifyAccessToken(descendant.access_token)).resolves.toMatchObject({ actorId: callback.actorId });
    await expect(service.refresh({
      clientId: "agent2-quickbooks", clientSecret: "s".repeat(48), refreshToken: issued.refresh_token,
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(onActorSecurityRevoked).toHaveBeenCalledWith(callback.actorId);
    await expect(service.verifyAccessToken(descendant.access_token)).resolves.toBeUndefined();
    await expect(service.verifyAccessToken(newest.access_token)).resolves.toBeUndefined();
    await expect(service.refresh({
      clientId: "agent2-quickbooks", clientSecret: "s".repeat(48), refreshToken: descendant.refresh_token,
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("rejects an unregistered Agent2 redirect before starting Intuit OAuth", async () => {
    const service = new QuickBooksMcpOAuthService({
      repository: new InMemoryQuickBooksMcpOAuthRepository(),
      manager: { connect: vi.fn() } as unknown as QuickBooksClientManager,
      qbo: {
        clientId: "intuit-client",
        clientSecret: "intuit-secret",
        redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
        environment: "sandbox",
      },
      client: {
        clientId: "agent2-quickbooks",
        clientSecret: "s".repeat(48),
        redirectUris: ["https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
        accessTokenTtlSeconds: 3_600,
        refreshTokenTtlSeconds: 86_400,
      },
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 8)),
    });

    await expect(service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: "https://evil.invalid/callback",
      responseType: "code",
      state: "state-a",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
