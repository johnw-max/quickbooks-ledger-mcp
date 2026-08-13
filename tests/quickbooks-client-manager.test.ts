import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logging.js";
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
