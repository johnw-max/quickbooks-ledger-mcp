import { describe, expect, it, vi } from "vitest";
import { QuickBooksApiClient } from "../src/providers/quickbooksClient.js";

function tokenSource() {
  return {
    accessToken: vi.fn().mockResolvedValue("access-old"),
    refreshAccessToken: vi.fn().mockResolvedValue("access-new"),
  };
}

describe("QuickBooks API client", () => {
  it("refreshes once on 401 and keeps the exact bound realm", async () => {
    const tokens = tokenSource();
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Fault: { Error: [] } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ CompanyInfo: { Id: "123", CompanyName: "Sandbox" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokens,
      request,
      minorVersion: 75,
    });

    const result = await client.request<{ CompanyInfo: { CompanyName: string } }>("/companyinfo/123");

    expect(result.CompanyInfo.CompanyName).toBe("Sandbox");
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://sandbox-quickbooks.api.intuit.com/v3/company/123/companyinfo/123?minorversion=75",
    );
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer access-new" });
  });

  it("marks a network-interrupted write as unknown instead of claiming failure", async () => {
    const request = vi.fn().mockRejectedValue(new Error("connection reset"));
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request,
    });

    await expect(client.request("/bill", {
      method: "POST",
      body: { VendorRef: { value: "9" } },
      requestId: "zc:bill:123",
      isWrite: true,
    })).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
      details: { requestId: "zc:bill:123" },
    });
  });

  it("returns only allowlisted provider fault identifiers without reflecting upstream messages", async () => {
    const secret = "access-secret refresh-secret client-secret";
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Fault: { Error: [{ code: "6000", Message: secret, Detail: secret }] },
      secret_debug_blob: "must-not-escape",
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request,
    });

    const error = await client.request("/bill/404").catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        providerErrors: [{ code: "6000" }],
      },
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it.each([
    [401, "NOT_CONNECTED", false],
    [403, "FORBIDDEN", false],
    [429, "RATE_LIMITED", true],
    [503, "PROVIDER_UNAVAILABLE", true],
  ] as const)("classifies provider HTTP %i as %s", async (status, code, retryable) => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Fault: { Error: [] } }), {
      status,
      headers: { "Content-Type": "application/json" },
    }));
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request,
    });

    await expect(client.request("/companyinfo/123")).rejects.toMatchObject({ code, retryable });
  });

  it("classifies an unreachable provider read as temporarily unavailable", async () => {
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockRejectedValue(new Error("network down")),
    });
    await expect(client.request("/companyinfo/123")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
  });
});
