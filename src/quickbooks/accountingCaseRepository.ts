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
    preparationPayloadHash?: string;
    operationSourceEvidenceHash?: string;
    mutationRequestId?: string;
    providerEntityId?: string;
    authorizationReceipt?: Record<string, unknown>;
    authorizationEvidence?: QuickBooksCaseOperationRecord["authorizationEvidence"];
    reuseEvidenceReceipt?: QuickBooksCaseOperationRecord["reuseEvidenceReceipt"];
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
  // target_session_ref is deliberately short lived. A later request may use a
  // freshly issued target proof, but it must still resolve to the exact same
  // server-owned OAuth installation, connection, binding revision, and Realm.
  // The original target hash remains immutable audit evidence on the Case; it
  // is not the durable identity of the Case itself.
  return quickBooksCaseBindingKey(left, "") === quickBooksCaseBindingKey(right, "") &&
    left.actorId === right.actorId;
}

export function initialQuickBooksCaseOperations(compiled: CompiledQuickBooksAccountingCase): QuickBooksCaseOperationRecord[] {
  return compiled.operations.map((operation) => ({ operation, state: "PENDING" }));
}
