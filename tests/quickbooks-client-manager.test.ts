import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logging.js";
import { resetQuickBooksOAuthDiscovery } from "../src/providers/quickbooksOAuth.js";
import { INTUIT_DISCOVERY_DOCUMENT, jsonResponse } from "./helpers/intuitOAuthTransport.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";
import { QuickBooksClientManager } from "../src/quickbooks/clientManager.js";
import { InMemoryQuickBooksConnectionRepository } from "../src/quickbooks/connections.js";
import { quickBooksBindingContext } from "../src/quickbooks/bindingContext.js";

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("QuickBooks connection manager", () => {
  it("binds the OAuth realm through a realm-scoped CompanyInfo read, encrypts tokens, rotates refresh token, and uses the new access token", async () => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({ url, ...(headers?.Authorization ? { authorization: headers.Authorization } : {}) });
      if (url === "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer") {
        return new Response(JSON.stringify({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3_600,
          x_refresh_token_expires_in: 8_640_000,
          token_type: "bearer",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/company/934145/companyinfo/934145")) {
        return new Response(JSON.stringify({ CompanyInfo: { Id: "1", CompanyName: "Sandbox Company" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/company/934145/query")) {
        return new Response(JSON.stringify({ QueryResponse: { Account: [{ Id: "7", Name: "Subscriptions" }] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const repository = new InMemoryQuickBooksConnectionRepository();
    const cipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 3));
    const manager = new QuickBooksClientManager({
      repository,
      cipher,
      config: {
        clientId: "client-a",
        clientSecret: "secret-a",
        redirectUri: "https://agent2.zcloak.ai/oauth/quickbooks/callback",
        environment: "sandbox",
        request,
      },
      logger: logger(),
    });

    const connected = await manager.connect({
      actorId: "actor-a",
      realmId: "934145",
      token: {
        accessToken: "access-old",
        refreshToken: "refresh-old",
        accessTokenExpiresAt: new Date(Date.now() - 1_000),
        refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
        tokenType: "bearer",
      },
    });

    expect(connected).toMatchObject({
      actorId: "actor-a",
      realmId: "934145",
      companyName: "Sandbox Company",
      status: "ACTIVE",
    });
    expect(connected.tokenCiphertext).not.toContain("access-old");
    expect(connected.tokenCiphertext).not.toContain("refresh-old");

    const accounts = await manager.withProvider("actor-a", (provider) => provider.listAccounts());

    expect(accounts).toEqual([{ Id: "7", Name: "Subscriptions" }]);
    const stored = await repository.get("actor-a", "934145");
    expect(stored).toMatchObject({ status: "ACTIVE", refreshVersion: 1 });
    expect(stored?.tokenCiphertext).not.toContain("refresh-new");
    expect(requests.some((entry) => entry.url.includes("/query") && entry.authorization === "Bearer access-new"))
      .toBe(true);
  });

  it("refuses a realm-scoped CompanyInfo response without its entity identity", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      CompanyInfo: { CompanyName: "Incomplete Company" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const repository = new InMemoryQuickBooksConnectionRepository();
    const manager = new QuickBooksClientManager({
      repository,
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 4)),
      config: {
        clientId: "client-a",
        clientSecret: "secret-a",
        redirectUri: "https://agent2.zcloak.ai/oauth/quickbooks/callback",
        environment: "sandbox",
        request,
      },
      logger: logger(),
    });

    await expect(manager.connect({
      actorId: "actor-a",
      realmId: "934145",
      token: {
        accessToken: "access-old",
        refreshToken: "refresh-old",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
        tokenType: "bearer",
      },
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
    await expect(repository.listActive("actor-a")).resolves.toEqual([]);
  });

  it("keeps exactly one active QuickBooks company per MCP actor when the user authorizes a replacement", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const realmId = url.includes("/company/934146/") ? "934146" : "934145";
      return new Response(JSON.stringify({
        CompanyInfo: { Id: "1", CompanyName: `Sandbox Company ${realmId}` },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const repository = new InMemoryQuickBooksConnectionRepository();
    const manager = new QuickBooksClientManager({
      repository,
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 5)),
      config: {
        clientId: "client-a",
        clientSecret: "secret-a",
        redirectUri: "https://agent2.zcloak.ai/oauth/quickbooks/callback",
        environment: "sandbox",
        request,
      },
      logger: logger(),
    });
    const token = (suffix: string) => ({
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
      tokenType: "bearer",
    });

    await manager.connect({ actorId: "actor-a", realmId: "934145", token: token("a") });
    await manager.connect({ actorId: "actor-b", realmId: "934145", token: token("b") });
    await manager.connect({ actorId: "actor-a", realmId: "934146", token: token("replacement") });

    await expect(repository.listActive("actor-a")).resolves.toMatchObject([
      { actorId: "actor-a", realmId: "934146", status: "ACTIVE" },
    ]);
    await expect(repository.listActive("actor-b")).resolves.toMatchObject([
      { actorId: "actor-b", realmId: "934145", status: "ACTIVE" },
    ]);
  });

  it("fails closed instead of routing a previously resolved operation to a replacement company", async () => {
    const requestedUrls: string[] = [];
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      const realmId = url.includes("/company/934146/") ? "934146" : "934145";
      if (url.includes("/companyinfo/")) {
        return new Response(JSON.stringify({
          CompanyInfo: { Id: "1", CompanyName: `Sandbox Company ${realmId}` },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/query")) {
        return new Response(JSON.stringify({ QueryResponse: { Account: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const repository = new InMemoryQuickBooksConnectionRepository();
    const manager = new QuickBooksClientManager({
      repository,
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 6)),
      config: {
        clientId: "client-a",
        clientSecret: "secret-a",
        redirectUri: "https://mcp.jiayuanwang.xyz/oauth/quickbooks/callback",
        environment: "sandbox",
        request,
      },
      logger: logger(),
    });
    const token = (suffix: string) => ({
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
      tokenType: "bearer",
    });

    const first = await manager.connect({ actorId: "actor-a", realmId: "934145", token: token("a") });
    await manager.connect({ actorId: "actor-a", realmId: "934146", token: token("b") });
    requestedUrls.length = 0;

    await expect(manager.withBoundProvider(
      "actor-a",
      first.connectionId,
      first.realmId,
      (provider) => provider.listAccounts(),
    )).rejects.toMatchObject({ code: "FORBIDDEN", retryable: true });
    expect(requestedUrls).toEqual([]);
  });

  it("rechecks the stored Intuit accounting scope before every provider call", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/companyinfo/")) {
        return new Response(JSON.stringify({ CompanyInfo: { Id: "1", CompanyName: "Sandbox Company" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Provider call must not occur without stored accounting scope: ${url}`);
    });
    const repository = new InMemoryQuickBooksConnectionRepository();
    const manager = new QuickBooksClientManager({
      repository,
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 7)),
      config: {
        clientId: "client-a",
        clientSecret: "secret-a",
        redirectUri: "https://mcp.jiayuanwang.xyz/oauth/quickbooks/callback",
        environment: "sandbox",
        request: request as typeof fetch,
      },
      logger: logger(),
    });
    await manager.connect({
      actorId: "actor-a",
      realmId: "934145",
      grantedScopes: [],
      token: {
        accessToken: "access-a",
        refreshToken: "refresh-a",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
        tokenType: "bearer",
      },
    });
    request.mockClear();

    await expect(manager.withProvider("actor-a", (provider) => provider.listAccounts())).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: {
        failureLayer: "PROVIDER_AUTHORIZATION",
        denyReasons: ["INTUIT_ACCOUNTING_SCOPE_MISSING"],
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps safe binding evidence stable across token refresh and changes it for a company replacement", () => {
    const base = {
      connectionId: "qbc-a",
      realmId: "934145",
      companyName: "Sandbox Company A",
    };
    const beforeRefresh = quickBooksBindingContext(base);
    const afterRefresh = quickBooksBindingContext({ ...base });
    const replacement = quickBooksBindingContext({
      connectionId: "qbc-b",
      realmId: "934146",
      companyName: "Sandbox Company B",
    });

    expect(afterRefresh).toEqual(beforeRefresh);
    expect(replacement.connectionRefSafe).not.toBe(beforeRefresh.connectionRefSafe);
    expect(replacement.boundTargetRefSafe).not.toBe(beforeRefresh.boundTargetRefSafe);
    expect(replacement.bindingRevision).not.toBe(beforeRefresh.bindingRevision);
    expect(JSON.stringify(beforeRefresh)).not.toContain("934145");
    expect(JSON.stringify(beforeRefresh)).not.toContain("qbc-a");
  });
});

describe("QuickBooks disconnect", () => {
  beforeEach(() => {
    resetQuickBooksOAuthDiscovery();
  });

  const oauthConfig = {
    clientId: "client-a",
    clientSecret: "secret-a",
    redirectUri: "https://agent2.zcloak.ai/oauth/quickbooks/callback",
    environment: "sandbox" as const,
  };

  /** Answers the three Intuit surfaces a disconnect touches, and nothing else. */
  function transport(revoke: () => Response): {
    request: typeof fetch;
    revokeCalls: { body: unknown; authorization?: string }[];
  } {
    const revokeCalls: { body: unknown; authorization?: string }[] = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/.well-known/openid")) return jsonResponse(INTUIT_DISCOVERY_DOCUMENT);
      if (url.includes("/companyinfo/")) {
        return jsonResponse({ CompanyInfo: { Id: "1", CompanyName: "Sandbox Company" } });
      }
      if (url.includes("/oauth2/tokens/revoke")) {
        const headers = init?.headers as Record<string, string> | undefined;
        revokeCalls.push({
          body: JSON.parse(String(init?.body)),
          ...(headers?.Authorization ? { authorization: headers.Authorization } : {}),
        });
        return revoke();
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    return { request, revokeCalls };
  }

  async function connectedManager(revoke: () => Response) {
    const { request, revokeCalls } = transport(revoke);
    const repository = new InMemoryQuickBooksConnectionRepository();
    const manager = new QuickBooksClientManager({
      repository,
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 7)),
      config: { ...oauthConfig, request },
      logger: logger(),
    });
    await manager.connect({
      actorId: "actor-a",
      realmId: "934145",
      token: {
        accessToken: "access-a",
        refreshToken: "refresh-a",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
        tokenType: "bearer",
      },
    });
    return { manager, repository, revokeCalls };
  }

  it("revokes the refresh token at Intuit with client authentication before closing the local row", async () => {
    const { manager, repository, revokeCalls } = await connectedManager(
      () => new Response("", { status: 200, headers: { intuit_tid: "1-64a1-d0d0" } }),
    );

    await expect(manager.disconnectActiveConnection("actor-a")).resolves.toMatchObject({
      realmId: "934145",
      companyName: "Sandbox Company",
      providerRevocation: "REVOKED",
      intuitTid: "1-64a1-d0d0",
    });

    // The refresh token, not the access token: revoking the refresh token drops
    // the whole Intuit grant, which is what a customer disconnecting means.
    expect(revokeCalls).toEqual([{
      body: { token: "refresh-a" },
      authorization: `Basic ${Buffer.from("client-a:secret-a").toString("base64")}`,
    }]);
    await expect(repository.get("actor-a", "934145")).resolves.toMatchObject({ status: "REVOKED" });
    await expect(repository.listActive("actor-a")).resolves.toEqual([]);
  });

  it.each([
    ["Intuit is unavailable", () => jsonResponse({}, { status: 503 }), "PROVIDER_UNAVAILABLE"],
    ["Intuit rate-limits the revoke", () => jsonResponse({}, { status: 429 }), "RATE_LIMITED"],
    ["our client credentials are refused", () => jsonResponse({}, { status: 401 }), "CONFIGURATION_ERROR"],
    ["the revoke never reaches Intuit", () => { throw new Error("connection reset"); }, "PROVIDER_UNAVAILABLE"],
  ] as const)("leaves the connection ACTIVE when %s", async (_label, revoke, code) => {
    const { manager, repository } = await connectedManager(revoke);

    await expect(manager.disconnectActiveConnection("actor-a")).rejects.toMatchObject({ code });

    // Still connected is the truth: Intuit still holds a live refresh token, so
    // recording a local disconnect would be the exact lie this change removes.
    await expect(repository.get("actor-a", "934145")).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(repository.listActive("actor-a")).resolves.toHaveLength(1);
  });

  it("closes the local row when Intuit says it never held the token", async () => {
    const { manager, repository } = await connectedManager(() => jsonResponse({}, { status: 400 }));

    await expect(manager.disconnectActiveConnection("actor-a")).resolves.toMatchObject({
      providerRevocation: "ALREADY_INVALID",
    });

    // Reported as a different fact, recorded in the same existing state: there
    // is no live grant either way, and a fourth status would need a migration.
    await expect(repository.get("actor-a", "934145")).resolves.toMatchObject({ status: "REVOKED" });
  });

  it("refuses to disconnect an actor with no connected company, and never calls Intuit", async () => {
    const { manager, revokeCalls } = await connectedManager(() => new Response("", { status: 200 }));

    await expect(manager.disconnectActiveConnection("actor-unknown"))
      .rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(revokeCalls).toEqual([]);
  });

  it("cannot be disconnected twice", async () => {
    const { manager } = await connectedManager(() => new Response("", { status: 200 }));

    await manager.disconnectActiveConnection("actor-a");
    await expect(manager.disconnectActiveConnection("actor-a"))
      .rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("stops the provider from serving a disconnected connection", async () => {
    const { manager } = await connectedManager(() => new Response("", { status: 200 }));

    await manager.disconnectActiveConnection("actor-a");

    await expect(manager.withProvider("actor-a", (provider) => provider.getCompany()))
      .rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });
});
