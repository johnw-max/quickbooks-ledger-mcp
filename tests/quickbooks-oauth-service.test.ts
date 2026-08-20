import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryQuickBooksControlRepository } from "../src/quickbooks/inMemoryControlRepository.js";
import type { QuickBooksClientManager } from "../src/quickbooks/clientManager.js";
import { QuickBooksOAuthService } from "../src/quickbooks/oauthService.js";
import { resetQuickBooksOAuthDiscovery } from "../src/providers/quickbooksOAuth.js";
import { intuitCalls, intuitOAuthTransport, intuitTokenResponse } from "./helpers/intuitOAuthTransport.js";

describe("QuickBooks OAuth service", () => {
  beforeEach(() => {
    resetQuickBooksOAuthDiscovery();
  });

  it("binds a one-time browser state to the actor and saves the verified realm connection", async () => {
    const states = new InMemoryQuickBooksControlRepository();
    const connect = vi.fn().mockResolvedValue({
      actorId: "actor-a",
      realmId: "934145",
      companyName: "Sandbox Company",
      grantedScopes: ["com.intuit.quickbooks.accounting"],
    });
    const request = intuitOAuthTransport({ token: () => intuitTokenResponse() });
    const service = new QuickBooksOAuthService({
      states,
      manager: { connect } as unknown as QuickBooksClientManager,
      config: {
        clientId: "client-a",
        clientSecret: "secret-a",
        redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
        environment: "sandbox",
        request,
      },
    });
    const browserSession = "browser-session-a";
    const consent = new URL(await service.start("actor-a", browserSession));
    const state = consent.searchParams.get("state");
    expect(state).toHaveLength(43);

    const result = await service.callback({
      state: state as string,
      browserSession,
      code: "authorization-code-a",
      realmId: "934145",
    });

    expect(result).toEqual({
      actorId: "actor-a",
      realmId: "934145",
      companyName: "Sandbox Company",
      scopes: ["com.intuit.quickbooks.accounting"],
    });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "actor-a",
      realmId: "934145",
      token: expect.objectContaining({ accessToken: "access-a", refreshToken: "refresh-a" }),
    }));

    await expect(service.callback({
      state: state as string,
      browserSession,
      code: "authorization-code-replay",
      realmId: "934145",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(connect).toHaveBeenCalledOnce();
  });

  it("rejects a callback from a different browser session before token exchange", async () => {
    const states = new InMemoryQuickBooksControlRepository();
    const request = intuitOAuthTransport();
    const service = new QuickBooksOAuthService({
      states,
      manager: { connect: vi.fn() } as unknown as QuickBooksClientManager,
      config: {
        clientId: "client-a",
        clientSecret: "secret-a",
        redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
        environment: "sandbox",
        request,
      },
    });
    const consent = new URL(await service.start("actor-a", "browser-session-a"));

    await expect(service.callback({
      state: consent.searchParams.get("state") as string,
      browserSession: "browser-session-b",
      code: "authorization-code-a",
      realmId: "934145",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Discovery may run while building the consent URL; no token exchange may.
    expect(intuitCalls(request, "/oauth2/v1/tokens/bearer")).toHaveLength(0);
  });
});
