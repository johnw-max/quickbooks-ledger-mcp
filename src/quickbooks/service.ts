import { AppError } from "../errors.js";
import type {
  QuickBooksBillListInput,
  QuickBooksBillListResult,
  QuickBooksExistingDocumentMatch,
  QuickBooksSearchResult,
} from "../providers/quickbooksProvider.js";
import type {
  QuickBooksReportInput,
  QuickBooksTransactionEntity,
  QuickBooksTransactionListInput,
  QuickBooksTransactionListResult,
} from "../providers/quickbooksProvider.js";
import type {
  QuickBooksAccount,
  QuickBooksBillSnapshot,
  QuickBooksCompanyContext,
  QuickBooksCompanyInfo,
  QuickBooksCustomer,
  QuickBooksItem,
  QuickBooksTaxCode,
  QuickBooksTaxRate,
  QuickBooksVendor,
} from "../providers/quickbooksTypes.js";
import type {
  QuickBooksProviderMutationCommand,
  QuickBooksProviderWritePermit,
} from "../security/quickBooksProviderWritePermit.js";
import type {
  QuickBooksGetBillInput,
  QuickBooksListBillsToolInput,
  QuickBooksSearchVendorsInput,
  QuickBooksSearchCustomersInput,
  QuickBooksListTransactionsInput,
  QuickBooksGetTransactionInput,
  QuickBooksRunReportInput,
  QuickBooksTrialBalanceInput,
} from "./schemas.js";
import type { QuickBooksWritableEntity } from "./writePolicy.js";

export interface QuickBooksConnectionStatus {
  connected: boolean;
  company?: { realmId: string; name: string };
  scopes: string[];
  connectionRefSafe: string | null;
  boundTargetRefSafe: string | null;
  bindingRevision: string | null;
  connectUrl?: string;
  connectUrlExpiresAt?: string;
  connectAction?: "CONNECT_COMPANY" | "REPLACE_CURRENT_COMPANY";
}

export interface ResolvedQuickBooksProvider {
  realmId: string;
  companyName: string;
  connectionRefSafe: string;
  boundTargetRefSafe: string;
  bindingRevision: string;
  /** Provider OAuth deny reasons checked before autonomous authorization. Intuit does not supply dynamic roles. */
  providerAccessDenyReasons?: readonly string[];
  targetSessionId?: string;
  targetSessionExpiresAt?: Date;
  provider: QuickBooksProviderCapabilities;
}

export interface QuickBooksReadSnapshot<T> {
  readonly result: T;
  readonly binding: Pick<
    ResolvedQuickBooksProvider,
    "companyName" | "connectionRefSafe" | "boundTargetRefSafe" | "bindingRevision"
  >;
}

export interface QuickBooksProviderCapabilities {
  getCompany(): Promise<QuickBooksCompanyInfo>;
  getCompanyContext(): Promise<QuickBooksCompanyContext>;
  listAccounts(): Promise<QuickBooksAccount[]>;
  listTaxCodes(): Promise<QuickBooksTaxCode[]>;
  getTaxRate(taxRateId: string): Promise<QuickBooksTaxRate>;
  searchVendors(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksVendor>>;
  searchCustomers(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksCustomer>>;
  listItems(): Promise<QuickBooksItem[]>;
  listTransactions(input: QuickBooksTransactionListInput): Promise<QuickBooksTransactionListResult>;
  getTransaction(entity: QuickBooksTransactionEntity, transactionId: string): Promise<Record<string, unknown>>;
  runReport(input: QuickBooksReportInput): Promise<Record<string, unknown>>;
  listBills(input?: QuickBooksBillListInput): Promise<QuickBooksBillListResult>;
  getBill(billId: string): Promise<QuickBooksBillSnapshot>;
  findExistingAccountingDocuments(input: {
    entity: QuickBooksExistingDocumentMatch["entity"];
    counterpartyId: string;
    docNumber: string;
  }): Promise<QuickBooksExistingDocumentMatch[]>;
  getTrialBalance(date?: string): Promise<Record<string, unknown>>;
  getMutationTarget(entity: QuickBooksWritableEntity, targetId: string): Promise<Record<string, unknown>>;
  executeMutation(
    input: QuickBooksProviderMutationCommand,
    permit: QuickBooksProviderWritePermit,
    recordProviderOutcome: (outcome: {
      providerEntityId: string;
      receipt: Record<string, unknown>;
    }) => Promise<void>,
    markProviderDispatch: () => Promise<void>,
  ): Promise<{
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
  }>;
  recoverMutation(input: QuickBooksProviderMutationCommand, providerEntityId: string): Promise<{
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
  }>;
}

export interface QuickBooksProviderResolver {
  connectionStatus(actorId: string): Promise<QuickBooksConnectionStatus>;
  issueTargetSession?(actorId: string): Promise<QuickBooksResolvedTarget>;
  resolve(actorId: string, targetSessionRef?: string): Promise<ResolvedQuickBooksProvider>;
  resolvePrepared?(
    actorId: string,
    expectedRealmId: string,
    expectedBindingRevision?: string,
  ): Promise<ResolvedQuickBooksProvider>;
}

export interface QuickBooksResolvedTarget {
  companyName: string;
  connectionRefSafe: string;
  boundTargetRefSafe: string;
  bindingRevision: string;
  targetSessionRef: string;
  expiresAt: string;
}

export class QuickBooksWorkflowService {
  readonly #resolver: QuickBooksProviderResolver;

  constructor(options: { resolver: QuickBooksProviderResolver }) {
    this.#resolver = options.resolver;
  }

  connectionStatus(actorId: string): Promise<QuickBooksConnectionStatus> {
    return this.#resolver.connectionStatus(actorId);
  }

  resolveTarget(actorId: string): Promise<QuickBooksResolvedTarget> {
    if (!this.#resolver.issueTargetSession) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks target sessions are not configured.", {
        httpStatus: 503,
      });
    }
    return this.#resolver.issueTargetSession(actorId);
  }

  async #read<T>(
    actorId: string,
    targetSessionRef: string | undefined,
    action: (provider: QuickBooksProviderCapabilities) => Promise<T>,
  ): Promise<QuickBooksReadSnapshot<T>> {
    const resolved = await this.#resolver.resolve(actorId, targetSessionRef);
    const result = await action(resolved.provider);
    return {
      result,
      binding: {
        companyName: resolved.companyName,
        connectionRefSafe: resolved.connectionRefSafe,
        boundTargetRefSafe: resolved.boundTargetRefSafe,
        bindingRevision: resolved.bindingRevision,
      },
    };
  }

  async getCompany(actorId: string, targetSessionRef?: string): Promise<QuickBooksCompanyContext> {
    return (await this.getCompanyRead(actorId, targetSessionRef)).result;
  }

  getCompanyRead(actorId: string, targetSessionRef?: string): Promise<QuickBooksReadSnapshot<QuickBooksCompanyContext>> {
    return this.#read(actorId, targetSessionRef, (provider) => provider.getCompanyContext());
  }

  async listAccounts(actorId: string, targetSessionRef?: string): Promise<QuickBooksAccount[]> {
    return (await this.listAccountsRead(actorId, targetSessionRef)).result;
  }

  listAccountsRead(actorId: string, targetSessionRef?: string): Promise<QuickBooksReadSnapshot<QuickBooksAccount[]>> {
    return this.#read(actorId, targetSessionRef, (provider) => provider.listAccounts());
  }

  async listTaxCodes(actorId: string, targetSessionRef?: string): Promise<QuickBooksTaxCode[]> {
    return (await this.listTaxCodesRead(actorId, targetSessionRef)).result;
  }

  listTaxCodesRead(actorId: string, targetSessionRef?: string): Promise<QuickBooksReadSnapshot<QuickBooksTaxCode[]>> {
    return this.#read(actorId, targetSessionRef, (provider) => provider.listTaxCodes());
  }

  async searchVendors(actorId: string, input: QuickBooksSearchVendorsInput): Promise<QuickBooksSearchResult<QuickBooksVendor>> {
    return (await this.searchVendorsRead(actorId, input)).result;
  }

  searchVendorsRead(
    actorId: string,
    input: QuickBooksSearchVendorsInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksSearchResult<QuickBooksVendor>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.searchVendors(input.query, input.limit));
  }

  async searchCustomers(actorId: string, input: QuickBooksSearchCustomersInput): Promise<QuickBooksSearchResult<QuickBooksCustomer>> {
    return (await this.searchCustomersRead(actorId, input)).result;
  }

  searchCustomersRead(
    actorId: string,
    input: QuickBooksSearchCustomersInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksSearchResult<QuickBooksCustomer>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.searchCustomers(input.query, input.limit));
  }

  async listItems(actorId: string, targetSessionRef?: string): Promise<QuickBooksItem[]> {
    return (await this.listItemsRead(actorId, targetSessionRef)).result;
  }

  listItemsRead(actorId: string, targetSessionRef?: string): Promise<QuickBooksReadSnapshot<QuickBooksItem[]>> {
    return this.#read(actorId, targetSessionRef, (provider) => provider.listItems());
  }

  async listTransactions(actorId: string, input: QuickBooksListTransactionsInput): Promise<QuickBooksTransactionListResult> {
    return (await this.listTransactionsRead(actorId, input)).result;
  }

  listTransactionsRead(
    actorId: string,
    input: QuickBooksListTransactionsInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksTransactionListResult>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.listTransactions({
      entity: input.entity,
      ...(input.date_from ? { dateFrom: input.date_from } : {}),
      ...(input.date_to ? { dateTo: input.date_to } : {}),
      ...(input.customer_id ? { customerId: input.customer_id } : {}),
      ...(input.vendor_id ? { vendorId: input.vendor_id } : {}),
      ...(input.open_only === undefined ? {} : { openOnly: input.open_only }),
      page: input.page,
      pageSize: input.page_size,
    }));
  }

  async getTransaction(actorId: string, input: QuickBooksGetTransactionInput): Promise<Record<string, unknown>> {
    return (await this.getTransactionRead(actorId, input)).result;
  }

  getTransactionRead(
    actorId: string,
    input: QuickBooksGetTransactionInput,
  ): Promise<QuickBooksReadSnapshot<Record<string, unknown>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.getTransaction(input.entity, input.transaction_id));
  }

  async runReport(actorId: string, input: QuickBooksRunReportInput): Promise<Record<string, unknown>> {
    return (await this.runReportRead(actorId, input)).result;
  }

  runReportRead(
    actorId: string,
    input: QuickBooksRunReportInput,
  ): Promise<QuickBooksReadSnapshot<Record<string, unknown>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.runReport({
      report: input.report,
      ...(input.start_date ? { startDate: input.start_date } : {}),
      ...(input.end_date ? { endDate: input.end_date } : {}),
      ...(input.as_of_date ? { asOfDate: input.as_of_date } : {}),
      ...(input.accounting_method ? { accountingMethod: input.accounting_method } : {}),
      ...(input.customer_id ? { customerId: input.customer_id } : {}),
      ...(input.vendor_id ? { vendorId: input.vendor_id } : {}),
      maxRows: input.max_rows,
      view: input.view,
    }));
  }

  async listBills(actorId: string, input: QuickBooksListBillsToolInput): Promise<QuickBooksBillListResult> {
    return (await this.listBillsRead(actorId, input)).result;
  }

  listBillsRead(
    actorId: string,
    input: QuickBooksListBillsToolInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksBillListResult>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.listBills({
      ...(input.date_from ? { dateFrom: input.date_from } : {}),
      ...(input.date_to ? { dateTo: input.date_to } : {}),
      page: input.page,
      pageSize: input.page_size,
    }));
  }

  async getBill(actorId: string, input: QuickBooksGetBillInput): Promise<QuickBooksBillSnapshot> {
    return (await this.getBillRead(actorId, input)).result;
  }

  getBillRead(
    actorId: string,
    input: QuickBooksGetBillInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksBillSnapshot>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.getBill(input.bill_id));
  }

  async getTrialBalance(actorId: string, input: QuickBooksTrialBalanceInput): Promise<Record<string, unknown>> {
    return (await this.getTrialBalanceRead(actorId, input)).result;
  }

  getTrialBalanceRead(
    actorId: string,
    input: QuickBooksTrialBalanceInput,
  ): Promise<QuickBooksReadSnapshot<Record<string, unknown>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.getTrialBalance(input.date));
  }
}
