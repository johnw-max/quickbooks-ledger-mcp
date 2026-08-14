import type {
  QuickBooksAccount,
  QuickBooksBillSnapshot,
  QuickBooksCompanyContext,
  QuickBooksCompanyInfo,
  QuickBooksCustomer,
  QuickBooksItem,
  QuickBooksSupplierBillInput,
  QuickBooksTaxCode,
  QuickBooksTaxRate,
  QuickBooksVendor,
} from "../providers/quickbooksTypes.js";
import type {
  QuickBooksAccountingProvider,
  QuickBooksBillListInput,
  QuickBooksBillListResult,
  QuickBooksExistingBillMatch,
  QuickBooksExistingDocumentMatch,
  QuickBooksReferenceValidationResult,
  QuickBooksSearchResult,
} from "../providers/quickbooksProvider.js";
import type {
  QuickBooksReportInput,
  QuickBooksTransactionEntity,
  QuickBooksTransactionListInput,
  QuickBooksTransactionListResult,
} from "../providers/quickbooksProvider.js";
import type { QuickBooksClientManager } from "./clientManager.js";
import { quickBooksProviderAccessDenyReasons } from "./clientManager.js";
import type {
  QuickBooksConnectionStatus,
  QuickBooksProviderCapabilities,
  QuickBooksProviderResolver,
  ResolvedQuickBooksProvider,
} from "./service.js";
import { AppError } from "../errors.js";
import { quickBooksBindingContext } from "./bindingContext.js";
import type { QuickBooksWritableEntity } from "./writePolicy.js";
import type { QuickBooksTargetSessionService } from "./targetSession.js";
import type {
  QuickBooksProviderMutationCommand,
  QuickBooksProviderWritePermit,
} from "../security/quickBooksProviderWritePermit.js";

class BoundQuickBooksProvider implements QuickBooksProviderCapabilities {
  readonly #actorId: string;
  readonly #connectionId: string;
  readonly #realmId: string;
  readonly #manager: QuickBooksClientManager;

  constructor(options: {
    actorId: string;
    connectionId: string;
    realmId: string;
    manager: QuickBooksClientManager;
  }) {
    this.#actorId = options.actorId;
    this.#connectionId = options.connectionId;
    this.#realmId = options.realmId;
    this.#manager = options.manager;
  }

  #withProvider<T>(action: (provider: QuickBooksAccountingProvider) => Promise<T>): Promise<T> {
    return this.#manager.withBoundProvider(
      this.#actorId,
      this.#connectionId,
      this.#realmId,
      action,
    );
  }

  getCompany(): Promise<QuickBooksCompanyInfo> {
    return this.#withProvider((provider) => provider.getCompany());
  }

  getCompanyContext(): Promise<QuickBooksCompanyContext> {
    return this.#withProvider((provider) => provider.getCompanyContext());
  }

  listAccounts(): Promise<QuickBooksAccount[]> {
    return this.#withProvider((provider) => provider.listAccounts());
  }

  listTaxCodes(): Promise<QuickBooksTaxCode[]> {
    return this.#withProvider((provider) => provider.listTaxCodes());
  }

  getTaxRate(taxRateId: string): Promise<QuickBooksTaxRate> {
    return this.#withProvider((provider) => provider.getTaxRate(taxRateId));
  }

  searchVendors(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksVendor>> {
    return this.#withProvider((provider) => provider.searchVendors(search, limit));
  }

  searchCustomers(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksCustomer>> {
    return this.#withProvider((provider) => provider.searchCustomers(search, limit));
  }

  listItems(): Promise<QuickBooksItem[]> {
    return this.#withProvider((provider) => provider.listItems());
  }

  listTransactions(input: QuickBooksTransactionListInput): Promise<QuickBooksTransactionListResult> {
    return this.#withProvider((provider) => provider.listTransactions(input));
  }

  getTransaction(entity: QuickBooksTransactionEntity, transactionId: string): Promise<Record<string, unknown>> {
    return this.#withProvider((provider) => provider.getTransaction(entity, transactionId));
  }

  runReport(input: QuickBooksReportInput): Promise<Record<string, unknown>> {
    return this.#withProvider((provider) => provider.runReport(input));
  }

  listBills(input?: QuickBooksBillListInput): Promise<QuickBooksBillListResult> {
    return this.#withProvider((provider) => provider.listBills(input));
  }

  getBill(billId: string): Promise<QuickBooksBillSnapshot> {
    return this.#withProvider((provider) => provider.getBill(billId));
  }

  findExistingSupplierBills(input: { vendorId: string; docNumber: string }): Promise<QuickBooksExistingBillMatch[]> {
    return this.#withProvider((provider) => provider.findExistingSupplierBills(input));
  }

  findExistingAccountingDocuments(input: {
    entity: QuickBooksExistingDocumentMatch["entity"];
    counterpartyId: string;
    docNumber: string;
  }): Promise<QuickBooksExistingDocumentMatch[]> {
    return this.#withProvider((provider) => provider.findExistingAccountingDocuments(input));
  }

  validateSupplierBill(input: QuickBooksSupplierBillInput): Promise<QuickBooksReferenceValidationResult> {
    return this.#withProvider((provider) => provider.validateSupplierBill(input));
  }

  createApprovedSupplierBill(input: QuickBooksSupplierBillInput, permit: QuickBooksProviderWritePermit): Promise<{
    bill: QuickBooksBillSnapshot;
    receipt: Record<string, unknown>;
  }> {
    return this.#withProvider((provider) => provider.createApprovedSupplierBill(input, permit));
  }

  getTrialBalance(date?: string): Promise<Record<string, unknown>> {
    return this.#withProvider((provider) => provider.getTrialBalance(date));
  }

  getMutationTarget(entity: QuickBooksWritableEntity, targetId: string): Promise<Record<string, unknown>> {
    return this.#withProvider((provider) => provider.getMutationTarget(entity, targetId));
  }

  executeMutation(
    input: QuickBooksProviderMutationCommand,
    permit: QuickBooksProviderWritePermit,
    recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
    markProviderDispatch: () => Promise<void>,
  ) {
    return this.#withProvider((provider) =>
      provider.executeMutation(input, permit, recordProviderOutcome, markProviderDispatch));
  }

  recoverMutation(input: QuickBooksProviderMutationCommand, providerEntityId: string) {
    return this.#withProvider((provider) => provider.recoverMutation(input, providerEntityId));
  }
}

export class ServerBoundQuickBooksProviderResolver implements QuickBooksProviderResolver {
  readonly #manager: QuickBooksClientManager;
  readonly #connectUrl: ((actorId: string) => Promise<{ url: string; expiresAt: Date }>) | undefined;
  readonly #targetSessions: QuickBooksTargetSessionService | undefined;

  constructor(options: {
    manager: QuickBooksClientManager;
    connectUrl?: (actorId: string) => Promise<{ url: string; expiresAt: Date }>;
    targetSessions?: QuickBooksTargetSessionService;
  }) {
    this.#manager = options.manager;
    this.#connectUrl = options.connectUrl;
    this.#targetSessions = options.targetSessions;
  }

  async connectionStatus(actorId: string): Promise<QuickBooksConnectionStatus> {
    const connect = this.#connectUrl ? await this.#connectUrl(actorId) : undefined;
    try {
      const connection = await this.#manager.resolveSingleConnection(actorId);
      const binding = quickBooksBindingContext(connection);
      return {
        connected: true,
        company: { realmId: connection.realmId, name: connection.companyName },
        scopes: connection.grantedScopes,
        connectionRefSafe: binding.connectionRefSafe,
        boundTargetRefSafe: binding.boundTargetRefSafe,
        bindingRevision: binding.bindingRevision,
        ...(connect ? {
          connectUrl: connect.url,
          connectUrlExpiresAt: connect.expiresAt.toISOString(),
          connectAction: "REPLACE_CURRENT_COMPANY" as const,
        } : {}),
      };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "NOT_CONNECTED") {
        throw error;
      }
      return {
        connected: false,
        scopes: [],
        connectionRefSafe: null,
        boundTargetRefSafe: null,
        bindingRevision: null,
        ...(connect ? {
          connectUrl: connect.url,
          connectUrlExpiresAt: connect.expiresAt.toISOString(),
          connectAction: "CONNECT_COMPANY" as const,
        } : {}),
      };
    }
  }

  async issueTargetSession(actorId: string) {
    if (!this.#targetSessions) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks target sessions are not configured.", {
        httpStatus: 503,
      });
    }
    const connection = await this.#manager.resolveSingleConnection(actorId);
    const binding = quickBooksBindingContext(connection);
    const session = this.#targetSessions.issue({
      actorId,
      connectionId: connection.connectionId,
      realmId: connection.realmId,
      bindingRevision: binding.bindingRevision,
    });
    return {
      companyName: connection.companyName,
      connectionRefSafe: binding.connectionRefSafe,
      boundTargetRefSafe: binding.boundTargetRefSafe,
      bindingRevision: binding.bindingRevision,
      targetSessionRef: session.targetSessionRef,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  async resolve(actorId: string, targetSessionRef?: string): Promise<ResolvedQuickBooksProvider> {
    if (!targetSessionRef) {
      if (this.#targetSessions) {
        throw new AppError("AUTH_REQUIRED", "Resolve the QuickBooks target before reading or preparing a write.", {
          httpStatus: 401,
          retryable: true,
        });
      }
      return this.#resolved(actorId, await this.#manager.resolveSingleConnection(actorId));
    }
    if (!this.#targetSessions) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks target sessions are not configured.", {
        httpStatus: 503,
      });
    }
    const claims = this.#targetSessions.verify(targetSessionRef, actorId);
    const connection = await this.#manager.resolveBoundConnection(
      actorId,
      claims.connectionId,
      claims.realmId,
    );
    const binding = quickBooksBindingContext(connection);
    if (binding.bindingRevision !== claims.bindingRevision) {
      throw new AppError("FORBIDDEN", "The QuickBooks target binding changed; resolve the target again.", {
        httpStatus: 409,
        retryable: true,
      });
    }
    return {
      ...this.#resolved(actorId, connection),
      targetSessionId: claims.sessionId,
      targetSessionExpiresAt: new Date(claims.expiresAt),
    };
  }

  async resolvePrepared(
    actorId: string,
    expectedRealmId: string,
    expectedBindingRevision?: string,
  ): Promise<ResolvedQuickBooksProvider> {
    const connection = await this.#manager.resolveSingleConnection(actorId);
    const binding = quickBooksBindingContext(connection);
    if (
      connection.realmId !== expectedRealmId ||
      (expectedBindingRevision !== undefined && binding.bindingRevision !== expectedBindingRevision)
    ) {
      throw new AppError("FORBIDDEN", "The prepared QuickBooks target no longer matches the active OAuth binding.", {
        httpStatus: 403,
      });
    }
    return this.#resolved(actorId, connection);
  }

  #resolved(actorId: string, connection: Awaited<ReturnType<QuickBooksClientManager["resolveSingleConnection"]>>): ResolvedQuickBooksProvider {
    const binding = quickBooksBindingContext(connection);
    return {
      realmId: connection.realmId,
      companyName: connection.companyName,
      connectionRefSafe: binding.connectionRefSafe,
      boundTargetRefSafe: binding.boundTargetRefSafe,
      bindingRevision: binding.bindingRevision,
      providerAccessDenyReasons: quickBooksProviderAccessDenyReasons(connection),
      provider: new BoundQuickBooksProvider({
        actorId,
        connectionId: connection.connectionId,
        realmId: connection.realmId,
        manager: this.#manager,
      }),
    };
  }
}
