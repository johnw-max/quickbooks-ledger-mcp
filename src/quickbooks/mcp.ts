import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AppError, toSafeError } from "../errors.js";
import type { RequestContext } from "../security/requestContext.js";
import { normalizedQuickBooksReadPayload } from "./readEvidence.js";
import type { QuickBooksReadBindingEvidence } from "./readEvidence.js";
import type { QuickBooksWorkflowService } from "./service.js";
import type { QuickBooksAccountingCaseService } from "./accountingCaseService.js";
import {
  quickBooksExecuteAccountingCaseSchema,
  quickBooksGetAccountingCaseStatusSchema,
} from "./accountingCaseSchemas.js";
import type { QuickBooksMutationService } from "./mutationService.js";
import { assertInternalQuickBooksCaller } from "./callerPolicy.js";
import {
  quickBooksGetBillSchema,
  quickBooksHashSourceDocumentSchema,
  quickBooksGetTransactionSchema,
  quickBooksListItemsSchema,
  quickBooksListBillsSchema,
  quickBooksListTransactionsSchema,
  quickBooksNoInputSchema,
  quickBooksTargetSessionSchema,
  quickBooksPrepareSupplierBillSchema,
  quickBooksSearchVendorsSchema,
  quickBooksSearchCustomersSchema,
  quickBooksRunReportSchema,
  quickBooksTrialBalanceSchema,
  quickBooksGetWriteCapabilitiesSchema,
  quickBooksPrepareMutationSchema,
  quickBooksExecutePreparedMutationSchema,
} from "./schemas.js";
import {
  normalizeQuickBooksAccountingCaseBusinessIntake,
  quickBooksAccountingCaseBusinessIntakeSchema,
} from "./accountingCaseBusinessIntake.js";

export const QUICKBOOKS_RELEASE_VERSION = "0.6.0";

export const QUICKBOOKS_READ_TOOL_ALLOWLIST = [
  "quickbooks_connection_status",
  "quickbooks_resolve_target",
  "quickbooks_get_company",
  "quickbooks_list_accounts",
  "quickbooks_list_tax_codes",
  "quickbooks_search_vendors",
  "quickbooks_search_customers",
  "quickbooks_list_items",
  "quickbooks_list_bills",
  "quickbooks_get_bill",
  "quickbooks_list_transactions",
  "quickbooks_get_transaction",
  "quickbooks_run_report",
  "quickbooks_get_trial_balance",
] as const;

export const QUICKBOOKS_LEGACY_PREPARE_TOOL_ALLOWLIST = [
  "quickbooks_hash_source_document",
  "quickbooks_prepare_supplier_bill",
] as const;

/** Legacy read + supplier-Bill preparation surface. Accounting Case mode excludes it. */
export const QUICKBOOKS_TOOL_ALLOWLIST = [
  ...QUICKBOOKS_READ_TOOL_ALLOWLIST,
  ...QUICKBOOKS_LEGACY_PREPARE_TOOL_ALLOWLIST,
] as const;

export const QUICKBOOKS_MUTATION_TOOL_ALLOWLIST = [
  "quickbooks_get_write_capabilities",
  "quickbooks_prepare_mutation",
  "quickbooks_execute_confirmed_mutation",
] as const;

export const QUICKBOOKS_CAPABILITY_TOOL_ALLOWLIST = [
  "quickbooks_get_write_capabilities",
] as const;

export const QUICKBOOKS_ACCOUNTING_CASE_TOOL_ALLOWLIST = [
  "quickbooks_prepare_accounting_case",
  "quickbooks_execute_accounting_case",
  "quickbooks_get_accounting_case_status",
] as const;

export const QUICKBOOKS_RUNTIME_TOOL_ALLOWLIST = [
  ...QUICKBOOKS_READ_TOOL_ALLOWLIST,
  ...QUICKBOOKS_CAPABILITY_TOOL_ALLOWLIST,
  ...QUICKBOOKS_ACCOUNTING_CASE_TOOL_ALLOWLIST,
] as const;

function success(value: unknown): CallToolResult {
  const payload = { result: value };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function successPayload(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function failure(error: unknown): CallToolResult {
  const safe = toSafeError(error);
  const fallbackLayer = safe.code === "AUTH_REQUIRED" || safe.code === "NOT_CONNECTED" ? "AUTHENTICATION" :
    safe.code === "FORBIDDEN" ? "AUTHORIZATION" :
      safe.code === "VALIDATION_FAILED" ? "DETERMINISTIC_VALIDATION" :
        safe.code === "CONFLICT" ? "CONCURRENCY_OR_VERSION" :
          safe.code === "READBACK_MISMATCH" ? "READBACK" :
            safe.code === "WRITE_RESULT_UNKNOWN" || safe.code === "WRITE_RESULT_UNKNOWN_NO_ID"
              ? "PROVIDER_OUTCOME" :
              safe.code === "PROVIDER_ERROR" || safe.code === "PROVIDER_UNAVAILABLE" || safe.code === "RATE_LIMITED"
                ? "PROVIDER" : "CONFIGURATION";
  const failureLayer = typeof safe.details?.failureLayer === "string" ? safe.details.failureLayer : fallbackLayer;
  const payload = {
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
      failure_layer: failureLayer,
      provider_mutation_possible: safe.code === "WRITE_RESULT_UNKNOWN" || safe.code === "WRITE_RESULT_UNKNOWN_NO_ID",
      recovery_action: safe.code === "WRITE_RESULT_UNKNOWN_NO_ID"
        ? "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM"
        : safe.code === "WRITE_RESULT_UNKNOWN" ? "READBACK_RECOVERY_ONLY" : "INSPECT_ERROR_AND_STATUS",
      ...(safe.details ? { details: safe.details } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function scoped<T>(options: {
  context: RequestContext;
  requiredScope:
    | "quickbooks.read"
    | "quickbooks.bill.prepare"
    | "quickbooks.bill.execute"
    | "quickbooks.mutation.prepare"
    | "quickbooks.mutation.execute";
  action: () => Promise<T>;
}): Promise<CallToolResult> {
  try {
    assertInternalQuickBooksCaller(options.context);
    if (!options.context.scopes.includes(options.requiredScope)) {
      throw new AppError("FORBIDDEN", `This MCP installation does not grant ${options.requiredScope}.`, {
        httpStatus: 403,
      });
    }
    return success(await options.action());
  } catch (error) {
    return failure(error);
  }
}

async function scopedRead<T>(options: {
  context: RequestContext;
  toolName: string;
  input: unknown;
  action: () => Promise<{ result: T; binding: QuickBooksReadBindingEvidence | null }>;
}): Promise<CallToolResult> {
  try {
    assertInternalQuickBooksCaller(options.context);
    if (!options.context.scopes.includes("quickbooks.read")) {
      throw new AppError("FORBIDDEN", "This MCP installation does not grant quickbooks.read.", {
        httpStatus: 403,
      });
    }
    const read = await options.action();
    return successPayload(normalizedQuickBooksReadPayload({
      toolName: options.toolName,
      input: options.input,
      result: read.result,
      binding: read.binding,
      releaseVersion: QUICKBOOKS_RELEASE_VERSION,
    }));
  } catch (error) {
    return failure(error);
  }
}

export function createQuickBooksMcpServer(
  service: QuickBooksWorkflowService,
  context: RequestContext,
  mutations?: QuickBooksMutationService,
  accountingCases?: QuickBooksAccountingCaseService,
): McpServer {
  const actorId = context.actorId;
  const server = new McpServer(
    { name: "zcloak-quickbooks-accounting-mcp", version: QUICKBOOKS_RELEASE_VERSION },
    { capabilities: { logging: {} } },
  );

  server.registerTool("quickbooks_connection_status", {
    title: "QuickBooks connection status",
    description: "Returns the server-bound QuickBooks company without exposing OAuth credentials. It also returns a short-lived, one-time Intuit authorization link. When already connected, completing that link replaces this MCP installation's current company instead of adding a second company.",
    inputSchema: quickBooksNoInputSchema,
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
  }, async () => scopedRead({
    context,
    toolName: "quickbooks_connection_status",
    input: {},
    action: async () => {
      const result = await service.connectionStatus(actorId);
      return {
        result,
        binding: result.connected && result.connectionRefSafe && result.boundTargetRefSafe && result.bindingRevision
          ? {
              companyName: result.company?.name ?? "",
              connectionRefSafe: result.connectionRefSafe,
              boundTargetRefSafe: result.boundTargetRefSafe,
              bindingRevision: result.bindingRevision,
            }
          : null,
      };
    },
  }));

  server.registerTool("quickbooks_resolve_target", {
    title: "Resolve the active QuickBooks target",
    description: "Pins the current OAuth-bound QuickBooks Company to a short-lived opaque target_session_ref. Call this after connection status and pass the returned reference to every ledger read or prepare-write tool. Re-resolve after expiry or any Company reconnect/switch.",
    inputSchema: quickBooksNoInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false },
  }, async () => scoped({
    context,
    requiredScope: "quickbooks.read",
    action: async () => {
      const identityAssurance = assertInternalQuickBooksCaller(context);
      return {
        ...await service.resolveTarget(actorId),
        identityAssurance,
        externalRoleEnforcement: identityAssurance === "TRUSTED_HOST_CONTEXT"
          ? "ENFORCED_FROM_TRUSTED_HOST_CONTEXT"
          : "REQUIRES_TRUSTED_HOST_CONTEXT",
      };
    },
  }));

  server.registerTool("quickbooks_get_company", {
    title: "Get QuickBooks company",
    description: "Reads the exact QuickBooks company bound to this Agent installation.",
    inputSchema: quickBooksTargetSessionSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_get_company",
    input,
    action: () => service.getCompanyRead(actorId, input.target_session_ref),
  }));

  server.registerTool("quickbooks_list_accounts", {
    title: "List QuickBooks accounts",
    description: "Lists active accounts from the bound QuickBooks company.",
    inputSchema: quickBooksTargetSessionSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_list_accounts",
    input,
    action: () => service.listAccountsRead(actorId, input.target_session_ref),
  }));

  server.registerTool("quickbooks_list_tax_codes", {
    title: "List QuickBooks tax codes",
    description: "Lists active tax codes available in the bound QuickBooks company.",
    inputSchema: quickBooksTargetSessionSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_list_tax_codes",
    input,
    action: () => service.listTaxCodesRead(actorId, input.target_session_ref),
  }));

  server.registerTool("quickbooks_search_vendors", {
    title: "Search QuickBooks vendors",
    description: "Searches active vendors using a non-empty name/email text query. limit must be 1-100. Returns searchWindow evidence; if complete=false, disclose the requested-limit or 10,000-record scan boundary instead of claiming exhaustive results. This is not an unfiltered list-all tool.",
    inputSchema: quickBooksSearchVendorsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_search_vendors",
    input,
    action: () => service.searchVendorsRead(actorId, input),
  }));

  server.registerTool("quickbooks_search_customers", {
    title: "Search QuickBooks customers",
    description: "Searches active customers by a non-empty name/email text query. limit must be 1-100. Returns searchWindow evidence; if complete=false, do not claim exhaustive results. This is not an unfiltered list-all tool.",
    inputSchema: quickBooksSearchCustomersSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_search_customers",
    input,
    action: () => service.searchCustomersRead(actorId, input),
  }));

  server.registerTool("quickbooks_list_items", {
    title: "List QuickBooks products and services",
    description: "Lists active products and services used for sales and purchasing analysis. It pages through QuickBooks instead of silently returning only the first 1,000 records.",
    inputSchema: quickBooksListItemsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_list_items",
    input,
    action: () => service.listItemsRead(actorId, input.target_session_ref),
  }));

  server.registerTool("quickbooks_list_bills", {
    title: "List QuickBooks bills",
    description: "Lists bounded historical supplier Bills for accounting analysis.",
    inputSchema: quickBooksListBillsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_list_bills",
    input,
    action: () => service.listBillsRead(actorId, input),
  }));

  server.registerTool("quickbooks_get_bill", {
    title: "Get exact QuickBooks bill",
    description: "Reads one supplier Bill by its exact QuickBooks Id.",
    inputSchema: quickBooksGetBillSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_get_bill",
    input,
    action: () => service.getBillRead(actorId, input),
  }));

  server.registerTool("quickbooks_list_transactions", {
    title: "List QuickBooks accounting transactions",
    description: "Lists bounded invoices, payments, purchases, bill payments, journal entries, credits, or sales receipts. page_size must be 1-50; follow hasNextPage instead of increasing it beyond 50. Supports customer/vendor filtering for compatible transaction types and open_only for invoices.",
    inputSchema: quickBooksListTransactionsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_list_transactions",
    input,
    action: () => service.listTransactionsRead(actorId, input),
  }));

  server.registerTool("quickbooks_get_transaction", {
    title: "Get an exact QuickBooks accounting transaction",
    description: "Reads one exact transaction by supported entity type and QuickBooks Id.",
    inputSchema: quickBooksGetTransactionSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_get_transaction",
    input,
    action: () => service.getTransactionRead(actorId, input),
  }));

  server.registerTool("quickbooks_run_report", {
    title: "Run a QuickBooks financial report",
    description: "Runs a bounded standard report such as Profit and Loss, Balance Sheet, cash flow, aging, balances, expenses, general ledger, or trial balance. Use either as_of_date or a start/end period, never both. Customer and vendor filters are accepted only by compatible reports. Inspect zcloakReportWindow before claiming completeness.",
    inputSchema: quickBooksRunReportSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_run_report",
    input,
    action: () => service.runReportRead(actorId, input),
  }));

  if (!accountingCases) {
    server.registerTool("quickbooks_hash_source_document", {
      title: "Hash supplied accounting source text",
      description: "Computes a SHA-256 text fingerprint from the exact UTF-8 text supplied by the Agent. This does not read or verify original PDF/image bytes, and it does not prove the identity of the uploaded file. Copy the returned 64-character sha256 and evidenceType exactly into quickbooks_prepare_supplier_bill. The text is limited to 256 KiB and is not stored by this QuickBooks MCP service; upstream host retention is outside this tool's control.",
      inputSchema: quickBooksHashSourceDocumentSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    }, async (input) => scoped({
      context,
      requiredScope: "quickbooks.bill.prepare",
      action: async () => service.hashSourceDocument(input),
    }));

    server.registerTool("quickbooks_prepare_supplier_bill", {
      title: "Prepare a QuickBooks supplier bill for review",
      description: "Validates references and totals, checks both local pending requests and existing QuickBooks Bills for the same vendor document number, then creates a local review request only. It does not write to QuickBooks until a human approves outside Agent tools. Pass the current target_session_ref from quickbooks_resolve_target. For Agent-supplied text, first call quickbooks_hash_source_document and copy its sha256/evidenceType exactly. HOST_PROVIDED provenance additionally requires an opaque source_attestation_ref that the configured WorkStore verifier accepts; the Agent must never invent it. QuickBooks doc_number is limited to 21 characters: never silently truncate it; for a longer number omit doc_number, explain it in missing_doc_number_reason, and preserve the full original in memo. For NON/no-tax bills, use global_tax_calculation=NotApplicable, tax_total=0, and omit line tax_code_id; tax_code_id otherwise must be the numeric Id returned by quickbooks_list_tax_codes.",
      inputSchema: quickBooksPrepareSupplierBillSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    }, async (input) => scoped({
      context,
      requiredScope: "quickbooks.bill.prepare",
      action: () => service.prepareSupplierBill(actorId, input),
    }));
  }

  server.registerTool("quickbooks_get_trial_balance", {
    title: "Get QuickBooks Trial Balance",
    description: "Reads the QuickBooks Trial Balance for post-write ledger evidence.",
    inputSchema: quickBooksTrialBalanceSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scopedRead({
    context,
    toolName: "quickbooks_get_trial_balance",
    input,
    action: () => service.getTrialBalanceRead(actorId, input),
  }));

  if (mutations) {
    server.registerTool("quickbooks_get_write_capabilities", {
      title: "Get QuickBooks write capabilities and risk policy",
      description: "Returns the complete write surface tracked from Intuit's official QuickBooks MCP plus zCloak risk, review, draft, and runtime-enable policy. Call this before proposing any QuickBooks write. QuickBooks has no universal draft state.",
      inputSchema: quickBooksGetWriteCapabilitiesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    }, async (input) => scoped({
      context,
      requiredScope: "quickbooks.read",
      action: async () => mutations.capabilities(input),
    }));

    if (!accountingCases) server.registerTool("quickbooks_prepare_mutation", {
      title: "Prepare a governed QuickBooks mutation",
      description: "Creates an immutable local PREPARED proposal for an official QuickBooks create, update, or delete capability. It never writes to QuickBooks. Pass the current target_session_ref from quickbooks_resolve_target. The result states whether exact Agent confirmation is allowed or an out-of-band human review is mandatory. UPDATE and DELETE require the exact provider Id and SyncToken; Company/Realm is always taken from the verified target and OAuth binding. HOST_PROVIDED source evidence additionally requires a WorkStore-verified source_attestation_ref.",
      inputSchema: quickBooksPrepareMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    }, async (input) => scoped({
      context,
      requiredScope: "quickbooks.mutation.prepare",
      action: () => mutations.prepare(actorId, input),
    }));

    if (!accountingCases) server.registerTool("quickbooks_execute_confirmed_mutation", {
      title: "Execute a confirmed low-risk QuickBooks mutation",
      description: "Consumes one exact, unexpired PREPARED proposal only when policy classifies it as low-risk EXPLICIT_CONFIRMATION. It accepts no accounting payload. Medium/high/critical actions are rejected and must use the out-of-band review route. Success means one provider write plus exact-Id readback, never PREPARED alone.",
      inputSchema: quickBooksExecutePreparedMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    }, async (input) => scoped({
      context,
      requiredScope: "quickbooks.mutation.execute",
      action: () => mutations.executeWithConfirmation(actorId, input),
    }));
  }

  if (accountingCases) {
    server.registerTool("quickbooks_prepare_accounting_case", {
      title: "Prepare a bounded QuickBooks Accounting Case",
      description: "Accepts business-shaped source units and deterministically builds the strict internal typed Case; the Agent does not create fact ids, lineage, source links, or Provider ids. A residual Case can contain only UNSUPPORTED_EVENT, EVIDENCE, or CONTROL_FINDING facts and compile to zero Provider operations. The server verifies coverage, recomputes totals, resolves QuickBooks references, stores immutable canonical operations, and performs no Provider write.",
      inputSchema: quickBooksAccountingCaseBusinessIntakeSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    }, async (input) => scoped({
      context,
      requiredScope: "quickbooks.mutation.prepare",
      action: () => accountingCases.prepare(context, normalizeQuickBooksAccountingCaseBusinessIntake(input)),
    }));

    server.registerTool("quickbooks_execute_accounting_case", {
      title: "Execute a governed QuickBooks Accounting Case",
      description: "Executes only server-persisted canonical operations from one immutable case version. Standing delegation, exact target binding, deterministic validation, idempotency and exact readback are mandatory. No accounting payload or confirmation phrase is accepted.",
      inputSchema: quickBooksExecuteAccountingCaseSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    }, async (input) => scoped({
      context,
      requiredScope: "quickbooks.mutation.execute",
      action: () => accountingCases.execute(context, input),
    }));

    server.registerTool("quickbooks_get_accounting_case_status", {
      title: "Get QuickBooks Accounting Case status",
      description: "Returns bounded source coverage, event dispositions, operation receipts and a conservative completion claim. Only READBACK_VERIFIED operations count as written.",
      inputSchema: quickBooksGetAccountingCaseStatusSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    }, async (input) => scoped({
      context,
      requiredScope: "quickbooks.read",
      action: () => accountingCases.status(context, input),
    }));
  }

  return server;
}
