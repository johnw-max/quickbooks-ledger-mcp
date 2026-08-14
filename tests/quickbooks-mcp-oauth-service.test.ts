import { describe, expect, it, vi } from "vitest";
import type { QuickBooksClientManager } from "../src/quickbooks/clientManager.js";
import { InMemoryQuickBooksMcpOAuthRepository } from "../src/quickbooks/mcpOAuthRepository.js";
import { QuickBooksMcpOAuthService } from "../src/quickbooks/mcpOAuthService.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";

const AGENT2_REDIRECT = "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback";
const WORK_REDIRECT = "https://work.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback";
const AGENT2_SECRET = "a".repeat(48);
const WORK_SECRET = "w".repeat(48);

function brokerConfig() {
  return {
    resourceUri: "https://quickbooks-mcp.example.test/quickbooks/mcp",
    hostClients: [
      {
        name: "Agent2",
        clientId: "agent2-quickbooks",
        clientSecret: AGENT2_SECRET,
        redirectUris: [AGENT2_REDIRECT],
        allowedOrigins: ["https://agent2.zcloak.ai"],
      },
      {
        name: "Work",
        clientId: "work-quickbooks",
        clientSecret: WORK_SECRET,
        redirectUris: [WORK_REDIRECT],
        allowedOrigins: ["https://work.zcloak.ai"],
      },
    ],
    accessTokenTtlSeconds: 3_600,
    refreshTokenTtlSeconds: 86_400,
  };
}

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
      config: brokerConfig(),
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 6)),
    });
    const defaultFlow = await service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: AGENT2_REDIRECT,
      responseType: "code",
      state: "state-read-only",
    });
    const explicitFlow = await service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: AGENT2_REDIRECT,
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
      config: brokerConfig(),
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 9)),
      clock: () => now,
      onActorSecurityRevoked,
    });

    const started = await service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: AGENT2_REDIRECT,
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
      AGENT2_REDIRECT,
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
      clientSecret: AGENT2_SECRET,
      code: authorizationCode,
      redirectUri: AGENT2_REDIRECT,
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
      grantedScopes: ["quickbooks.read", "quickbooks.bill.prepare"],
      identityAssurance: "INSTALLATION_ONLY",
      allowedOrigins: ["https://agent2.zcloak.ai"],
    });

    await expect(service.exchangeAuthorizationCode({
      clientId: "agent2-quickbooks",
      clientSecret: AGENT2_SECRET,
      code: authorizationCode,
      redirectUri: AGENT2_REDIRECT,
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const refreshed = await service.refresh({
      clientId: "agent2-quickbooks",
      clientSecret: AGENT2_SECRET,
      refreshToken: issued.refresh_token,
    });
    await expect(service.verifyAccessToken(issued.access_token)).resolves.toMatchObject({ actorId: callback.actorId });
    await expect(service.verifyAccessToken(refreshed.access_token)).resolves.toMatchObject({ actorId: callback.actorId });
    expect(refreshed.refresh_token).not.toBe(issued.refresh_token);

    await service.revoke({
      clientId: "agent2-quickbooks",
      clientSecret: AGENT2_SECRET,
      token: refreshed.refresh_token,
    });
    expect(onActorSecurityRevoked).toHaveBeenCalledWith(callback.actorId);
    await expect(service.verifyAccessToken(issued.access_token)).resolves.toBeUndefined();
    await expect(service.verifyAccessToken(refreshed.access_token)).resolves.toBeUndefined();
    await expect(service.refresh({
      clientId: "agent2-quickbooks",
      clientSecret: AGENT2_SECRET,
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
      config: brokerConfig(),
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 7)),
      clock: () => now,
      onActorSecurityRevoked,
    });
    const started = await service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: AGENT2_REDIRECT,
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
      clientId: "agent2-quickbooks", clientSecret: AGENT2_SECRET, code: authorizationCode,
      redirectUri: AGENT2_REDIRECT,
    });
    const concurrentResponses = await Promise.all(Array.from({ length: 50 }, () => service.refresh({
      clientId: "agent2-quickbooks", clientSecret: AGENT2_SECRET, refreshToken: issued.refresh_token,
    })));
    const descendant = concurrentResponses[0] as typeof issued;
    expect(concurrentResponses.every((response) =>
      response.access_token === descendant.access_token && response.refresh_token === descendant.refresh_token
    )).toBe(true);
    const currentRetry = await service.refresh({
      clientId: "agent2-quickbooks", clientSecret: AGENT2_SECRET, refreshToken: descendant.refresh_token,
    });
    expect(currentRetry).toEqual(descendant);
    expect(onActorSecurityRevoked).not.toHaveBeenCalled();
    await expect(service.verifyAccessToken(issued.access_token)).resolves.toMatchObject({ actorId: callback.actorId });
    await expect(service.verifyAccessToken(descendant.access_token)).resolves.toMatchObject({ actorId: callback.actorId });

    now = new Date(now.getTime() + 10_001);
    const newest = await service.refresh({
      clientId: "agent2-quickbooks", clientSecret: AGENT2_SECRET, refreshToken: descendant.refresh_token,
    });
    expect(newest.refresh_token).not.toBe(descendant.refresh_token);
    await expect(service.verifyAccessToken(descendant.access_token)).resolves.toMatchObject({ actorId: callback.actorId });
    await expect(service.refresh({
      clientId: "agent2-quickbooks", clientSecret: AGENT2_SECRET, refreshToken: issued.refresh_token,
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(onActorSecurityRevoked).toHaveBeenCalledWith(callback.actorId);
    await expect(service.verifyAccessToken(descendant.access_token)).resolves.toBeUndefined();
    await expect(service.verifyAccessToken(newest.access_token)).resolves.toBeUndefined();
    await expect(service.refresh({
      clientId: "agent2-quickbooks", clientSecret: AGENT2_SECRET, refreshToken: descendant.refresh_token,
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
      config: brokerConfig(),
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 8)),
    });

    await expect(service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: "https://evil.invalid/callback",
      responseType: "code",
      state: "state-a",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("isolates redirects, authorization codes, refresh families, revocation, origins, and identity assurance per Host client", async () => {
    const now = new Date("2026-08-06T00:00:00.000Z");
    const repository = new InMemoryQuickBooksMcpOAuthRepository();
    const service = new QuickBooksMcpOAuthService({
      repository,
      manager: {
        connect: vi.fn(async (input: { actorId: string; realmId: string }) => ({
          connectionId: `qbc-${input.actorId}`,
          actorId: input.actorId,
          realmId: input.realmId,
          companyName: `Sandbox ${input.realmId}`,
          grantedScopes: ["com.intuit.quickbooks.accounting"],
        })),
        resolveSingleConnection: vi.fn(async (actorId: string) => ({
          connectionId: `qbc-${actorId}`,
          actorId,
          realmId: actorId.startsWith("qbo-client-5") ? "9341457658718744" : "9341457658718743",
          companyName: "Sandbox",
          grantedScopes: ["com.intuit.quickbooks.accounting"],
        })),
      } as unknown as QuickBooksClientManager,
      qbo: {
        clientId: "intuit-client",
        clientSecret: "intuit-secret",
        redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
        environment: "sandbox",
        request: vi.fn().mockImplementation(async () => new Response(JSON.stringify({
          access_token: "intuit-access",
          refresh_token: "intuit-refresh",
          expires_in: 3_600,
          x_refresh_token_expires_in: 8_640_000,
          token_type: "bearer",
        }), { status: 200, headers: { "Content-Type": "application/json" } })),
      },
      config: brokerConfig(),
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 4)),
      clock: () => now,
    });

    expect(service.registeredHostClientCount).toBe(2);
    expect(service.isOriginAllowedForClient("agent2-quickbooks", "https://agent2.zcloak.ai")).toBe(true);
    expect(service.isOriginAllowedForClient("agent2-quickbooks", "https://work.zcloak.ai")).toBe(false);
    expect(service.isOriginAllowedForClient("work-quickbooks", "https://work.zcloak.ai")).toBe(true);

    await expect(service.startAuthorization({
      clientId: "agent2-quickbooks",
      redirectUri: WORK_REDIRECT,
      responseType: "code",
      state: "redirect-confusion",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const complete = async (clientId: string, redirectUri: string, realmId: string) => {
      const started = await service.startAuthorization({
        clientId,
        redirectUri,
        responseType: "code",
        state: `${clientId}-state`,
        scope: "quickbooks.read",
      });
      const callback = await service.handleQuickBooksCallback({
        browserCookie: started.browserCookie,
        state: new URL(started.consentUrl).searchParams.get("state") as string,
        code: `${clientId}-intuit-code`,
        realmId,
      });
      return new URL(callback.redirectUrl).searchParams.get("code") as string;
    };

    const agent2Code = await complete("agent2-quickbooks", AGENT2_REDIRECT, "9341457658718743");
    await expect(service.exchangeAuthorizationCode({
      clientId: "work-quickbooks",
      clientSecret: WORK_SECRET,
      code: agent2Code,
      redirectUri: WORK_REDIRECT,
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const agent2Token = await service.exchangeAuthorizationCode({
      clientId: "agent2-quickbooks",
      clientSecret: AGENT2_SECRET,
      code: agent2Code,
      redirectUri: AGENT2_REDIRECT,
    });

    const workCode = await complete("work-quickbooks", WORK_REDIRECT, "9341457658718744");
    const workToken = await service.exchangeAuthorizationCode({
      clientId: "work-quickbooks",
      clientSecret: WORK_SECRET,
      code: workCode,
      redirectUri: WORK_REDIRECT,
    });
    const verifiedAgent2 = await service.verifyAccessToken(agent2Token.access_token);
    const verifiedWork = await service.verifyAccessToken(workToken.access_token);
    expect(verifiedAgent2).toMatchObject({
      clientId: "agent2-quickbooks",
      identityAssurance: "INSTALLATION_ONLY",
      allowedOrigins: ["https://agent2.zcloak.ai"],
    });
    expect(verifiedWork).toMatchObject({
      clientId: "work-quickbooks",
      identityAssurance: "INSTALLATION_ONLY",
      allowedOrigins: ["https://work.zcloak.ai"],
    });
    expect(verifiedAgent2?.actorId).not.toBe(verifiedWork?.actorId);

    await expect(service.refresh({
      clientId: "work-quickbooks",
      clientSecret: WORK_SECRET,
      refreshToken: agent2Token.refresh_token,
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const refreshedAgent2 = await service.refresh({
      clientId: "agent2-quickbooks",
      clientSecret: AGENT2_SECRET,
      refreshToken: agent2Token.refresh_token,
    });
    await expect(service.verifyAccessToken(refreshedAgent2.access_token)).resolves.toMatchObject({
      clientId: "agent2-quickbooks",
    });
    await expect(service.verifyAccessToken(workToken.access_token)).resolves.toMatchObject({
      clientId: "work-quickbooks",
    });

    await service.revoke({
      clientId: "agent2-quickbooks",
      clientSecret: AGENT2_SECRET,
      token: workToken.refresh_token,
    });
    await expect(service.verifyAccessToken(workToken.access_token)).resolves.toMatchObject({
      clientId: "work-quickbooks",
    });
  });
});
