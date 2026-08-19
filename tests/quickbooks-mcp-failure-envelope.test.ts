import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, toSafeError } from "../src/errors.js";
import { createLegacySharedBearerRequestContext } from "../src/security/requestContext.js";
import { createQuickBooksMcpServer } from "../src/quickbooks/mcp.js";
import { quickBooksAccountingCaseBusinessIntakeSchema } from "../src/quickbooks/accountingCaseBusinessIntake.js";
import type { QuickBooksAccountingCaseService } from "../src/quickbooks/accountingCaseService.js";
import type { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import type { QuickBooksWorkflowService } from "../src/quickbooks/service.js";

const TARGET_SESSION_REF = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;

/** Minimal intake that satisfies the Agent-facing schema, so the handler runs. */
const VALID_INTAKE = {
  target_session_ref: TARGET_SESSION_REF,
  case_id: "case-envelope-001",
  expected_version: 0,
  source_set_complete: true,
  sources: [{
    source_key: "artifact-envelope-001",
    label: "Envelope contract test",
    units: [{
      unit_key: "unit-envelope-001",
      facts: [{
        kind: "EVIDENCE",
        evidence_role: "CONTROL_SUPPORT",
        note: "Failure envelope contract test.",
      }],
    }],
  }],
};

interface FailureEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    failure_layer: string;
    provider_mutation_possible: boolean;
    recovery_action: string;
    reason_codes?: string[];
    invalid_fields?: string[];
    details?: Record<string, unknown>;
  };
}

function envelope(result: unknown): FailureEnvelope {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("Expected MCP content array");
  }
  const first = result.content[0] as { text?: unknown } | undefined;
  if (!first || typeof first.text !== "string") throw new Error("Expected MCP text content");
  return JSON.parse(first.text) as FailureEnvelope;
}

describe("QuickBooks MCP failure envelope", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
  });

  async function caseClient() {
    const prepare = vi.fn();
    const service = {} as QuickBooksWorkflowService;
    const mutations = { capabilities: vi.fn().mockReturnValue({}) } as unknown as QuickBooksMutationService;
    const accountingCases = { prepare } as unknown as QuickBooksAccountingCaseService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "envelope-actor",
      audience: "https://agent2.zcloak.ai/quickbooks/mcp",
      scopes: ["quickbooks.read", "quickbooks.mutation.prepare", "quickbooks.mutation.execute"],
    });
    const server = createQuickBooksMcpServer(service, context, mutations, accountingCases);
    const client = new Client({ name: "qbo-failure-envelope-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const call = async () => envelope(await client.callTool({
      name: "quickbooks_prepare_accounting_case",
      arguments: VALID_INTAKE,
    }));
    return { prepare, call, client };
  }

  it("reports a schema failure as deterministic validation, never a retryable QuickBooks outage", async () => {
    // A handler-internal re-parse failure is deterministic: the same payload
    // fails forever. Before classification it surfaced as PROVIDER_ERROR with
    // retryable true, telling an Agent that QuickBooks was down.
    const zodError = quickBooksAccountingCaseBusinessIntakeSchema.safeParse({
      ...VALID_INTAKE,
      case_id: 17,
    }).error;
    const { prepare, call } = await caseClient();
    prepare.mockRejectedValueOnce(zodError);

    const payload = await call();

    expect(payload.error).toMatchObject({
      code: "VALIDATION_FAILED",
      retryable: false,
      failure_layer: "DETERMINISTIC_VALIDATION",
      recovery_action: "CORRECT_CASE_FACTS",
      provider_mutation_possible: false,
      reason_codes: ["REQUEST_SCHEMA_INVALID"],
      invalid_fields: ["case_id"],
    });
  });

  it("names the Agent's own nested request path in invalid_fields", async () => {
    const zodError = quickBooksAccountingCaseBusinessIntakeSchema.safeParse({
      ...VALID_INTAKE,
      sources: [{
        ...VALID_INTAKE.sources[0]!,
        units: [{
          unit_key: "unit-envelope-001",
          facts: [{
            kind: "DOCUMENT",
            document_type: "INVOICE",
            counterparty_name: "Blue Harbour Trading Pte Ltd",
            document_date: "2026-08-13",
            currency: "SGD",
            tax_mode: "NO_TAX",
            lines: [{
              description: "Monthly accounting support",
              quantity: "1",
              unit_amount: "800.00",
              source_tax_amount: "0.00",
              coding_type: "ITEM",
              coding_name: "Monthly accounting support",
              tax_code_name: "GST 9%",
            }],
            declared_net: "800.00",
            declared_tax: "0.00",
            declared_gross: "800.00",
            business_reason: "Nested path reporting test.",
          }],
        }],
      }],
    }).error;
    const { prepare, call } = await caseClient();
    prepare.mockRejectedValueOnce(zodError);

    const payload = await call();

    expect(payload.error.code).toBe("VALIDATION_FAILED");
    expect(payload.error.invalid_fields).toEqual([
      "sources[0].units[0].facts[0].lines[0].tax_code_name",
    ]);
    // Zod messages and submitted values never reach the Agent-facing envelope.
    expect(JSON.stringify(payload)).not.toContain("Blue Harbour");
  });

  it("keeps document values and Zod prose out of a classified schema failure", () => {
    const zodError = quickBooksAccountingCaseBusinessIntakeSchema.safeParse({
      ...VALID_INTAKE,
      case_id: "Lion City Digital Pte. Ltd.",
    }).error;

    const safe = toSafeError(zodError);

    expect(safe).toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 422, retryable: false });
    expect(JSON.stringify(safe.details)).not.toContain("Lion City Digital");
  });

  it("honours a recovery action chosen by the throw site", async () => {
    // The CONFLICT default is GET_CURRENT_CASE_STATUS. A throw site that knows
    // the owning request id must be able to say so without the envelope
    // overwriting it with generic advice.
    const { prepare, call } = await caseClient();
    prepare.mockRejectedValueOnce(new AppError("CONFLICT", "Another request owns this case version.", {
      httpStatus: 409,
      details: { recoveryAction: "RETRY_WITH_OWNING_REQUEST_ID", reasonCodes: ["CASE_VERSION_OWNED_ELSEWHERE"] },
    }));

    const payload = await call();

    expect(payload.error).toMatchObject({
      code: "CONFLICT",
      failure_layer: "CONCURRENCY_OR_VERSION",
      recovery_action: "RETRY_WITH_OWNING_REQUEST_ID",
      reason_codes: ["CASE_VERSION_OWNED_ELSEWHERE"],
    });
  });

  it("forwards an unregistered recovery action verbatim instead of degrading it", async () => {
    // Silently replacing an unrecognised value with the code's default hands the
    // Agent a different instruction from the one the throw site chose.
    const { prepare, call } = await caseClient();
    prepare.mockRejectedValueOnce(new AppError("VALIDATION_FAILED", "Refused.", {
      details: { failureLayer: "EXECUTION_FENCING", recoveryAction: "WAIT_FOR_ACTIVE_ATTEMPT_OR_STALE_RECONCILIATION" },
    }));

    const payload = await call();

    expect(payload.error).toMatchObject({
      failure_layer: "EXECUTION_FENCING",
      recovery_action: "WAIT_FOR_ACTIVE_ATTEMPT_OR_STALE_RECONCILIATION",
    });
  });

  it("stops calling the Agent's own mistakes a broken deployment", async () => {
    // These four used to be labelled CONFIGURATION, which tells an Agent the
    // installation is broken when the correct move is its own reference fix or
    // a new Case version.
    const cases = [
      ["NOT_FOUND", "RESOURCE", "VERIFY_RESOURCE_REFERENCE"],
      ["AMBIGUOUS_CONNECTION", "CONNECTION", "PIN_EXACT_QUICKBOOKS_COMPANY"],
      ["APPROVAL_REQUIRED", "LEGACY_AUTHORITY", "USE_STANDING_DELEGATION_CASE_FLOW"],
      ["APPROVAL_INVALID", "STALE_AUTHORITY", "PREPARE_NEW_CASE_VERSION"],
    ] as const;
    const { prepare, call } = await caseClient();

    for (const [code, layer, recovery] of cases) {
      prepare.mockRejectedValueOnce(new AppError(code, "Refused."));
      expect(await call()).toMatchObject({
        error: { code, failure_layer: layer, recovery_action: recovery },
      });
    }
  });

  it("gives provider and unknown-outcome codes distinct next moves", async () => {
    const cases = [
      ["RATE_LIMITED", "PROVIDER", "RETRY_WITH_BACKOFF"],
      ["PROVIDER_UNAVAILABLE", "PROVIDER", "RETRY_AFTER_PROVIDER_RECOVERS"],
      ["PROVIDER_ERROR", "PROVIDER", "INSPECT_PROVIDER_RESPONSE"],
      ["WRITE_RESULT_UNKNOWN", "PROVIDER_OUTCOME", "READBACK_RECOVERY_ONLY"],
      ["WRITE_RESULT_UNKNOWN_NO_ID", "PROVIDER_OUTCOME", "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM"],
      ["CONFIGURATION_ERROR", "CONFIGURATION", "FIX_MCP_CONFIGURATION"],
    ] as const;
    const { prepare, call } = await caseClient();

    const seen = new Set<string>();
    for (const [code, layer, recovery] of cases) {
      prepare.mockRejectedValueOnce(new AppError(code, "Refused."));
      const payload = await call();
      expect(payload.error).toMatchObject({ code, failure_layer: layer, recovery_action: recovery });
      seen.add(payload.error.recovery_action);
    }
    expect(seen.size).toBe(cases.length);
    expect(seen.has("INSPECT_ERROR_AND_STATUS")).toBe(false);
  });

  it("refuses the four document rules before the handler runs", async () => {
    const { prepare, client } = await caseClient();
    const result = await client.callTool({
      name: "quickbooks_prepare_accounting_case",
      arguments: {
        ...VALID_INTAKE,
        sources: [{
          source_key: "INV-2026-0702",
          label: "Sales tax invoice",
          units: [{
            unit_key: "invoice-main",
            facts: [{
              kind: "DOCUMENT",
              document_type: "INVOICE",
              counterparty_name: "Lion City Digital Pte. Ltd.",
              document_date: "2026-07-02",
              due_date: "2026-07-01",
              currency: "SGD",
              tax_mode: "NO_TAX",
              lines: [{
                description: "Consulting services",
                quantity: "20",
                unit_amount: "200.00",
                source_tax_amount: "0.00",
                coding_type: "ACCOUNT",
                coding_name: "Consulting",
                tax_code_name: "GST 9%",
              }],
              declared_net: "4000.00",
              declared_tax: "0.00",
              declared_gross: "4000.00",
              business_reason: "Pre-handler refusal test.",
            }],
          }],
        }],
      },
    });
    // The SDK validates the Agent-facing schema before dispatch, so these never
    // reach the handler's re-parse against internal camelCase names. All three
    // reachable rules are named at once, on the paths the Agent itself sent.
    // (NO_TAX and the taxable-line rule cannot both fire on one document.)
    expect(prepare).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("sources[0].units[0].facts[0].due_date");
    expect(text).toContain("sources[0].units[0].facts[0].lines[0].coding_type");
    expect(text).toContain("sources[0].units[0].facts[0].lines[0].tax_code_name");
    expect(text).not.toContain("Lion City Digital");
  });

  it("keeps provider_mutation_possible tied to the unknown-write codes only", async () => {
    const { prepare, call } = await caseClient();
    prepare.mockRejectedValueOnce(new AppError("WRITE_RESULT_UNKNOWN", "Outcome unknown."));
    expect((await call()).error.provider_mutation_possible).toBe(true);
    prepare.mockRejectedValueOnce(new AppError("PROVIDER_ERROR", "Upstream failed."));
    expect((await call()).error.provider_mutation_possible).toBe(false);
  });
});
