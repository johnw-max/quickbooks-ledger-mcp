import type {
  CompiledQuickBooksAccountingCase,
  QuickBooksAccountingCaseRecord,
  QuickBooksCaseBinding,
  QuickBooksCaseOperationRecord,
  QuickBooksCaseOperationState,
} from "./accountingCase.js";

export interface QuickBooksAccountingCaseRepository {
  readiness(): Promise<boolean>;
  createOrAdvance(input: {
    binding: QuickBooksCaseBinding;
    compiled: CompiledQuickBooksAccountingCase;
    compiledPlanHash: string;
    now: Date;
  }): Promise<{ mode: "CREATED" | "ADVANCED" | "IDEMPOTENT_REPLAY"; record: QuickBooksAccountingCaseRecord }>;
  getBound(input: {
    binding: QuickBooksCaseBinding;
    caseId: string;
    version?: number;
  }): Promise<QuickBooksAccountingCaseRecord | undefined>;
  claimExecution(input: {
    binding: QuickBooksCaseBinding;
    caseId: string;
    version: number;
    requestId: string;
    expectedPlanHash: string;
    now: Date;
  }): Promise<{ mode: "CLAIMED" | "RESUME" | "ALREADY_TERMINAL"; record: QuickBooksAccountingCaseRecord }>;
  updateOperation(input: {
    binding: QuickBooksCaseBinding;
    caseId: string;
    version: number;
    operationId: string;
    requestId: string;
    expectedStates: QuickBooksCaseOperationState[];
    state: QuickBooksCaseOperationState;
    preparationId?: string;
    mutationRequestId?: string;
    providerEntityId?: string;
    authorizationReceipt?: Record<string, unknown>;
    writeReceipt?: Record<string, unknown>;
    readback?: Record<string, unknown>;
    errorReceipt?: Record<string, unknown>;
    now: Date;
  }): Promise<QuickBooksAccountingCaseRecord>;
  finalize(input: {
    binding: QuickBooksCaseBinding;
    caseId: string;
    version: number;
    requestId: string;
    state: "RECOVERY_REQUIRED" | "TERMINAL";
    terminalSummary: Record<string, unknown>;
    now: Date;
  }): Promise<QuickBooksAccountingCaseRecord>;
}

export function quickBooksCaseBindingKey(binding: QuickBooksCaseBinding, caseId: string): string {
  return [binding.workspaceId, binding.subjectType, binding.subjectId, binding.agentId, binding.installationId,
    binding.bindingId, binding.bindingRevision, binding.connectionId, binding.realmId, caseId].join("\u0000");
}

export function quickBooksCaseBindingEqual(left: QuickBooksCaseBinding, right: QuickBooksCaseBinding): boolean {
  return quickBooksCaseBindingKey(left, "") === quickBooksCaseBindingKey(right, "") &&
    left.actorId === right.actorId && left.targetSessionHash === right.targetSessionHash;
}

export function initialQuickBooksCaseOperations(compiled: CompiledQuickBooksAccountingCase): QuickBooksCaseOperationRecord[] {
  return compiled.operations.map((operation) => ({ operation, state: "PENDING" }));
}
