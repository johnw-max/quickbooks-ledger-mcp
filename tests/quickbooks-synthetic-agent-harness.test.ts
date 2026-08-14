import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  SyntheticQuickBooksProvider,
  SYNTHETIC_QUICKBOOKS_REALM_ID,
} from "../harness/lib/syntheticQuickBooksProvider.js";
import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS, QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES } from "../src/quickbooks/accountingCase.js";
import { QuickBooksAccountingCaseService } from "../src/quickbooks/accountingCaseService.js";
import { InMemoryQuickBooksAccountingCaseRepository } from "../src/quickbooks/inMemoryAccountingCaseRepository.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import { InMemoryQuickBooksPostingRepository } from "../src/quickbooks/inMemoryRepository.js";
import { createQuickBooksMcpServer } from "../src/quickbooks/mcp.js";
import { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import type { QuickBooksProviderResolver } from "../src/quickbooks/service.js";
import { QuickBooksWorkflowService } from "../src/quickbooks/service.js";
import { createOAuthRequestContext, type ResolvedMcpAccessToken } from "../src/security/requestContext.js";
import type { QuickBooksProviderMutationCommand } from "../src/security/quickBooksProviderWritePermit.js";
import type { QuickBooksWritableEntity } from "../src/quickbooks/writePolicy.js";
import { issueQuickBooksProviderWriteTestPermit } from "./helpers/quickBooksProviderWritePermit.js";

const TARGET_SESSION_REF = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
const COMPANY_NAME = "zCloak Accounting Sandbox Pte Ltd";
const BINDING_REVISION = "quickbooks-binding-revision:synthetic-contract-v1";

function resultText(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("MCP result must be an object");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("MCP result content must be an array");
  const first = content[0];
  if (!first || typeof first !== "object" || Array.isArray(first) || typeof (first as { text?: unknown }).text !== "string") {
    throw new Error("MCP result must contain one text block");
  }
  return (first as { text: string }).text;
}

function payloadFor(entity: QuickBooksWritableEntity): Record<string, unknown> {
  if (entity === "Customer") return { DisplayName: "Synthetic Customer UAT" };
  if (entity === "Vendor") return { DisplayName: "Synthetic Vendor UAT" };
  const salesSide = entity === "Invoice" || entity === "CreditMemo";
  return {
    [salesSide ? "CustomerRef" : "VendorRef"]: { value: salesSide ? "91" : "56" },
    TxnDate: "2026-08-13",
    DocNumber: `SYN-${entity}-001`,
    CurrencyRef: { value: "SGD" },
    Line: [{ Amount: 100, Description: `Synthetic ${entity} contract write` }],
  };
}

function executeSyntheticMutation(
  provider: SyntheticQuickBooksProvider,
  command: QuickBooksProviderMutationCommand,
) {
  return provider.executeMutation(
    command,
    issueQuickBooksProviderWriteTestPermit(command, SYNTHETIC_QUICKBOOKS_REALM_ID),
    async () => undefined,
    async () => undefined,
  );
}

describe("QuickBooks synthetic provider contract harness", () => {
  it("supports all six released Case entities with stateful exact readback and request-id idempotency", async () => {
    const provider = new SyntheticQuickBooksProvider();
    const entities = ["Customer", "Vendor", "Invoice", "Bill", "CreditMemo", "VendorCredit"] as const;
    const results = new Map<QuickBooksWritableEntity, Awaited<ReturnType<SyntheticQuickBooksProvider["executeMutation"]>>>();

    for (const entity of entities) {
      const result = await executeSyntheticMutation(provider, {
        entity,
        operation: "CREATE",
        payload: payloadFor(entity),
        requestId: `synthetic-contract-${entity}`,
      });
      results.set(entity, result);
      await expect(provider.getMutationTarget(entity, result.providerEntityId)).resolves.toEqual(result.readback);
      expect(result.receipt).toMatchObject({
        provider: "synthetic-quickbooks-online",
        entity,
        operation: "CREATE",
        providerEntityId: result.providerEntityId,
        verified: true,
        verification: "EXACT_ID_READBACK",
      });
    }

    expect(provider.mutationCount).toBe(6);
    expect(provider.mutationRequestCount()).toBe(6);
    const invoice = results.get("Invoice");
    if (!invoice) throw new Error("test fixture requires an Invoice result");
    const replay = await executeSyntheticMutation(provider, {
      entity: "Invoice",
      operation: "CREATE",
      payload: payloadFor("Invoice"),
      requestId: "synthetic-contract-Invoice",
    });
    expect(replay).toEqual(invoice);
    expect(provider.mutationCount).toBe(6);
    await expect(executeSyntheticMutation(provider, {
      entity: "Invoice",
      operation: "CREATE",
      payload: { ...payloadFor("Invoice"), DocNumber: "SUBSTITUTED" },
      requestId: "synthetic-contract-Invoice",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.mutationCount).toBe(6);
  });

  it("supports optimistic update readback for released entities", async () => {
    const provider = new SyntheticQuickBooksProvider();
    const created = await executeSyntheticMutation(provider, {
      entity: "Customer",
      operation: "CREATE",
      payload: { DisplayName: "Before Update" },
      requestId: "synthetic-update-create",
    });
    const updated = await executeSyntheticMutation(provider, {
      entity: "Customer",
      operation: "UPDATE",
      targetId: created.providerEntityId,
      syncToken: "0",
      payload: { DisplayName: "After Update" },
      requestId: "synthetic-update-change",
    });
    expect(updated.readback).toMatchObject({ Id: created.providerEntityId, SyncToken: "1", DisplayName: "After Update" });
    await expect(executeSyntheticMutation(provider, {
      entity: "Customer",
      operation: "UPDATE",
      targetId: created.providerEntityId,
      syncToken: "0",
      payload: { DisplayName: "Stale Update" },
      requestId: "synthetic-update-stale",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns QuickBooks tax-excluded transaction totals inclusive of tax", async () => {
    const provider = new SyntheticQuickBooksProvider();
    const result = await executeSyntheticMutation(provider, {
      entity: "Invoice",
      operation: "CREATE",
      payload: {
        CustomerRef: { value: "91" },
        GlobalTaxCalculation: "TaxExcluded",
        TxnTaxDetail: { TotalTax: 9 },
        Line: [{ Amount: 100 }],
      },
      requestId: "synthetic-tax-excluded-total",
    });
    expect(result.readback).toMatchObject({ TotalAmt: 109, Balance: 109 });
  });
});

describe("QuickBooks OAuth Accounting Case MCP contract harness", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
  });

  async function contractClient(): Promise<{ client: Client; provider: SyntheticQuickBooksProvider }> {
    const provider = new SyntheticQuickBooksProvider();
    const resolver: QuickBooksProviderResolver = {
      async connectionStatus() {
        return {
          connected: true,
          company: { realmId: SYNTHETIC_QUICKBOOKS_REALM_ID, name: COMPANY_NAME },
          scopes: ["com.intuit.quickbooks.accounting"],
          connectionRefSafe: "quickbooks-connection:synthetic-contract-v1",
          boundTargetRefSafe: "quickbooks-target:synthetic-contract-v1",
          bindingRevision: BINDING_REVISION,
        };
      },
      async resolve() {
        return {
          realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
          companyName: COMPANY_NAME,
          connectionRefSafe: "quickbooks-connection:synthetic-contract-v1",
          boundTargetRefSafe: "quickbooks-target:synthetic-contract-v1",
          bindingRevision: BINDING_REVISION,
          targetSessionId: "synthetic-contract-target-session-v1",
          targetSessionExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
          provider,
        };
      },
      async issueTargetSession() {
        return {
          companyName: COMPANY_NAME,
          connectionRefSafe: "quickbooks-connection:synthetic-contract-v1",
          boundTargetRefSafe: "quickbooks-target:synthetic-contract-v1",
          bindingRevision: BINDING_REVISION,
          targetSessionRef: TARGET_SESSION_REF,
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    };
    const workflow = new QuickBooksWorkflowService({
      repository: new InMemoryQuickBooksPostingRepository(),
      resolver,
      publicBaseUrl: "https://quickbooks-synthetic-contract.invalid",
      writeEnabled: false,
    });
    const token: ResolvedMcpAccessToken = {
      tokenId: "synthetic-contract-token-v1",
      clientId: "synthetic-contract-client",
      resource: "stdio://quickbooks-synthetic-contract/mcp",
      audience: "stdio://quickbooks-synthetic-contract/mcp",
      grantedScopes: ["quickbooks.read", "quickbooks.mutation.prepare", "quickbooks.mutation.execute"],
      issuedAt: new Date(0),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      installationId: "synthetic-contract-installation",
      bindingId: "synthetic-contract-binding",
      connectionId: "synthetic-contract-connection",
      bindingRevision: 1,
      authorizationId: "synthetic-contract-authorization",
      workspaceId: "synthetic-contract-workspace",
      subjectType: "USER",
      subjectId: "synthetic-accountant",
      agentId: "synthetic-accounting-agent",
      policyId: "synthetic-contract-policy",
      tenantId: SYNTHETIC_QUICKBOOKS_REALM_ID,
      identityAssurance: "TRUSTED_HOST_CONTEXT",
    };
    const context = createOAuthRequestContext({ issuer: "urn:test:qbo:synthetic-contract", resolvedToken: token });
    const mutations = new QuickBooksMutationService(
      new InMemoryQuickBooksMutationRepository(),
      resolver,
      {
        writeEnabled: true,
        writeTargetMode: "oauth_bound",
        publicBaseUrl: "https://quickbooks-synthetic-contract.invalid",
        allowedCapabilities: [...QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES],
        accountingCaseReleasedCapabilities: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES,
        standingDelegationProvider: async () => [{
          delegationId: "synthetic-contract-delegation",
          revision: 1,
          status: "ACTIVE",
          providerId: "quickbooks",
          workspaceId: token.workspaceId,
          agentId: token.agentId,
          installationId: token.installationId,
          tenantIds: [SYNTHETIC_QUICKBOOKS_REALM_ID],
          actionIds: [...QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS],
        }],
      },
    );
    const cases = new QuickBooksAccountingCaseService(
      new InMemoryQuickBooksAccountingCaseRepository(),
      resolver,
      mutations,
    );
    const server = createQuickBooksMcpServer(workflow, context, mutations, cases);
    const client = new Client({ name: "qbo-synthetic-contract-test", version: "0.6.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    return { client, provider };
  }

  it("runs production Case schemas through prepare, autonomous execute, exact readback and terminal replay", async () => {
    const { client, provider } = await contractClient();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "quickbooks_prepare_accounting_case",
      "quickbooks_execute_accounting_case",
      "quickbooks_get_accounting_case_status",
    ]));
    expect(tools.tools.map((tool) => tool.name)).not.toContain("quickbooks_prepare_mutation");

    const target = await client.callTool({ name: "quickbooks_resolve_target", arguments: {} });
    expect(resultText(target)).toContain(TARGET_SESSION_REF);
    const company = await client.callTool({
      name: "quickbooks_get_company",
      arguments: { target_session_ref: TARGET_SESSION_REF },
    });
    expect(resultText(company)).toContain(COMPANY_NAME);
    expect(resultText(company)).not.toContain(SYNTHETIC_QUICKBOOKS_REALM_ID);

    const prepared = await client.callTool({
      name: "quickbooks_prepare_accounting_case",
      arguments: {
        target_session_ref: TARGET_SESSION_REF,
        case_id: "synthetic-case-invoice-001",
        expected_version: 0,
        source_set_complete: true,
        sources: [{
          source_key: "synthetic-invoice.png",
          label: "Synthetic customer invoice",
          units: [{
            unit_key: "invoice-page-1",
            facts: [{
              kind: "DOCUMENT",
              document_type: "INVOICE",
              counterparty_name: "Blue Harbour Trading Pte Ltd",
              document_date: "2026-08-13",
              document_number: "SYN-CASE-INV-001",
              currency: "SGD",
              tax_mode: "NO_TAX",
              lines: [{
                description: "Monthly accounting support",
                quantity: "1",
                unit_amount: "800.00",
                source_tax_amount: "0.00",
                coding_type: "ITEM",
                coding_name: "Monthly accounting support",
              }],
              declared_net: "800.00",
              declared_tax: "0.00",
              declared_gross: "800.00",
              business_reason: "Synthetic Accounting Case contract verification.",
            }],
          }],
        }],
      },
    });
    expect(prepared.isError).not.toBe(true);
    expect(resultText(prepared)).toContain("PLANNED_NEEDS_PREFLIGHT");
    expect(provider.mutationCount).toBe(0);

    const executed = await client.callTool({
      name: "quickbooks_execute_accounting_case",
      arguments: {
        target_session_ref: TARGET_SESSION_REF,
        case_id: "synthetic-case-invoice-001",
        case_version: 1,
        request_id: "synthetic-case-execute-001",
      },
    });
    expect(executed.isError).not.toBe(true);
    expect(resultText(executed)).toContain("ALL_ELIGIBLE_WRITES_READBACK_VERIFIED");
    expect(resultText(executed)).toContain("provider_entity_id");
    expect(provider.mutationCount).toBe(1);

    const replay = await client.callTool({
      name: "quickbooks_execute_accounting_case",
      arguments: {
        target_session_ref: TARGET_SESSION_REF,
        case_id: "synthetic-case-invoice-001",
        case_version: 1,
        request_id: "synthetic-case-execute-001",
      },
    });
    expect(resultText(replay)).toContain("ALL_ELIGIBLE_WRITES_READBACK_VERIFIED");
    expect(provider.mutationCount).toBe(1);

    const listed = await client.callTool({
      name: "quickbooks_list_transactions",
      arguments: {
        target_session_ref: TARGET_SESSION_REF,
        entity: "Invoice",
        date_from: "2026-08-13",
        date_to: "2026-08-13",
        page: 1,
        page_size: 25,
      },
    });
    expect(resultText(listed)).toContain("SYN-CASE-INV-001");
  });
});
