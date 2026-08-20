import { QuickBooksApiClient } from "../../src/providers/quickbooksClient.js";

/**
 * Produce the exact error a real write raises, by driving the real QuickBooks
 * client against a stubbed transport.
 *
 * Hand-writing the completed-response evidence marker inside a test would let
 * the client stop emitting it without any test noticing — and that marker is
 * the only thing standing between "the Provider provably refused" and "the
 * write may have landed". So the tests go through the client.
 */
export async function quickBooksWriteFailure(
  transport: () => Promise<Response> | never,
  realmId = "9341457701636490",
): Promise<unknown> {
  const client = new QuickBooksApiClient({
    realmId,
    environment: "sandbox",
    tokenSource: {
      accessToken: async () => "access-old",
      refreshAccessToken: async () => "access-new",
    },
    request: (async () => transport()) as unknown as typeof fetch,
  });
  try {
    await client.request("/bill", {
      method: "POST",
      body: { VendorRef: { value: "63" }, CurrencyRef: { value: "SGD" } },
      requestId: "zc.bill.sgd",
      isWrite: true,
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the stubbed provider write to fail");
}

/** An Intuit Fault body, as returned with a completed refusal. */
export function quickBooksFaultResponse(
  status: number,
  code = "6000",
  element = "CurrencyRef",
  intuitTid?: string,
): Response {
  return new Response(JSON.stringify({ Fault: { Error: [{ code, element }], type: "ValidationFault" } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(intuitTid ? { intuit_tid: intuitTid } : {}),
    },
  });
}
