import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { SyntheticQuickBooksProvider, SYNTHETIC_QUICKBOOKS_REALM_ID } from "../harness/lib/syntheticQuickBooksProvider.js";
import { createLegacySharedBearerRequestContext } from "../src/security/requestContext.js";
import { InMemoryQuickBooksPostingRepository } from "../src/quickbooks/inMemoryRepository.js";
import { createQuickBooksMcpServer } from "../src/quickbooks/mcp.js";
import type { QuickBooksProviderResolver } from "../src/quickbooks/service.js";
import { QuickBooksWorkflowService } from "../src/quickbooks/service.js";

const TARGET_SESSION_REF = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;

describe("QuickBooks synthetic local-Agent harness", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
  });

  async function client(): Promise<Client> {
    const provider = new SyntheticQuickBooksProvider();
    const resolver: QuickBooksProviderResolver = {
      async connectionStatus() {
        return {
          connected: true,
          company: { realmId: SYNTHETIC_QUICKBOOKS_REALM_ID, name: "zCloak Accounting Sandbox Pte Ltd" },
          scopes: ["com.intuit.quickbooks.accounting"],
          connectionRefSafe: "quickbooks-connection:test",
          boundTargetRefSafe: "quickbooks-target:test",
          bindingRevision: "quickbooks-binding-revision:test",
        };
      },
      async resolve() {
        return {
          realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
          companyName: "zCloak Accounting Sandbox Pte Ltd",
          connectionRefSafe: "quickbooks-connection:test",
          boundTargetRefSafe: "quickbooks-target:test",
          bindingRevision: "quickbooks-binding-revision:test",
          provider,
        };
      },
      async issueTargetSession() {
        return {
          companyName: "zCloak Accounting Sandbox Pte Ltd",
          connectionRefSafe: "quickbooks-connection:test",
          boundTargetRefSafe: "quickbooks-target:test",
          bindingRevision: "quickbooks-binding-revision:test",
          targetSessionRef: TARGET_SESSION_REF,
          expiresAt: "2026-08-12T23:59:59.000Z",
        };
      },
    };
    const service = new QuickBooksWorkflowService({
      repository: new InMemoryQuickBooksPostingRepository(),
      resolver,
      publicBaseUrl: "https://quickbooks-synthetic-business-uat.invalid",
      writeEnabled: false,
    });
    const server = createQuickBooksMcpServer(service, createLegacySharedBearerRequestContext({
      actorId: "local-agent",
      audience: "stdio://quickbooks-synthetic-business-uat/mcp",
      scopes: ["quickbooks.read", "quickbooks.bill.prepare"],
    }));
    const mcpClient = new Client({ name: "qbo-synthetic-agent-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(mcpClient, server);
    await server.connect(serverTransport as unknown as Transport);
    await mcpClient.connect(clientTransport);
    return mcpClient;
  }

  it("supports a bounded accountant history journey with normalized target evidence", async () => {
    const mcpClient = await client();
    const target = await mcpClient.callTool({ name: "quickbooks_resolve_target", arguments: {} });
    expect(target.isError).not.toBe(true);
    const company = await mcpClient.callTool({
      name: "quickbooks_get_company",
      arguments: { target_session_ref: TARGET_SESSION_REF },
    });
    const history = await mcpClient.callTool({
      name: "quickbooks_list_bills",
      arguments: { target_session_ref: TARGET_SESSION_REF, date_from: "2026-06-01", date_to: "2026-08-12", page: 1, page_size: 25 },
    });
    const companyText = (company.content[0] as { text: string }).text;
    const historyText = (history.content[0] as { text: string }).text;

    expect(companyText).toContain("ledger.target.resolve");
    expect(companyText).toContain("zCloak Accounting Sandbox Pte Ltd");
    expect(companyText).not.toContain(SYNTHETIC_QUICKBOOKS_REALM_ID);
    expect(historyText).toContain("ACME-2026-0705");
    expect(historyText).toContain("bounded_query_result");
    expect(historyText).not.toContain(SYNTHETIC_QUICKBOOKS_REALM_ID);
  });

  it("can prepare a review request but exposes no Agent approval or posting tool", async () => {
    const mcpClient = await client();
    const tools = await mcpClient.listTools();
    expect(tools.tools.map((tool) => tool.name).some((name) => /approve|post|create/u.test(name))).toBe(false);

    const hash = await mcpClient.callTool({
      name: "quickbooks_hash_source_document",
      arguments: { source_ref: "synthetic:invoice-2026-0812", content: "Acme invoice SGD 109.00" },
    });
    const hashPayload = JSON.parse((hash.content[0] as { text: string }).text) as {
      result: { sha256: string; evidenceType: string };
    };
    const prepared = await mcpClient.callTool({
      name: "quickbooks_prepare_supplier_bill",
      arguments: {
        target_session_ref: TARGET_SESSION_REF,
        request_id: "synthetic-qbo-agent-001",
        source_ref: "synthetic:invoice-2026-0812",
        source_sha256: hashPayload.result.sha256,
        source_digest_provenance: hashPayload.result.evidenceType,
        vendor_id: "56",
        txn_date: "2026-08-12",
        doc_number: "ACME-2026-0812",
        currency_code: "SGD",
        global_tax_calculation: "TaxExcluded",
        invoice_total: "109.00",
        tax_total: "9.00",
        lines: [{ account_id: "7", amount: "100.00", tax_code_id: "2" }],
      },
    });

    expect(prepared.isError).not.toBe(true);
    expect((prepared.content[0] as { text: string }).text).toContain("PREPARED");
    expect((prepared.content[0] as { text: string }).text).toContain("original file bytes");
  });
});
