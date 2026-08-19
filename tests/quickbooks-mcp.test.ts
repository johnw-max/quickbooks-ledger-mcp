import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLegacySharedBearerRequestContext } from "../src/security/requestContext.js";
import {
  createQuickBooksMcpServer,
  QUICKBOOKS_RUNTIME_TOOL_ALLOWLIST,
  QUICKBOOKS_ACCOUNTING_CASE_TOOL_ALLOWLIST,
  QUICKBOOKS_READ_TOOL_ALLOWLIST,
} from "../src/quickbooks/mcp.js";
import { hasQuickBooksReadEvidenceProfile } from "../src/quickbooks/readEvidence.js";
import type { QuickBooksWorkflowService } from "../src/quickbooks/service.js";
import type { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import type { QuickBooksAccountingCaseService } from "../src/quickbooks/accountingCaseService.js";

const accountingCasesStub = {} as QuickBooksAccountingCaseService;

const TARGET_SESSION_REF = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;

function firstToolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("Expected MCP content array");
  }
  const first = result.content[0] as { text?: unknown } | undefined;
  if (!first || typeof first.text !== "string") throw new Error("Expected MCP text content");
  return first.text;
}

describe("QuickBooks MCP surface", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
  });

  it("exposes reviewed read and Accounting Case tools but no Agent approval/post tool", async () => {
    const service = {} as QuickBooksWorkflowService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "actor-a",
      audience: "https://agent2.zcloak.ai/quickbooks/mcp",
      scopes: ["quickbooks.read", "quickbooks.mutation.prepare"],
    });
    const server = createQuickBooksMcpServer(service, context, accountingCasesStub);
    const client = new Client({ name: "qbo-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names.sort()).toEqual(
      [...QUICKBOOKS_READ_TOOL_ALLOWLIST, ...QUICKBOOKS_ACCOUNTING_CASE_TOOL_ALLOWLIST].sort(),
    );
    expect(names).toHaveLength(17);
    expect(names.some((name) => /approve|post|create/.test(name))).toBe(false);
  });

  it("keeps every ordinary read tool covered by normalized evidence", () => {
    const nonReadTools = new Set(["quickbooks_resolve_target"]);
    const ordinaryReads = QUICKBOOKS_READ_TOOL_ALLOWLIST.filter((name) => !nonReadTools.has(name));

    expect(ordinaryReads.every((name) => hasQuickBooksReadEvidenceProfile(name))).toBe(true);
  });

  it("adds the write-capability tool only when the mutation runtime is installed", async () => {
    const service = {} as QuickBooksWorkflowService;
    const mutations = {
      capabilities: vi.fn().mockReturnValue({ sourceCoverage: { total: 71 } }),
    } as unknown as QuickBooksMutationService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "actor-a",
      audience: "https://agent2.zcloak.ai/quickbooks/mcp",
      scopes: ["quickbooks.read", "quickbooks.mutation.prepare"],
    });
    const server = createQuickBooksMcpServer(service, context, accountingCasesStub, mutations);
    const client = new Client({ name: "qbo-mutation-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...QUICKBOOKS_RUNTIME_TOOL_ALLOWLIST].sort());
    const capabilities = await client.callTool({ name: "quickbooks_get_write_capabilities", arguments: {} });
    expect(capabilities.isError).not.toBe(true);
    const payload = JSON.parse(firstToolText(capabilities)) as {
      result?: { sourceCoverage?: { total?: number } };
    };
    expect(payload.result?.sourceCoverage?.total).toBe(71);
  });

  it("routes the high-level Accounting Case intake through the deterministic normalizer", async () => {
    const service = {} as QuickBooksWorkflowService;
    const mutations = { capabilities: vi.fn().mockReturnValue({ sourceCoverage: { total: 71 } }) } as unknown as QuickBooksMutationService;
    const prepare = vi.fn().mockResolvedValue({ state: "PLANNED_NEEDS_PREFLIGHT" });
    const accountingCases = { prepare } as unknown as QuickBooksAccountingCaseService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "actor-a",
      audience: "https://agent2.zcloak.ai/quickbooks/mcp",
      scopes: ["quickbooks.read", "quickbooks.mutation.prepare", "quickbooks.mutation.execute"],
    });
    const server = createQuickBooksMcpServer(service, context, accountingCases, mutations);
    const client = new Client({ name: "qbo-case-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const listedTools = (await client.listTools()).tools;
    const names = listedTools.map((tool) => tool.name);
    expect(names.sort()).toEqual([...QUICKBOOKS_RUNTIME_TOOL_ALLOWLIST].sort());
    expect(names).toHaveLength(19);
    expect(QUICKBOOKS_ACCOUNTING_CASE_TOOL_ALLOWLIST.every((name) => names.includes(name))).toBe(true);
    // The operator exit from an unknown write outcome ships with the mutation
    // runtime, and only with it: without a durable mutation repository there is
    // nothing stranded to attest about.
    expect(names).toContain("quickbooks_resolve_unknown_write");
    const prepareCaseTool = listedTools.find((tool) => tool.name === "quickbooks_prepare_accounting_case");
    expect(prepareCaseTool?.description).toContain("zero Provider operations");
    expect(prepareCaseTool?.description).toContain("does not create fact ids");
    expect(JSON.stringify(prepareCaseTool?.inputSchema)).toContain("source_key");
    expect(JSON.stringify(prepareCaseTool?.inputSchema)).toContain("The server creates fact ids");

    const prepared = await client.callTool({
      name: "quickbooks_prepare_accounting_case",
      arguments: {
        target_session_ref: TARGET_SESSION_REF,
        case_id: "case-route-001",
        expected_version: 0,
        source_set_complete: true,
        sources: [{
          source_key: "artifact-route-001",
          label: "Route test",
          units: [{
            unit_key: "unit-route-001",
            facts: [{
              kind: "EVIDENCE",
              origin: "AGENT_ASSERTED",
              evidence_role: "CONTROL_SUPPORT",
              note: "Deterministic Case route registration test.",
            }],
          }],
        }],
      },
    });
    expect(prepared.isError).not.toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(context, expect.objectContaining({
      case_id: "case-route-001",
      facts: [expect.objectContaining({
        kind: "EVIDENCE",
        evidenceRole: "CONTROL_SUPPORT",
        origin: "AGENT_ASSERTED",
      })],
    }));
  });

  it("does not let mutation prepare scope authorize provider execution", async () => {
    const execute = vi.fn();
    const service = {} as QuickBooksWorkflowService;
    const accountingCases = { execute } as unknown as QuickBooksAccountingCaseService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "prepare-only-actor",
      audience: "https://agent2.zcloak.ai/quickbooks/mcp",
      scopes: ["quickbooks.mutation.prepare"],
    });
    const server = createQuickBooksMcpServer(service, context, accountingCases);
    const client = new Client({ name: "qbo-scope-separation-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "quickbooks_execute_accounting_case",
      arguments: {
        target_session_ref: TARGET_SESSION_REF,
        case_id: "case-scope-001",
        case_version: 1,
        request_id: "qbo.case.scope.001",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("quickbooks.mutation.execute");
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns ledger-target evidence without exposing raw Realm or connection identifiers", async () => {
    const getCompanyRead = vi.fn().mockResolvedValue({
      result: {
        Id: "1",
        CompanyName: "Sandbox Company A",
        Country: "SG",
        HomeCurrency: { value: "SGD", name: "Singapore Dollar" },
      },
      binding: {
        companyName: "Sandbox Company A",
        connectionRefSafe: `quickbooks-connection:${"a".repeat(32)}`,
        boundTargetRefSafe: `quickbooks-target:${"b".repeat(32)}`,
        bindingRevision: `quickbooks-binding-revision:${"c".repeat(32)}`,
      },
    });
    const service = { getCompanyRead } as unknown as QuickBooksWorkflowService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "read-actor",
      audience: "https://mcp.jiayuanwang.xyz/quickbooks/mcp",
      scopes: ["quickbooks.read"],
    });
    const server = createQuickBooksMcpServer(service, context, accountingCasesStub);
    const client = new Client({ name: "qbo-read-evidence-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "quickbooks_get_company",
      arguments: { target_session_ref: TARGET_SESSION_REF },
    });
    const payload = JSON.parse(firstToolText(response)) as Record<string, unknown>;

    expect(payload).toMatchObject({
      result: { CompanyName: "Sandbox Company A", Country: "SG" },
      fact_origin: "MCP_READ",
      source_system: "quickbooks",
      destination_role: "ledger_sor",
      capability_id: "ledger.target.resolve",
      bound_target_ref_safe: `quickbooks-target:${"b".repeat(32)}`,
      organisation_display_name: "Sandbox Company A",
      binding_revision: `quickbooks-binding-revision:${"c".repeat(32)}`,
      base_currency: "SGD",
      fact_paths: ["/result/CompanyName", "/result/HomeCurrency/value"],
    });
    expect(payload).toHaveProperty("output_hash", expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
    expect(payload).toHaveProperty("tool_call_or_audit_ref", expect.stringMatching(/^qbo-tool-call:/));
    expect(JSON.stringify(payload)).not.toContain("realmId");
    expect(JSON.stringify(payload)).not.toContain("connectionId");
    expect(JSON.stringify(payload)).not.toContain("realm_id");
    expect(JSON.stringify(payload)).not.toContain("connection_id");
    expect(JSON.stringify(payload)).not.toContain("qbts_");
    expect(getCompanyRead).toHaveBeenCalledWith("read-actor", TARGET_SESSION_REF);
  });

  it("issues a short-lived opaque target session before ledger access", async () => {
    const resolveTarget = vi.fn().mockResolvedValue({
      companyName: "Sandbox Company A",
      connectionRefSafe: `quickbooks-connection:${"a".repeat(32)}`,
      boundTargetRefSafe: `quickbooks-target:${"b".repeat(32)}`,
      bindingRevision: `quickbooks-binding-revision:${"c".repeat(32)}`,
      targetSessionRef: TARGET_SESSION_REF,
      expiresAt: "2026-08-12T12:15:00.000Z",
    });
    const service = { resolveTarget } as unknown as QuickBooksWorkflowService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "read-actor",
      audience: "https://mcp.jiayuanwang.xyz/quickbooks/mcp",
      scopes: ["quickbooks.read"],
    });
    const server = createQuickBooksMcpServer(service, context, accountingCasesStub);
    const client = new Client({ name: "qbo-target-session-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const response = await client.callTool({ name: "quickbooks_resolve_target", arguments: {} });
    const payload = JSON.parse(firstToolText(response)) as {
      result: Record<string, unknown>;
    };
    expect(payload.result).toMatchObject({
      companyName: "Sandbox Company A",
      targetSessionRef: TARGET_SESSION_REF,
      identityAssurance: "LEGACY_SHARED_BEARER",
      externalRoleEnforcement: "REQUIRES_TRUSTED_HOST_CONTEXT",
    });
    expect(JSON.stringify(payload)).not.toContain("934145");
  });

  it("keeps connection status in the control plane and prevents it from becoming target proof", async () => {
    const connectionStatus = vi.fn().mockResolvedValue({
      connected: true,
      company: { realmId: "9341457658718743", name: "Sandbox Company A" },
      scopes: ["com.intuit.quickbooks.accounting"],
      connectionRefSafe: `quickbooks-connection:${"a".repeat(32)}`,
      boundTargetRefSafe: `quickbooks-target:${"b".repeat(32)}`,
      bindingRevision: `quickbooks-binding-revision:${"c".repeat(32)}`,
    });
    const service = { connectionStatus } as unknown as QuickBooksWorkflowService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "status-actor",
      audience: "https://mcp.jiayuanwang.xyz/quickbooks/mcp",
      scopes: ["quickbooks.read"],
    });
    const server = createQuickBooksMcpServer(service, context, accountingCasesStub);
    const client = new Client({ name: "qbo-status-evidence-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const response = await client.callTool({ name: "quickbooks_connection_status", arguments: {} });
    const payload = JSON.parse(firstToolText(response)) as Record<string, unknown>;

    expect(payload).toMatchObject({
      destination_role: "connector_control_plane",
      capability_id: "connector.connection.status.read",
      connection_state: "connected",
      connection_ref_safe: `quickbooks-connection:${"a".repeat(32)}`,
      bound_target_ref_safe: null,
      binding_revision: null,
      organisation_display_name: null,
    });
    expect(JSON.stringify(payload)).not.toContain("9341457658718743");
    expect(JSON.stringify(payload)).not.toContain("realmId");
    expect((payload.result as Record<string, unknown>)).not.toHaveProperty("boundTargetRefSafe");
    expect((payload.result as Record<string, unknown>)).not.toHaveProperty("bindingRevision");
  });
});
