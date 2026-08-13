import { randomUUID } from "node:crypto";
import { hashObject } from "../security/hash.js";

export type QuickBooksReadCapabilityId =
  | "connector.connection.status.read"
  | "ledger.target.resolve"
  | "ledger.reference.accounts.read"
  | "ledger.reference.tax.read"
  | "ledger.reference.counterparty.read"
  | "ledger.reference.item.read"
  | "ledger.transaction.search"
  | "ledger.object.read_exact"
  | "ledger.report.read"
  | "ledger.report.trial_balance.read";

type QuickBooksReadKind = "connection" | "target" | "collection" | "exact" | "report";

interface QuickBooksReadEvidenceProfile {
  readonly capabilityId: QuickBooksReadCapabilityId;
  readonly kind: QuickBooksReadKind;
}

const PROFILES: Readonly<Record<string, QuickBooksReadEvidenceProfile>> = {
  quickbooks_connection_status: { capabilityId: "connector.connection.status.read", kind: "connection" },
  quickbooks_get_company: { capabilityId: "ledger.target.resolve", kind: "target" },
  quickbooks_list_accounts: { capabilityId: "ledger.reference.accounts.read", kind: "collection" },
  quickbooks_list_tax_codes: { capabilityId: "ledger.reference.tax.read", kind: "collection" },
  quickbooks_search_vendors: { capabilityId: "ledger.reference.counterparty.read", kind: "collection" },
  quickbooks_search_customers: { capabilityId: "ledger.reference.counterparty.read", kind: "collection" },
  quickbooks_list_items: { capabilityId: "ledger.reference.item.read", kind: "collection" },
  quickbooks_list_bills: { capabilityId: "ledger.transaction.search", kind: "collection" },
  quickbooks_get_bill: { capabilityId: "ledger.object.read_exact", kind: "exact" },
  quickbooks_list_transactions: { capabilityId: "ledger.transaction.search", kind: "collection" },
  quickbooks_get_transaction: { capabilityId: "ledger.object.read_exact", kind: "exact" },
  quickbooks_run_report: { capabilityId: "ledger.report.read", kind: "report" },
  quickbooks_get_trial_balance: { capabilityId: "ledger.report.trial_balance.read", kind: "report" },
};

export function hasQuickBooksReadEvidenceProfile(toolName: string): boolean {
  return Object.hasOwn(PROFILES, toolName);
}

export interface QuickBooksReadBindingEvidence {
  readonly companyName: string;
  readonly connectionRefSafe: string;
  readonly boundTargetRefSafe: string;
  readonly bindingRevision: string;
}

const SENSITIVE_KEYS = new Set([
  "accessToken",
  "access_token",
  "authorizationId",
  "bindingRevision",
  "binding_revision",
  "boundTargetRefSafe",
  "bound_target_ref_safe",
  "clientSecret",
  "client_secret",
  "connectionId",
  "connectionRefSafe",
  "connection_id",
  "connection_ref_safe",
  "oauthInstallationId",
  "oauth_installation_id",
  "realmId",
  "realmID",
  "RealmId",
  "RealmID",
  "realm_id",
  "refreshToken",
  "refresh_token",
  "tokenCiphertext",
  "tokenId",
  "targetSessionRef",
  "target_session_ref",
]);

function defineSafe(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Removes provider target locators and credential material from Agent reads. */
export function safeQuickBooksReadResult(value: unknown): unknown {
  const visit = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map((entry) => visit(entry));
    if (!candidate || typeof candidate !== "object") {
      if (typeof candidate === "bigint") return candidate.toString();
      if (["function", "symbol", "undefined"].includes(typeof candidate)) return null;
      return candidate;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key)) continue;
      defineSafe(result, key, visit(child));
    }
    return result;
  };
  return visit(value);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeQueryValue(value: unknown): unknown {
  const safeValue = safeQuickBooksReadResult(value ?? {});
  const json = JSON.stringify(safeValue);
  if (Buffer.byteLength(json, "utf8") <= 4 * 1_024) return safeValue;
  return {
    metadata_omitted_due_to_bound: true,
    metadata_hash: `sha256:${hashObject(safeValue)}`,
  };
}

function readCompleteness(profile: QuickBooksReadEvidenceProfile, result: unknown): Record<string, unknown> {
  const record = objectRecord(result);
  if (profile.kind === "connection") {
    return {
      status: "connection_status_observation",
      scope: "connection_binding_resolution",
      ledger_data_completeness: "not_applicable",
    };
  }
  if (profile.kind === "target") {
    const homeCurrency = objectRecord(record?.HomeCurrency);
    const hasCompanyName = typeof record?.CompanyName === "string" && record.CompanyName.length > 0;
    const hasHomeCurrency = typeof homeCurrency?.value === "string" && /^[A-Z]{3}$/u.test(homeCurrency.value);
    return {
      status: hasCompanyName && hasHomeCurrency ? "complete" : "required_target_fields_missing",
      scope: "active_server_bound_quickbooks_company",
      base_currency_returned: hasHomeCurrency,
    };
  }
  if (profile.kind === "exact") {
    return {
      status: "exact_object_identity",
      scope: "exact_provider_object_id",
      provider_field_completeness: "not_independently_verified",
    };
  }
  if (profile.kind === "report") {
    const window = objectRecord(record?.zcloakReportWindow);
    return {
      status: window?.truncated === true ? "bounded_report_truncated" : "bounded_provider_response",
      scope: "single_quickbooks_report_response",
      provider_completeness: "not_independently_verified",
      ...(window ? { report_window: safeQueryValue(window) } : {}),
    };
  }
  const pagination = objectRecord(record?.pagination);
  const searchWindow = objectRecord(record?.searchWindow);
  const declaredComplete = searchWindow
    ? searchWindow.complete === true
    : pagination
      ? pagination.hasNextPage === false
      : "not_independently_verified";
  return {
    status: "bounded_query_result",
    scope: pagination ? "declared_provider_page" : searchWindow ? "declared_search_window" : "single_provider_response",
    within_declared_query_bounds: true,
    declared_result_complete: declaredComplete,
    whole_ledger_complete: false,
    ...(pagination ? { pagination: safeQueryValue(pagination) } : {}),
    ...(searchWindow ? { search_window: safeQueryValue(searchWindow) } : {}),
  };
}

function factPaths(result: unknown, profile: QuickBooksReadEvidenceProfile): string[] {
  if (profile.kind === "target") {
    const record = objectRecord(result);
    return typeof record?.CompanyName === "string" && typeof objectRecord(record.HomeCurrency)?.value === "string"
      ? ["/result/CompanyName", "/result/HomeCurrency/value"]
      : ["/result"];
  }
  if (Array.isArray(result) || !result || typeof result !== "object") return ["/result"];
  const keys = Object.keys(result as Record<string, unknown>);
  if (keys.length === 0 || keys.length > 32) return ["/result"];
  const paths = keys.map((key) => `/result/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
  return Buffer.byteLength(JSON.stringify(paths), "utf8") <= 4 * 1_024 ? paths : ["/result"];
}

function safeDisplayName(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 512 ? value : `${value.slice(0, 512)}...[display name truncated]`;
}

export function normalizedQuickBooksReadPayload(options: {
  readonly toolName: string;
  readonly input: unknown;
  readonly result: unknown;
  readonly binding: QuickBooksReadBindingEvidence | null;
  readonly releaseVersion: string;
  readonly observedAt?: Date;
}): Record<string, unknown> {
  const profile = PROFILES[options.toolName];
  if (!profile) throw new Error(`No QuickBooks read evidence profile for ${options.toolName}`);
  const safeResult = safeQuickBooksReadResult(options.result);
  const resultRecord = objectRecord(safeResult);
  const observedAt = options.observedAt ?? new Date();
  const companyName = profile.kind === "connection"
    ? null
    : profile.kind === "target" && typeof resultRecord?.CompanyName === "string"
      ? resultRecord.CompanyName
      : options.binding?.companyName;
  const baseCurrency = profile.kind === "target"
    ? objectRecord(resultRecord?.HomeCurrency)?.value
    : undefined;
  const common = {
    result: safeResult,
    result_class: "succeeded" as const,
    fact_origin: "MCP_READ" as const,
    source_system: "quickbooks" as const,
    destination_role: profile.kind === "connection" ? "connector_control_plane" as const : "ledger_sor" as const,
    capability_id: profile.capabilityId,
    tool_call_or_audit_ref: `qbo-tool-call:${randomUUID()}`,
    capability_revision: `quickbooks-mcp@${options.releaseVersion}`,
    observed_at: observedAt.toISOString(),
    query_bounds: {
      target_scope: profile.kind === "connection"
        ? "connection_binding_resolution"
        : "active_server_bound_quickbooks_company",
      requested: safeQueryValue(options.input),
    },
    completeness: readCompleteness(profile, safeResult),
    output_hash: `sha256:${hashObject(safeResult)}`,
    fact_paths: factPaths(safeResult, profile),
  };
  if (profile.kind === "connection") {
    return {
      ...common,
      bound_target_ref_safe: null,
      organisation_display_name: null,
      binding_revision: null,
      connection_ref_safe: options.binding?.connectionRefSafe ?? null,
      connection_state: objectRecord(options.result)?.connected === true
        ? "connected"
        : objectRecord(options.result)?.connected === false ? "disconnected" : "unknown",
    };
  }
  return {
    ...common,
    bound_target_ref_safe: options.binding?.boundTargetRefSafe ?? null,
    organisation_display_name: safeDisplayName(companyName),
    binding_revision: options.binding?.bindingRevision ?? null,
    ...(profile.kind === "target"
      ? { base_currency: typeof baseCurrency === "string" ? baseCurrency : null }
      : {}),
  };
}
