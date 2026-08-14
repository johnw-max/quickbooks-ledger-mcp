import { describe, expect, it, vi } from "vitest";
import type { QuickBooksClientManager } from "../src/quickbooks/clientManager.js";
import { ServerBoundQuickBooksProviderResolver } from "../src/quickbooks/providerResolver.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";
import { QuickBooksTargetSessionService } from "../src/quickbooks/targetSession.js";
import { AppError } from "../src/errors.js";

describe("QuickBooks provider resolver connection management", () => {
  it("returns a one-time Intuit link for replacing an already connected company", async () => {
    const manager = {
      resolveSingleConnection: vi.fn().mockResolvedValue({
        connectionId: "qbc-a",
        realmId: "934145",
        companyName: "Sandbox Company A",
        grantedScopes: ["com.intuit.quickbooks.accounting"],
      }),
    } as unknown as QuickBooksClientManager;
    const resolver = new ServerBoundQuickBooksProviderResolver({
      manager,
      connectUrl: vi.fn().mockResolvedValue({
        url: "https://quickbooks-mcp.example.test/connect/quickbooks?ticket=one-time",
        expiresAt: new Date("2026-08-06T02:30:00.000Z"),
      }),
    });

    await expect(resolver.connectionStatus("actor-a")).resolves.toMatchObject({
      connected: true,
      company: { realmId: "934145", name: "Sandbox Company A" },
      scopes: ["com.intuit.quickbooks.accounting"],
      connectUrl: "https://quickbooks-mcp.example.test/connect/quickbooks?ticket=one-time",
      connectUrlExpiresAt: "2026-08-06T02:30:00.000Z",
      connectAction: "REPLACE_CURRENT_COMPANY",
      connectionRefSafe: expect.stringMatching(/^quickbooks-connection:[a-f0-9]{32}$/),
      boundTargetRefSafe: expect.stringMatching(/^quickbooks-target:[a-f0-9]{32}$/),
      bindingRevision: expect.stringMatching(/^quickbooks-binding-revision:[a-f0-9]{32}$/),
    });
  });

  it("pins reads to one exact active Company and invalidates the session after replacement", async () => {
    const connection = {
      connectionId: "qbc-a",
      actorId: "actor-a",
      realmId: "934145",
      companyName: "Sandbox Company A",
      grantedScopes: ["com.intuit.quickbooks.accounting"],
      tokenCiphertext: "not-used",
      accessTokenExpiresAt: new Date("2026-08-12T13:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2026-11-12T13:00:00.000Z"),
      refreshVersion: 0,
      status: "ACTIVE" as const,
      createdAt: new Date("2026-08-12T12:00:00.000Z"),
      updatedAt: new Date("2026-08-12T12:00:00.000Z"),
    };
    const resolveBoundConnection = vi.fn().mockResolvedValue(connection);
    const manager = {
      resolveSingleConnection: vi.fn().mockResolvedValue(connection),
      resolveBoundConnection,
    } as unknown as QuickBooksClientManager;
    const resolver = new ServerBoundQuickBooksProviderResolver({
      manager,
      targetSessions: new QuickBooksTargetSessionService({
        cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 9)),
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      }),
    });

    const target = await resolver.issueTargetSession("actor-a");
    await expect(resolver.resolve("actor-a", target.targetSessionRef)).resolves.toMatchObject({
      realmId: "934145",
      companyName: "Sandbox Company A",
      bindingRevision: target.bindingRevision,
    });
    expect(resolveBoundConnection).toHaveBeenCalledWith("actor-a", "qbc-a", "934145");

    resolveBoundConnection.mockRejectedValueOnce(new AppError("FORBIDDEN", "Company replaced", { httpStatus: 409 }));
    await expect(resolver.resolve("actor-a", target.targetSessionRef)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("reports stored provider-scope denial without inventing an Intuit role", async () => {
    const connection = {
      connectionId: "qbc-a",
      actorId: "actor-a",
      realmId: "934145",
      companyName: "Sandbox Company A",
      grantedScopes: [],
      tokenCiphertext: "not-used",
      accessTokenExpiresAt: new Date("2026-08-12T13:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2026-11-12T13:00:00.000Z"),
      refreshVersion: 0,
      status: "ACTIVE" as const,
      createdAt: new Date("2026-08-12T12:00:00.000Z"),
      updatedAt: new Date("2026-08-12T12:00:00.000Z"),
    };
    const manager = { resolveSingleConnection: vi.fn().mockResolvedValue(connection) } as unknown as QuickBooksClientManager;
    const resolver = new ServerBoundQuickBooksProviderResolver({ manager });

    await expect(resolver.resolve("actor-a")).resolves.toMatchObject({
      providerAccessDenyReasons: ["INTUIT_ACCOUNTING_SCOPE_MISSING"],
    });
  });
});
