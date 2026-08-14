import { z } from "zod/v4";
import type { LedgerAutonomousAuthorizationReceipt } from "../ledger-control/ledgerControlKernel.js";
import {
  deterministicValidationReceiptSchema,
  verifyDeterministicValidationReceipt,
  type DeterministicValidationReceipt,
} from "../ledger-control/deterministicValidation.js";
import { hashObject } from "../security/hash.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const recordSchema = z.record(z.string(), z.unknown());

const authorizationEvidenceUnsignedSchema = z.object({
  evidenceType: z.literal("QUICKBOOKS_AUTONOMOUS_WRITE_AUTHORIZATION"),
  evidenceVersion: z.literal("1.0"),
  preparationId: z.string().regex(/^qbm_[a-f0-9]{32}$/u),
  providerRequestId: z.string().trim().min(1),
  stableOperationKey: hashSchema,
  actionId: z.string().trim().min(1),
  preparationPayloadHash: hashSchema,
  canonicalPayloadHash: hashSchema,
  originCaseId: z.string().trim().min(1),
  originCaseVersion: z.number().int().positive(),
  sourceRevisionHash: hashSchema,
  deterministicValidationReceipt: deterministicValidationReceiptSchema,
  authorizationReceipt: recordSchema,
  authorizationReceiptHash: hashSchema,
  recordedAt: z.string().datetime({ offset: true }),
}).strict();

export const quickBooksAutonomousAuthorizationEvidenceSchema = authorizationEvidenceUnsignedSchema.extend({
  authorizationIdentityHash: hashSchema,
}).strict();

export type QuickBooksAutonomousAuthorizationEvidence = z.infer<
  typeof quickBooksAutonomousAuthorizationEvidenceSchema
>;

export interface QuickBooksAutonomousAuthorizationDelegationIdentity {
  delegationId: string;
  delegationRevision: number;
  approvedBy: string;
}

const reuseEvidenceUnsignedSchema = z.object({
  evidenceType: z.literal("QUICKBOOKS_ACCOUNTING_CASE_MUTATION_REUSE"),
  evidenceVersion: z.literal("1.0"),
  preparationId: z.string().regex(/^qbm_[a-f0-9]{32}$/u),
  providerRequestId: z.string().trim().min(1),
  providerEntityId: z.string().trim().min(1),
  stableOperationKey: hashSchema,
  actionId: z.string().trim().min(1),
  canonicalPayloadHash: hashSchema,
  caseId: z.string().trim().min(1),
  caseVersion: z.number().int().positive(),
  sourceRevisionHash: hashSchema,
  currentDeterministicValidationReceiptHash: hashSchema,
  currentDelegationId: z.string().trim().min(1),
  currentDelegationRevision: z.number().int().positive(),
  currentProviderCapabilityReceiptHash: hashSchema,
  originalAuthorizationIdentityHash: hashSchema,
  originalAuthorizationReceiptHash: hashSchema,
  issuedAt: z.string().datetime({ offset: true }),
}).strict();

export const quickBooksMutationReuseEvidenceSchema = reuseEvidenceUnsignedSchema.extend({
  receiptHash: hashSchema,
}).strict();

export type QuickBooksMutationReuseEvidence = z.infer<typeof quickBooksMutationReuseEvidenceSchema>;

function validEmbeddedReceiptHash(receipt: Record<string, unknown>): boolean {
  if (typeof receipt.receiptHash !== "string") return false;
  const { receiptHash, ...unsigned } = receipt;
  return hashObject(unsigned) === receiptHash;
}

export function issueQuickBooksAutonomousAuthorizationEvidence(input: {
  preparationId: string;
  providerRequestId: string;
  stableOperationKey: string;
  actionId: string;
  preparationPayloadHash: string;
  canonicalPayloadHash: string;
  caseId: string;
  caseVersion: number;
  sourceRevisionHash: string;
  deterministicValidationReceipt: DeterministicValidationReceipt;
  authorizationReceipt: LedgerAutonomousAuthorizationReceipt;
  recordedAt: Date;
}): QuickBooksAutonomousAuthorizationEvidence {
  if (!validEmbeddedReceiptHash(input.authorizationReceipt as unknown as Record<string, unknown>)) {
    throw new Error("QuickBooks autonomous authorization receipt hash is invalid");
  }
  if (input.authorizationReceipt.actionId !== input.actionId ||
      input.authorizationReceipt.canonicalPayloadHash !== input.canonicalPayloadHash ||
      input.authorizationReceipt.sourceRevisionHash !== input.sourceRevisionHash ||
      input.authorizationReceipt.caseVersion !== input.caseVersion ||
      input.authorizationReceipt.deterministicValidationReceiptHash !== input.deterministicValidationReceipt.receiptHash) {
    throw new Error("QuickBooks autonomous authorization receipt does not match its originating Case evidence");
  }
  const validation = verifyDeterministicValidationReceipt(input.deterministicValidationReceipt, {
    actionId: input.actionId,
    canonicalPayloadHash: input.canonicalPayloadHash,
    sourceRevisionHash: input.sourceRevisionHash,
    caseId: input.caseId,
    caseVersion: input.caseVersion,
  });
  if (!validation) throw new Error("QuickBooks deterministic validation receipt is invalid");
  const unsigned = authorizationEvidenceUnsignedSchema.parse({
    evidenceType: "QUICKBOOKS_AUTONOMOUS_WRITE_AUTHORIZATION",
    evidenceVersion: "1.0",
    preparationId: input.preparationId,
    providerRequestId: input.providerRequestId,
    stableOperationKey: input.stableOperationKey,
    actionId: input.actionId,
    preparationPayloadHash: input.preparationPayloadHash,
    canonicalPayloadHash: input.canonicalPayloadHash,
    originCaseId: input.caseId,
    originCaseVersion: input.caseVersion,
    sourceRevisionHash: input.sourceRevisionHash,
    deterministicValidationReceipt: input.deterministicValidationReceipt,
    authorizationReceipt: input.authorizationReceipt,
    authorizationReceiptHash: input.authorizationReceipt.receiptHash,
    recordedAt: input.recordedAt.toISOString(),
  });
  return Object.freeze({ ...unsigned, authorizationIdentityHash: hashObject(unsigned) });
}

export function verifyQuickBooksAutonomousAuthorizationEvidence(
  raw: unknown,
  expected: {
    preparationId: string;
    providerRequestId: string;
    stableOperationKey: string;
    actionId: string;
    actorId: string;
    realmId: string;
    preparationPayloadHash: string;
    canonicalPayloadHash: string;
  },
): QuickBooksAutonomousAuthorizationEvidence | undefined {
  const parsed = quickBooksAutonomousAuthorizationEvidenceSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { authorizationIdentityHash, ...unsigned } = parsed.data;
  if (hashObject(unsigned) !== authorizationIdentityHash ||
      !validEmbeddedReceiptHash(parsed.data.authorizationReceipt) ||
      parsed.data.authorizationReceipt.receiptHash !== parsed.data.authorizationReceiptHash ||
      parsed.data.preparationId !== expected.preparationId ||
      parsed.data.providerRequestId !== expected.providerRequestId ||
      parsed.data.stableOperationKey !== expected.stableOperationKey ||
      parsed.data.actionId !== expected.actionId ||
      parsed.data.preparationPayloadHash !== expected.preparationPayloadHash ||
      parsed.data.canonicalPayloadHash !== expected.canonicalPayloadHash) return undefined;
  const authorization = parsed.data.authorizationReceipt;
  if (authorization.receiptType !== "LEDGER_AUTONOMOUS_AUTHORIZATION" ||
      authorization.providerId !== "quickbooks" ||
      authorization.actorId !== expected.actorId ||
      authorization.tenantId !== expected.realmId ||
      typeof authorization.delegationId !== "string" || authorization.delegationId.length === 0 ||
      typeof authorization.delegationRevision !== "number" || !Number.isSafeInteger(authorization.delegationRevision) ||
      authorization.actionId !== parsed.data.actionId ||
      authorization.canonicalPayloadHash !== parsed.data.canonicalPayloadHash ||
      authorization.sourceRevisionHash !== parsed.data.sourceRevisionHash ||
      authorization.caseVersion !== parsed.data.originCaseVersion ||
      authorization.deterministicValidationReceiptHash !== parsed.data.deterministicValidationReceipt.receiptHash) {
    return undefined;
  }
  if (!verifyDeterministicValidationReceipt(parsed.data.deterministicValidationReceipt, {
    actionId: parsed.data.actionId,
    canonicalPayloadHash: parsed.data.canonicalPayloadHash,
    sourceRevisionHash: parsed.data.sourceRevisionHash,
    caseId: parsed.data.originCaseId,
    caseVersion: parsed.data.originCaseVersion,
  })) return undefined;
  return Object.freeze(parsed.data);
}

/**
 * Resolve the only execution actor that may claim a mutation carrying this
 * autonomous authorization. Repositories call this at their state-transition
 * boundary so a later human approval (or a different standing delegation)
 * cannot borrow an earlier receipt and rewrite the causal history.
 */
export function resolveQuickBooksAutonomousAuthorizationDelegationIdentity(
  raw: unknown,
  expected: {
    preparationId: string;
    providerRequestId: string;
    actorId: string;
    realmId: string;
    preparationPayloadHash: string;
  },
): QuickBooksAutonomousAuthorizationDelegationIdentity | undefined {
  const envelope = quickBooksAutonomousAuthorizationEvidenceSchema.safeParse(raw);
  if (!envelope.success) return undefined;
  const verified = verifyQuickBooksAutonomousAuthorizationEvidence(envelope.data, {
    ...expected,
    stableOperationKey: envelope.data.stableOperationKey,
    actionId: envelope.data.actionId,
    canonicalPayloadHash: envelope.data.canonicalPayloadHash,
  });
  if (!verified) return undefined;
  const { delegationId, delegationRevision } = verified.authorizationReceipt;
  if (typeof delegationId !== "string" || delegationId.trim() !== delegationId || delegationId.length === 0 ||
      typeof delegationRevision !== "number" || !Number.isSafeInteger(delegationRevision) || delegationRevision <= 0) {
    return undefined;
  }
  return Object.freeze({
    delegationId,
    delegationRevision,
    approvedBy: `standing:${delegationId}`,
  });
}

export function issueQuickBooksMutationReuseEvidence(input: {
  authorizationEvidence: QuickBooksAutonomousAuthorizationEvidence;
  providerEntityId: string;
  stableOperationKey: string;
  actionId: string;
  canonicalPayloadHash: string;
  caseId: string;
  caseVersion: number;
  sourceRevisionHash: string;
  deterministicValidationReceipt: DeterministicValidationReceipt;
  currentDelegationId: string;
  currentDelegationRevision: number;
  currentProviderCapabilityReceiptHash: string;
  issuedAt: Date;
}): QuickBooksMutationReuseEvidence {
  const authorizationReceipt = input.authorizationEvidence.authorizationReceipt;
  const verifiedAuthorization = typeof authorizationReceipt.actorId === "string" &&
      typeof authorizationReceipt.tenantId === "string"
    ? verifyQuickBooksAutonomousAuthorizationEvidence(input.authorizationEvidence, {
        preparationId: input.authorizationEvidence.preparationId,
        providerRequestId: input.authorizationEvidence.providerRequestId,
        stableOperationKey: input.stableOperationKey,
        actionId: input.actionId,
        actorId: authorizationReceipt.actorId,
        realmId: authorizationReceipt.tenantId,
        preparationPayloadHash: input.authorizationEvidence.preparationPayloadHash,
        canonicalPayloadHash: input.canonicalPayloadHash,
      })
    : undefined;
  if (!verifiedAuthorization || !verifyDeterministicValidationReceipt(input.deterministicValidationReceipt, {
    actionId: input.actionId,
    canonicalPayloadHash: input.canonicalPayloadHash,
    sourceRevisionHash: input.sourceRevisionHash,
    caseId: input.caseId,
    caseVersion: input.caseVersion,
  })) {
    throw new Error("QuickBooks mutation reuse evidence inputs failed deterministic verification");
  }
  const unsigned = reuseEvidenceUnsignedSchema.parse({
    evidenceType: "QUICKBOOKS_ACCOUNTING_CASE_MUTATION_REUSE",
    evidenceVersion: "1.0",
    preparationId: input.authorizationEvidence.preparationId,
    providerRequestId: input.authorizationEvidence.providerRequestId,
    providerEntityId: input.providerEntityId,
    stableOperationKey: input.stableOperationKey,
    actionId: input.actionId,
    canonicalPayloadHash: input.canonicalPayloadHash,
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    sourceRevisionHash: input.sourceRevisionHash,
    currentDeterministicValidationReceiptHash: input.deterministicValidationReceipt.receiptHash,
    currentDelegationId: input.currentDelegationId,
    currentDelegationRevision: input.currentDelegationRevision,
    currentProviderCapabilityReceiptHash: input.currentProviderCapabilityReceiptHash,
    originalAuthorizationIdentityHash: input.authorizationEvidence.authorizationIdentityHash,
    originalAuthorizationReceiptHash: input.authorizationEvidence.authorizationReceiptHash,
    issuedAt: input.issuedAt.toISOString(),
  });
  return Object.freeze({ ...unsigned, receiptHash: hashObject(unsigned) });
}

export function verifyQuickBooksMutationReuseEvidence(
  raw: unknown,
  expected: {
    authorizationEvidence: QuickBooksAutonomousAuthorizationEvidence;
    providerEntityId: string;
    stableOperationKey: string;
    actionId: string;
    canonicalPayloadHash: string;
    caseId: string;
    caseVersion: number;
    sourceRevisionHash: string;
    deterministicValidationReceiptHash: string;
  },
): QuickBooksMutationReuseEvidence | undefined {
  const parsed = quickBooksMutationReuseEvidenceSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { receiptHash, ...unsigned } = parsed.data;
  if (hashObject(unsigned) !== receiptHash) return undefined;
  if (parsed.data.preparationId !== expected.authorizationEvidence.preparationId ||
      parsed.data.providerRequestId !== expected.authorizationEvidence.providerRequestId ||
      parsed.data.providerEntityId !== expected.providerEntityId ||
      parsed.data.stableOperationKey !== expected.stableOperationKey ||
      parsed.data.actionId !== expected.actionId ||
      parsed.data.canonicalPayloadHash !== expected.canonicalPayloadHash ||
      parsed.data.caseId !== expected.caseId ||
      parsed.data.caseVersion !== expected.caseVersion ||
      parsed.data.sourceRevisionHash !== expected.sourceRevisionHash ||
      parsed.data.currentDeterministicValidationReceiptHash !== expected.deterministicValidationReceiptHash ||
      parsed.data.originalAuthorizationIdentityHash !== expected.authorizationEvidence.authorizationIdentityHash ||
      parsed.data.originalAuthorizationReceiptHash !== expected.authorizationEvidence.authorizationReceiptHash) {
    return undefined;
  }
  return Object.freeze(parsed.data);
}
