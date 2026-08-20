export const QUICKBOOKS_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting" as const;

/**
 * Intuit stamps this trace id on every response — API, OAuth token and revoke
 * alike — and it is the first thing their support asks for. It is the only
 * handle we have on one specific Intuit-side request when a write's outcome is
 * in doubt, so it is read here once and shared by both Intuit HTTP surfaces.
 */
export const INTUIT_TRACE_HEADER = "intuit_tid";

/**
 * Bounded and restricted to printable ASCII before it is allowed anywhere near
 * a log line or a durable receipt. The value is upstream-controlled; nothing
 * downstream should have to defend against it. An absent or unusable header
 * yields undefined rather than a placeholder, so "we have no trace id" and
 * "Intuit gave us this trace id" never read the same.
 */
export function intuitTraceId(headers: Headers): string | undefined {
  const value = headers.get(INTUIT_TRACE_HEADER)?.trim();
  if (!value || value.length > 128 || !/^[\x20-\x7e]+$/u.test(value)) return undefined;
  return value;
}

export type QuickBooksEnvironment = "sandbox" | "production";

export interface QuickBooksOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: QuickBooksEnvironment;
}

export interface QuickBooksTokenSet {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  tokenType: string;
}

export interface QuickBooksTokenSource {
  accessToken(): Promise<string>;
  refreshAccessToken(): Promise<string>;
}

export interface QuickBooksReference {
  value?: string;
  name?: string;
}

export interface QuickBooksCompanyInfo {
  Id?: string;
  CompanyName?: string;
  LegalName?: string;
  Country?: string;
  FiscalYearStartMonth?: string;
  Email?: { Address?: string };
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export interface QuickBooksCompanyContext extends QuickBooksCompanyInfo {
  HomeCurrency: QuickBooksReference;
  MultiCurrencyEnabled?: boolean;
}

export interface QuickBooksPreferences {
  CurrencyPrefs?: {
    MultiCurrencyEnabled?: boolean;
    HomeCurrency?: QuickBooksReference;
  };
}

export interface QuickBooksAccount {
  Id?: string;
  Name?: string;
  FullyQualifiedName?: string;
  AccountType?: string;
  AccountSubType?: string;
  Classification?: string;
  CurrentBalance?: number;
  Active?: boolean;
  SyncToken?: string;
}

export interface QuickBooksTaxCode {
  Id?: string;
  Name?: string;
  Description?: string;
  Active?: boolean;
  Taxable?: boolean;
  TaxGroup?: boolean;
  PurchaseTaxRateList?: { TaxRateDetail?: Array<{ TaxRateRef?: QuickBooksReference }> };
  SalesTaxRateList?: { TaxRateDetail?: Array<{ TaxRateRef?: QuickBooksReference }> };
}

export interface QuickBooksTaxRate {
  Id?: string;
  Name?: string;
  Description?: string;
  RateValue?: number;
  Active?: boolean;
  SpecialTaxType?: string;
  AgencyRef?: QuickBooksReference;
}

export interface QuickBooksVendor {
  Id?: string;
  DisplayName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  CurrencyRef?: QuickBooksReference;
  Balance?: number;
  Active?: boolean;
  SyncToken?: string;
}

export interface QuickBooksCustomer {
  Id?: string;
  DisplayName?: string;
  CompanyName?: string;
  GivenName?: string;
  FamilyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  CurrencyRef?: QuickBooksReference;
  Balance?: number;
  Active?: boolean;
  SyncToken?: string;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export interface QuickBooksItem {
  Id?: string;
  Name?: string;
  FullyQualifiedName?: string;
  Description?: string;
  Type?: string;
  UnitPrice?: number;
  IncomeAccountRef?: QuickBooksReference;
  ExpenseAccountRef?: QuickBooksReference;
  AssetAccountRef?: QuickBooksReference;
  Taxable?: boolean;
  Active?: boolean;
  SyncToken?: string;
}

export interface QuickBooksBillLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: {
    AccountRef?: QuickBooksReference;
    TaxCodeRef?: QuickBooksReference;
    BillableStatus?: string;
    ClassRef?: QuickBooksReference;
    CustomerRef?: QuickBooksReference;
  };
  ItemBasedExpenseLineDetail?: {
    ItemRef?: QuickBooksReference;
    Qty?: number;
    UnitPrice?: number;
    TaxCodeRef?: QuickBooksReference;
    BillableStatus?: string;
    ClassRef?: QuickBooksReference;
    CustomerRef?: QuickBooksReference;
  };
}

export interface QuickBooksBill {
  Id?: string;
  SyncToken?: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  VendorRef?: QuickBooksReference;
  APAccountRef?: QuickBooksReference;
  CurrencyRef?: QuickBooksReference;
  ExchangeRate?: number;
  GlobalTaxCalculation?: string;
  TxnTaxDetail?: { TotalTax?: number };
  PrivateNote?: string;
  Line?: QuickBooksBillLine[];
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export interface QuickBooksQueryResponse<T> {
  QueryResponse?: T & {
    startPosition?: number;
    maxResults?: number;
    totalCount?: number;
  };
  time?: string;
}

export interface QuickBooksEntityResponse<T> {
  time?: string;
  requestId?: string;
  fault?: unknown;
  entity: T;
}

export interface QuickBooksBillSnapshotLine {
  lineId?: string;
  amount: string;
  description?: string;
  detailType?: "ACCOUNT" | "ITEM";
  account?: { id: string; name?: string };
  item?: { id: string; name?: string };
  quantity?: string;
  unitPrice?: string;
  taxCode?: { id: string; name?: string };
}

export interface QuickBooksBillSnapshot {
  billId: string;
  realmId: string;
  syncToken?: string;
  paymentStatus: "OPEN" | "PAID" | "UNKNOWN";
  vendor: { id: string; name?: string };
  apAccount?: { id: string; name?: string };
  txnDate?: string;
  dueDate?: string;
  docNumber?: string;
  currencyCode?: string;
  exchangeRate?: string;
  globalTaxCalculation?: string;
  total: string;
  balance?: string;
  totalTax?: string;
  privateNote?: string;
  lines: QuickBooksBillSnapshotLine[];
  updatedAt?: string;
}
