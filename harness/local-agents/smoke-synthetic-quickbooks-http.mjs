import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = process.env.QUICKBOOKS_SYNTHETIC_HTTP_PORT ?? "3310";
const endpoint = new URL(`http://127.0.0.1:${port}/quickbooks/mcp`);
const suffix = Date.now().toString(36);
const caseId = `http-persistence-${suffix}`;
const documentNumber = `SYN-HTTP-${suffix}`.slice(0, 21);

async function session(name) {
  const transport = new StreamableHTTPClientTransport(endpoint);
  const client = new Client({ name, version: "0.6.0" });
  await client.connect(transport);
  return { client, transport };
}

async function target(client) {
  const result = await client.callTool({ name: "quickbooks_resolve_target", arguments: {} });
  if (result.isError) throw new Error(result.content[0]?.text ?? "target resolution failed");
  return JSON.parse(result.content[0].text).result.targetSessionRef;
}

async function close({ client, transport }) {
  await transport.terminateSession();
  await client.close();
}

const first = await session("synthetic-http-prepare-session");
const targetSessionRef = await target(first.client);
const prepared = await first.client.callTool({
  name: "quickbooks_prepare_accounting_case",
  arguments: {
    target_session_ref: targetSessionRef,
    case_id: caseId,
    expected_version: 0,
    sources: [{
      artifactId: `synthetic-http-${suffix}`,
      label: "Synthetic HTTP persistence invoice",
      units: [{ unitId: `page-${suffix}`, expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    }],
    facts: [{
      factId: `invoice-${suffix}-v1`,
      lineageKey: `invoice-${suffix}`,
      eventKey: `invoice-${suffix}`,
      sourceUnitIds: [`page-${suffix}`],
      origin: "MODEL_EXTRACTED",
      revision: 1,
      kind: "NATIVE_DOCUMENT",
      documentType: "INVOICE",
      counterpartyName: "Blue Harbour Trading Pte Ltd",
      documentDate: "2026-08-13",
      documentNumber,
      currency: "SGD",
      taxMode: "NO_TAX",
      lines: [{
        lineId: `line-${suffix}`,
        description: "Monthly accounting support",
        quantity: "1",
        unitAmount: "800.00",
        sourceTax: "0.00",
        codingType: "ITEM",
        codingName: "Monthly accounting support",
      }],
      declaredNet: "800.00",
      declaredTax: "0.00",
      declaredGross: "800.00",
      businessReason: "Verify synthetic HTTP state across distinct MCP sessions.",
    }],
  },
});
if (prepared.isError) throw new Error(prepared.content[0]?.text ?? "prepare failed");
await close(first);

const second = await session("synthetic-http-execute-session");
const refreshedTargetSessionRef = await target(second.client);
const executed = await second.client.callTool({
  name: "quickbooks_execute_accounting_case",
  arguments: {
    target_session_ref: refreshedTargetSessionRef,
    case_id: caseId,
    case_version: 1,
    request_id: `execute-${suffix}`,
  },
});
if (executed.isError) throw new Error(executed.content[0]?.text ?? "execute failed");
const result = JSON.parse(executed.content[0].text).result;
if (result.completion_claim?.ledger_write_claim !== "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED") {
  throw new Error(`unexpected completion claim: ${JSON.stringify(result.completion_claim)}`);
}
await close(second);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  endpoint: endpoint.href,
  distinctMcpSessions: 2,
  caseId,
  providerEntityId: result.operations?.[0]?.provider_entity_id,
  exactReadbackRecorded: result.operations?.[0]?.exact_readback_recorded,
})}\n`);
