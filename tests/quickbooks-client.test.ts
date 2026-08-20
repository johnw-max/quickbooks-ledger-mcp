import { describe, expect, it, vi } from "vitest";
import { QuickBooksApiClient } from "../src/providers/quickbooksClient.js";

interface CapturedFailure {
  code: string;
  details?: Record<string, unknown>;
}

/** Await a request that must reject, and return the error typed for assertions. */
async function failure(pending: Promise<unknown>): Promise<CapturedFailure> {
  return pending.then(
    () => { throw new Error("expected the provider request to fail"); },
    (error: unknown) => error as CapturedFailure,
  );
}

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

  it.each([400, 401, 403, 404, 409, 429, 500] as const)(
    "carries completed-response evidence for provider HTTP %i",
    async (status) => {
      // A fresh Response per call: a 401 is retried once after refresh, and a
      // body can only be read once.
      const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        Fault: { Error: [{ code: "6000", element: "CurrencyRef" }] },
      }), { status, headers: { "Content-Type": "application/json" } }));
      const client = new QuickBooksApiClient({
        realmId: "123",
        environment: "sandbox",
        tokenSource: tokenSource(),
        request,
      });

      // Read path, so a 5xx still returns the parsed refusal rather than the
      // write-specific unknown-outcome error.
      await expect(client.request("/companyinfo/123")).rejects.toMatchObject({
        details: {
          providerResponseCompleted: true,
          providerHttpStatus: status,
          providerErrors: [{ code: "6000", element: "CurrencyRef" }],
        },
      });
    },
  );

  it("never claims a completed response for a transport failure or a timeout", async () => {
    for (const transportError of [new Error("connection reset"), new DOMException("timed out", "TimeoutError")]) {
      const client = new QuickBooksApiClient({
        realmId: "123",
        environment: "sandbox",
        tokenSource: tokenSource(),
        request: vi.fn().mockRejectedValue(transportError),
      });

      const write = await failure(client.request("/bill", {
        method: "POST", body: { VendorRef: { value: "9" } }, requestId: "zc:bill:123", isWrite: true,
      }));
      expect(write.code).toBe("WRITE_RESULT_UNKNOWN");
      expect(write.details?.providerWriteOutcome).toBe("UNKNOWN");
      expect(write.details?.providerResponseCompleted).toBeUndefined();
      expect(write.details?.providerHttpStatus).toBeUndefined();

      const read = await failure(client.request("/companyinfo/123"));
      expect(read.code).toBe("PROVIDER_UNAVAILABLE");
      expect(read.details?.providerResponseCompleted).toBeUndefined();
    }
  });

  it("never claims a completed response for a 5xx write whose outcome is unknown", async () => {
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockResolvedValue(new Response(JSON.stringify({ Fault: { Error: [] } }), {
        status: 500, headers: { "Content-Type": "application/json" },
      })),
    });

    const error = await failure(client.request("/bill", {
      method: "POST", body: { VendorRef: { value: "9" } }, requestId: "zc:bill:123", isWrite: true,
    }));
    expect(error.code).toBe("WRITE_RESULT_UNKNOWN");
    expect(error.details?.providerWriteOutcome).toBe("UNKNOWN");
    expect(error.details?.providerResponseCompleted).toBeUndefined();
    expect(error.details?.providerMutationPossible).toBe(true);
  });

  it.each([
    [400, "CONFIRMED_NOT_WRITTEN"],
    [401, "CONFIRMED_NOT_WRITTEN"],
    [403, "CONFIRMED_NOT_WRITTEN"],
    [404, "CONFIRMED_NOT_WRITTEN"],
    [409, "UNKNOWN"],
    [429, "UNKNOWN"],
  ] as const)("decides the write outcome for a %i Intuit Fault as %s", async (status, outcome) => {
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        Fault: { Error: [{ code: "6000", element: "CurrencyRef" }], type: "ValidationFault" },
      }), { status, headers: { "Content-Type": "application/json" } })),
    });

    const error = await failure(client.request("/bill", {
      method: "POST", body: { VendorRef: { value: "63" } }, requestId: "zc:bill:123", isWrite: true,
    }));
    expect(error.details?.providerWriteOutcome).toBe(outcome);
    expect(error.details?.providerFaultRecognised).toBe(true);
  });

  it("never confirms a non-write from a status with no Intuit Fault body", async () => {
    // A gateway, proxy or WAF answering 403 is not Intuit speaking: the request
    // may never have reached the accounting engine, or may have been applied
    // before the intermediary rewrote the response.
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockImplementation(async () => new Response("<html>Forbidden</html>", {
        status: 403, headers: { "Content-Type": "text/html" },
      })),
    });

    const error = await failure(client.request("/bill", {
      method: "POST", body: { VendorRef: { value: "63" } }, requestId: "zc:bill:123", isWrite: true,
    }));
    expect(error.details?.providerFaultRecognised).toBe(false);
    expect(error.details?.providerWriteOutcome).toBe("UNKNOWN");
  });

  it("never confirms a non-write from the multipart upload endpoint", async () => {
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        Fault: { Error: [{ code: "5010", element: "file" }], type: "ValidationFault" },
      }), { status: 400, headers: { "Content-Type": "application/json" } })),
    });

    const error = await failure(client.request("/upload", {
      method: "POST", multipart: new FormData(), requestId: "zc:attach:123", isWrite: true,
    }));
    expect(error.details?.providerFaultRecognised).toBe(true);
    expect(error.details?.providerWriteOutcome).toBe("UNKNOWN");
  });

  it("stamps no write outcome on a read", async () => {
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        Fault: { Error: [{ code: "6000" }] },
      }), { status: 400, headers: { "Content-Type": "application/json" } })),
    });

    const error = await failure(client.request("/companyinfo/123"));
    expect(error.details?.providerWriteOutcome).toBeUndefined();
  });
  it("carries Intuit's trace id on a completed failure, and omits it when Intuit sent none", async () => {
    const traced = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        Fault: { Error: [{ code: "6000" }] },
      }), { status: 400, headers: { "Content-Type": "application/json", intuit_tid: "1-64a1-abcdef" } })),
    });
    const untraced = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        Fault: { Error: [{ code: "6000" }] },
      }), { status: 400, headers: { "Content-Type": "application/json" } })),
    });

    expect((await failure(traced.request("/companyinfo/123"))).details?.intuitTid).toBe("1-64a1-abcdef");
    // Absent, not an empty string or a placeholder: "Intuit told us nothing"
    // and "Intuit told us this" must never read the same in a receipt.
    expect((await failure(untraced.request("/companyinfo/123"))).details).not.toHaveProperty("intuitTid");
  });

  it("keeps Intuit's trace id on an unknown write outcome, where it is worth the most", async () => {
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockImplementation(async () => new Response("{}", {
        status: 500,
        headers: { "Content-Type": "application/json", intuit_tid: "1-64a1-fedcba" },
      })),
    });

    const error = await failure(client.request("/bill", {
      method: "POST", body: { VendorRef: { value: "9" } }, requestId: "zc:bill:123", isWrite: true,
    }));
    expect(error.code).toBe("WRITE_RESULT_UNKNOWN");
    expect(error.details).toMatchObject({ providerWriteOutcome: "UNKNOWN", intuitTid: "1-64a1-fedcba" });
  });

  it("reports Intuit's trace id for a successful response, and refuses an unusable header", async () => {
    const traces: string[] = [];
    const client = (intuitTid: string) => new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        CompanyInfo: { Id: "123" },
      }), { status: 200, headers: { "Content-Type": "application/json", intuit_tid: intuitTid } })),
    });

    await client("1-64a1-abcdef").request("/companyinfo/123", {
      onIntuitTrace: (intuitTid) => traces.push(intuitTid),
    });
    // Upstream-controlled and headed for logs and durable receipts, so it is
    // bounded and printable-ASCII or it is not reported at all.
    await client("x".repeat(129)).request("/companyinfo/123", {
      onIntuitTrace: (intuitTid) => traces.push(intuitTid),
    });

    expect(traces).toEqual(["1-64a1-abcdef"]);
  });

  it("does not fail a request because Intuit sent no trace id", async () => {
    const client = new QuickBooksApiClient({
      realmId: "123",
      environment: "sandbox",
      tokenSource: tokenSource(),
      request: vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        CompanyInfo: { Id: "123", CompanyName: "Sandbox" },
      }), { status: 200, headers: { "Content-Type": "application/json" } })),
    });
    const traces: string[] = [];

    await expect(client.request<{ CompanyInfo: { CompanyName: string } }>("/companyinfo/123", {
      onIntuitTrace: (intuitTid) => traces.push(intuitTid),
    })).resolves.toMatchObject({ CompanyInfo: { CompanyName: "Sandbox" } });
    expect(traces).toEqual([]);
  });
});
