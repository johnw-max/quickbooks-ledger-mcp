import { AppError } from "../errors.js";
import type { QuickBooksAccountingCaseRecord } from "./accountingCase.js";
import {
  initialQuickBooksCaseOperations,
  quickBooksCaseBindingEqual,
  quickBooksCaseBindingKey,
  type QuickBooksAccountingCaseRepository,
} from "./accountingCaseRepository.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryQuickBooksAccountingCaseRepository implements QuickBooksAccountingCaseRepository {
  readonly #records = new Map<string, Map<number, QuickBooksAccountingCaseRecord>>();

  async readiness(): Promise<boolean> { return true; }

  async createOrAdvance(input: Parameters<QuickBooksAccountingCaseRepository["createOrAdvance"]>[0]) {
    const key = quickBooksCaseBindingKey(input.binding, input.compiled.caseId);
    const versions = this.#records.get(key) ?? new Map<number, QuickBooksAccountingCaseRecord>();
    const existing = versions.get(input.compiled.version);
    if (existing) {
      if (existing.compiledPlanHash !== input.compiledPlanHash) {
        throw new AppError("CONFLICT", "Accounting Case version already exists with a different immutable plan.", {
          httpStatus: 409, details: { failureLayer: "PERSISTENCE" },
        });
      }
      return { mode: "IDEMPOTENT_REPLAY" as const, record: copy(existing) };
    }
    const currentVersion = Math.max(0, ...versions.keys());
    if (input.compiled.version !== currentVersion + 1) {
      throw new AppError("CONFLICT", "Accounting Case expected_version is stale.", {
        httpStatus: 409, details: { currentVersion, failureLayer: "CASE_VERSION" },
      });
    }
    const previous = versions.get(currentVersion);
    if (previous && (previous.state === "EXECUTING" || previous.state === "RECOVERY_REQUIRED")) {
      throw new AppError("CONFLICT", "Accounting Case cannot advance while execution or recovery is active.", {
        httpStatus: 409, details: { failureLayer: "CASE_LIFECYCLE" },
      });
    }
    const record: QuickBooksAccountingCaseRecord = {
      binding: copy(input.binding),
      compiled: copy(input.compiled),
      compiledPlanHash: input.compiledPlanHash,
      state: input.compiled.status,
      operations: initialQuickBooksCaseOperations(input.compiled),
      createdAt: input.now,
      updatedAt: input.now,
    };
    versions.set(input.compiled.version, record);
    this.#records.set(key, versions);
    return { mode: currentVersion === 0 ? "CREATED" as const : "ADVANCED" as const, record: copy(record) };
  }

  async getBound(input: Parameters<QuickBooksAccountingCaseRepository["getBound"]>[0]) {
    const versions = this.#records.get(quickBooksCaseBindingKey(input.binding, input.caseId));
    if (!versions) return undefined;
    const version = input.version ?? Math.max(...versions.keys());
    const record = versions.get(version);
    if (!record || !quickBooksCaseBindingEqual(record.binding, input.binding)) return undefined;
    return copy(record);
  }

  async claimExecution(input: Parameters<QuickBooksAccountingCaseRepository["claimExecution"]>[0]) {
    const record = this.#required(input.binding, input.caseId, input.version);
    if (record.compiledPlanHash !== input.expectedPlanHash) {
      throw new AppError("CONFLICT", "Accounting Case plan hash changed.", { httpStatus: 409, details: { failureLayer: "PERSISTENCE" } });
    }
    if (record.state === "TERMINAL") return { mode: "ALREADY_TERMINAL" as const, record: copy(record) };
    if (record.state === "RECOVERY_REQUIRED") {
      if (record.executionRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case is owned by another recovery request.", { httpStatus: 409 });
      }
      return { mode: "RESUME" as const, record: copy(record) };
    }
    if (record.state === "EXECUTING") {
      if (record.executionRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case is already executing under another request_id.", { httpStatus: 409 });
      }
      return { mode: "RESUME" as const, record: copy(record) };
    }
    if (record.state === "BLOCKED_COVERAGE" || record.state === "BLOCKED_VALIDATION") {
      throw new AppError("VALIDATION_FAILED", "Accounting Case is not eligible for execution.", { httpStatus: 422 });
    }
    record.state = "EXECUTING";
    record.executionRequestId = input.requestId;
    record.updatedAt = input.now;
    return { mode: "CLAIMED" as const, record: copy(record) };
  }

  async updateOperation(input: Parameters<QuickBooksAccountingCaseRepository["updateOperation"]>[0]) {
    const record = this.#required(input.binding, input.caseId, input.version);
    if (record.executionRequestId !== input.requestId ||
      (record.state !== "EXECUTING" && record.state !== "RECOVERY_REQUIRED")) {
      throw new AppError("CONFLICT", "Accounting Case execution claim is not owned by this request.", { httpStatus: 409 });
    }
    const operation = record.operations.find((candidate) => candidate.operation.operationId === input.operationId);
    if (!operation) throw new AppError("NOT_FOUND", "Accounting Case operation was not found.", { httpStatus: 404 });
    if (!input.expectedStates.includes(operation.state)) {
      throw new AppError("CONFLICT", `Accounting Case operation cannot transition from ${operation.state}.`, { httpStatus: 409 });
    }
    operation.state = input.state;
    for (const key of ["preparationId", "preparationPayloadHash", "operationSourceEvidenceHash", "mutationRequestId",
      "providerEntityId", "authorizationReceipt", "authorizationEvidence", "reuseEvidenceReceipt",
      "writeReceipt", "readback", "errorReceipt"] as const) {
      const value = input[key];
      if (value !== undefined) (operation as unknown as Record<string, unknown>)[key] = copy(value);
    }
    record.updatedAt = input.now;
    return copy(record);
  }

  async finalize(input: Parameters<QuickBooksAccountingCaseRepository["finalize"]>[0]) {
    const record = this.#required(input.binding, input.caseId, input.version);
    if (record.executionRequestId !== input.requestId || (record.state !== "EXECUTING" && record.state !== "RECOVERY_REQUIRED")) {
      throw new AppError("CONFLICT", "Accounting Case cannot be finalized by this request.", { httpStatus: 409 });
    }
    if (input.state === "TERMINAL" && record.operations.some((operation) =>
      operation.state === "PENDING" || operation.state === "PREPARED" || operation.state === "WRITE_UNCERTAIN" ||
      operation.state === "READBACK_MISMATCH")) {
      throw new AppError("CONFLICT", "Accounting Case has unfinished operations.", { httpStatus: 409 });
    }
    if (input.state === "RECOVERY_REQUIRED" && !record.operations.some((operation) =>
      operation.state === "WRITE_UNCERTAIN" || operation.state === "READBACK_MISMATCH")) {
      throw new AppError("CONFLICT", "Accounting Case recovery requires uncertain or mismatched evidence.", { httpStatus: 409 });
    }
    record.state = input.state;
    record.terminalSummary = copy(input.terminalSummary);
    record.updatedAt = input.now;
    return copy(record);
  }

  #required(binding: Parameters<QuickBooksAccountingCaseRepository["getBound"]>[0]["binding"], caseId: string, version: number) {
    const versions = this.#records.get(quickBooksCaseBindingKey(binding, caseId));
    const record = versions?.get(version);
    if (!record || !quickBooksCaseBindingEqual(record.binding, binding)) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found for this exact QuickBooks binding.", { httpStatus: 404 });
    }
    return record;
  }
}
