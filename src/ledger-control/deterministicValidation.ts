import { z } from "zod/v4";
import { hashObject } from "../security/hash.js";

export const LEDGER_DETERMINISTIC_VALIDATOR_VERSION = "0.2.0";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const unsignedReceiptSchema = z.object({
  receiptType: z.literal("LEDGER_DETERMINISTIC_VALIDATION"),
  validatorVersion: z.string().trim().min(1).max(64),
  actionId: z.string().trim().min(1).max(128),
  canonicalPayloadHash: hashSchema,
  sourceRevisionHash: hashSchema,
  caseId: z.string().trim().min(1).max(128),
  caseVersion: z.number().int().positive(),
  policyVersion: z.string().trim().min(1).max(64),
  compilerVersion: z.string().trim().min(1).max(64),
  checks: z.array(z.object({
    code: z.string().trim().min(1).max(128),
    passed: z.literal(true),
    evidenceHash: hashSchema,
  }).strict()).min(1).max(128),
  issuedAt: z.string().datetime({ offset: true }),
}).strict();

export const deterministicValidationReceiptSchema = unsignedReceiptSchema.extend({
  receiptHash: hashSchema,
}).strict();

export type DeterministicValidationReceipt = z.infer<typeof deterministicValidationReceiptSchema>;

export function issueDeterministicValidationReceipt(input: {
  actionId: string;
  canonicalPayloadHash: string;
  sourceRevisionHash: string;
  caseId: string;
  caseVersion: number;
  policyVersion: string;
  compilerVersion: string;
  checks: readonly { code: string; evidence: Record<string, unknown> }[];
  now: Date;
}): DeterministicValidationReceipt {
  const unsigned = unsignedReceiptSchema.parse({
    receiptType: "LEDGER_DETERMINISTIC_VALIDATION",
    validatorVersion: LEDGER_DETERMINISTIC_VALIDATOR_VERSION,
    actionId: input.actionId,
    canonicalPayloadHash: input.canonicalPayloadHash,
    sourceRevisionHash: input.sourceRevisionHash,
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    policyVersion: input.policyVersion,
    compilerVersion: input.compilerVersion,
    checks: input.checks.map((check) => ({
      code: check.code,
      passed: true as const,
      evidenceHash: hashObject(check.evidence),
    })),
    issuedAt: input.now.toISOString(),
  });
  return Object.freeze({ ...unsigned, receiptHash: hashObject(unsigned) });
}

export function verifyDeterministicValidationReceipt(
  raw: unknown,
  expected: { actionId: string; canonicalPayloadHash: string; sourceRevisionHash: string; caseId: string; caseVersion: number },
): DeterministicValidationReceipt | undefined {
  const parsed = deterministicValidationReceiptSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { receiptHash, ...unsigned } = parsed.data;
  if (hashObject(unsigned) !== receiptHash) return undefined;
  if (unsigned.actionId !== expected.actionId || unsigned.canonicalPayloadHash !== expected.canonicalPayloadHash ||
      unsigned.sourceRevisionHash !== expected.sourceRevisionHash || unsigned.caseId !== expected.caseId ||
      unsigned.caseVersion !== expected.caseVersion) return undefined;
  return Object.freeze(parsed.data);
}
