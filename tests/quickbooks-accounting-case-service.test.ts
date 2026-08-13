import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../src/security/requestContext.js";
import { QuickBooksAccountingCaseService } from "../src/quickbooks/accountingCaseService.js";
import { quickBooksPrepareAccountingCaseSchema } from "../src/quickbooks/accountingCaseSchemas.js";
import { InMemoryQuickBooksAccountingCaseRepository } from "../src/quickbooks/inMemoryAccountingCaseRepository.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../src/quickbooks/service.js";

const targetSessionRef = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
const now = new Date("2026-08-13T04:00:00.000Z");
const context: RequestContext = {
  requestId: "request-1",
  actorId: "ws-1:user:user-1",
  workspaceId: "ws-1",
  subjectType: "USER",
  subjectId: "user-1",
  userId: "user-1",
  agentId: "agent-1",
  oauthInstallationId: "inst-1",
  bindingId: "binding-1",
  connectionId: "connection-1",
  bindingRevision: 1,
  scopes: ["quickbooks.read", "quickbooks.mutation.prepare", "quickbooks.mutation.execute"],
  roles: [],
  authn: { issuer: "test", subject: "user:user-1", audience: "https://mcp.test", tokenId: "token-1" },
  legacyDemo: false,
};

const input = quickBooksPrepareAccountingCaseSchema.parse({
  target_session_ref: targetSessionRef,
  case_id: "case-invoice-001",
  expected_version: 0,
  sources: [{ artifactId: "invoice.pdf", label: "Customer invoice", units: [{ unitId: "page-1", expectedFactKinds: ["NATIVE_DOCUMENT"] }] }],
  facts: [{
    factId: "invoice-v1", lineageKey: "invoice", eventKey: "invoice", sourceUnitIds: ["page-1"],
    origin: "MODEL_EXTRACTED", revision: 1, kind: "NATIVE_DOCUMENT", documentType: "INVOICE",
    counterpartyName: "Harbour Kitchen", documentDate: "2026-08-10", documentNumber: "INV-1001",
    currency: "SGD", taxMode: "NO_TAX",
    lines: [{ lineId: "line-1", description: "Bookkeeping services", quantity: "1", unitAmount: "100.00", sourceTax: "0.00", codingType: "ITEM", codingName: "Bookkeeping" }],
    declaredNet: "100.00", declaredTax: "0.00", declaredGross: "100.00",
    businessReason: "Record approved monthly bookkeeping services.",
  }],
});

function fixture(options: {
  writeEnabled?: boolean;
  delegationActions?: string[];
  unknown?: boolean;
  customerInitiallyMissing?: boolean;
} = {}) {
  let customerExists = !options.customerInitiallyMissing;
  const executeMutation = vi.fn(async (mutation: { entity: string }) => {
    if (options.unknown) {
      const error = Object.assign(new Error("unknown"), { code: "WRITE_RESULT_UNKNOWN", httpStatus: 503, retryable: false });
      throw error;
    }
    if (mutation.entity === "Customer") customerExists = true;
    const providerEntityId = mutation.entity === "Customer" ? "12" : "9001";
    return { providerEntityId, receipt: { requestId: "provider-1" }, readback: { Id: providerEntityId, TotalAmt: 100 } };
  });
  const provider = {
    getCompanyContext: vi.fn(async () => ({ CompanyName: "Sandbox", HomeCurrency: { value: "SGD" } })),
    searchCustomers: vi.fn(async () => ({
      records: customerExists ? [{ Id: "12", DisplayName: "Harbour Kitchen", Active: true }] : [],
      searchWindow: {},
    })),
    searchVendors: vi.fn(async () => ({ records: [], searchWindow: {} })),
    listItems: vi.fn(async () => [{ Id: "21", Name: "Bookkeeping", Active: true }]),
    listAccounts: vi.fn(async () => []),
    listTaxCodes: vi.fn(async () => []),
    getMutationTarget: vi.fn(),
    executeMutation,
  } as unknown as QuickBooksProviderCapabilities;
  const resolver: QuickBooksProviderResolver = {
    connectionStatus: vi.fn(),
    resolve: vi.fn(async () => ({
      realmId: "9341457701636490", companyName: "Sandbox", connectionRefSafe: "qbc-safe",
      boundTargetRefSafe: "qbt-safe", bindingRevision: "quickbooks-binding-revision:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetSessionId: "target-session-1", targetSessionExpiresAt: new Date("2026-08-13T04:15:00.000Z"), provider,
    })),
  };
  const mutations = new QuickBooksMutationService(
    new InMemoryQuickBooksMutationRepository(), resolver,
    {
      writeEnabled: options.writeEnabled ?? true,
      writeTargetMode: "exact_allowlist",
      allowedRealmId: "9341457701636490",
      publicBaseUrl: "https://mcp.test",
      standingDelegationProvider: async () => [{
        delegationId: "delegation-1", revision: 1, status: "ACTIVE", providerId: "quickbooks",
        workspaceId: "ws-1", agentId: "agent-1", installationId: "inst-1",
        tenantIds: ["9341457701636490"], actionIds: options.delegationActions ?? ["invoice.create"],
      }],
    },
  );
  const repository = new InMemoryQuickBooksAccountingCaseRepository();
  const service = new QuickBooksAccountingCaseService(repository, resolver, mutations, { clock: () => now });
  return { service, repository, executeMutation };
}

describe("QuickBooks Accounting Case service", () => {
  it("prepares without writing, then auto-executes under standing delegation and exact readback", async () => {
    const { service, executeMutation } = fixture();
    const prepared = await service.prepare(context, input);
    expect(prepared).toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      completion_claim: { ledger_write_claim: "NOT_WRITTEN" },
      operations: [{ state: "PENDING" }],
    });
    expect(executeMutation).not.toHaveBeenCalled();

    const executed = await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-1",
    });
    expect(executed).toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "READBACK_VERIFIED", provider_entity_id: "9001", authorization_receipt_recorded: true }],
      completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);

    const replay = await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-1",
    });
    expect(replay.completion_claim.ledger_write_claim).toBe("ALL_ELIGIBLE_WRITES_READBACK_VERIFIED");
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("fails closed when delegation does not grant the exact action", async () => {
    const { service, executeMutation } = fixture({ delegationActions: ["vendor.create_basic"] });
    await service.prepare(context, input);
    await expect(service.execute(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-denied",
    })).rejects.toMatchObject({ code: "FORBIDDEN", details: { failureLayer: "STANDING_DELEGATION" } });
    expect(executeMutation).not.toHaveBeenCalled();
  });

  it("does not allow a second case version to mutate a terminal version", async () => {
    const { service } = fixture();
    await service.prepare(context, input);
    await service.execute(context, { target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-v1" });
    const corrected = structuredClone(input);
    corrected.expected_version = 1;
    corrected.facts = [{ ...corrected.facts[0], factId: "invoice-v2", revision: 2, supersedesFactId: "invoice-v1", declaredNet: "120.00", declaredGross: "120.00", lines: [{ ...corrected.facts[0].lines[0], unitAmount: "120.00" }] }];
    const v2 = await service.prepare(context, corrected);
    expect(v2.case_version).toBe(2);
    const v1 = await service.status(context, { target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1 });
    expect(v1.operations[0]?.provider_entity_id).toBe("9001");
  });

  it("stages a new contact before its document, then avoids duplicating the contact in the next Case version", async () => {
    const { service, executeMutation } = fixture({
      customerInitiallyMissing: true,
      delegationActions: ["customer.create_basic", "invoice.create"],
    });
    const staged = structuredClone(input);
    staged.case_id = "case-new-customer-001";
    staged.sources[0]?.units.push({ unitId: "contact-1", expectedFactKinds: ["CONTACT_CANDIDATE"] });
    staged.facts.push({
      factId: "customer-v1",
      lineageKey: "customer",
      eventKey: "customer",
      sourceUnitIds: ["contact-1"],
      origin: "AGENT_ASSERTED",
      revision: 1,
      kind: "CONTACT_CANDIDATE",
      role: "CUSTOMER",
      displayName: "Harbour Kitchen",
    });

    const v1 = await service.prepare(context, staged);
    expect(v1).toMatchObject({
      state: "PLANNED_WITH_EXCEPTIONS",
      operations: [{ entity: "Customer", state: "PENDING" }],
    });
    expect(v1.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "INVOICE", disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_NOT_FOUND"] }),
    ]));
    await service.execute(context, {
      target_session_ref: targetSessionRef,
      case_id: staged.case_id,
      case_version: 1,
      request_id: "execute-contact-v1",
    });

    staged.expected_version = 1;
    const v2 = await service.prepare(context, staged);
    expect(v2).toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      operations: [{ entity: "Invoice", state: "PENDING" }],
    });
    expect(v2.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "CONTACT_CREATE", disposition: "EVIDENCE_ONLY", reason_codes: ["CONTACT_ALREADY_EXISTS"] }),
    ]));
    await service.execute(context, {
      target_session_ref: targetSessionRef,
      case_id: staged.case_id,
      case_version: 2,
      request_id: "execute-invoice-v2",
    });
    expect(executeMutation.mock.calls.map(([mutation]) => mutation.entity)).toEqual(["Customer", "Invoice"]);
  });

  it("blocks a foreign-currency document when QuickBooks multi-currency is disabled", async () => {
    const { service } = fixture();
    const foreign = structuredClone(input);
    foreign.case_id = "case-foreign-currency-001";
    foreign.facts[0].currency = "USD";

    const prepared = await service.prepare(context, foreign);
    expect(prepared).toMatchObject({
      state: "BLOCKED_VALIDATION",
      operations: [],
    });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "BLOCKED_VALIDATION", reason_codes: ["MULTI_CURRENCY_DISABLED"] }),
    ]));
  });
});
