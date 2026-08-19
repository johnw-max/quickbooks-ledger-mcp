import { z } from "zod/v4";
import { sha256 } from "../security/hash.js";

/**
 * The durable record of a person looking in QuickBooks and taking
 * responsibility for what is there.
 *
 * It is the only exit from WRITE_RESULT_UNKNOWN_NO_ID, which is reached when no
 * Provider response ever completed. No automatic decision is possible from
 * there — that is precisely what "unknown" means — so the exit is evidence, not
 * inference. Migration 038 re-checks every field below against the durable row
 * before the receipt may be stored; nothing here is trusted because the
 * application produced it.
 */
export const QUICKBOOKS_OPERATOR_RESOLUTION_EVIDENCE_TYPE = "QUICKBOOKS_OPERATOR_RESOLUTION";

export const QUICKBOOKS_OPERATOR_RESOLUTION_FINDINGS = ["ABSENT", "PRESENT"] as const;

export type QuickBooksOperatorResolutionFinding = typeof QUICKBOOKS_OPERATOR_RESOLUTION_FINDINGS[number];

/**
 * How the machine tried to falsify an ABSENT claim. NONE is not a failure: it
 * is the honest answer for an entity QuickBooks gives no natural key to search
 * by, and it is recorded as such rather than presented as a completed check.
 */
export type QuickBooksNaturalKeySearchMethod =
  | "DOCUMENT_NUMBER_AND_COUNTERPARTY"
  | "CONTACT_DISPLAY_NAME"
  | "NONE";

const naturalKeySearchSchema = z.object({
  method: z.enum(["DOCUMENT_NUMBER_AND_COUNTERPARTY", "CONTACT_DISPLAY_NAME", "NONE"]),
  checked: z.boolean(),
  matchCount: z.number().int().min(0),
  naturalKey: z.record(z.string(), z.string()).optional(),
  matches: z.array(z.string()).optional(),
  /** Whether the provider search window covered the whole population. */
  complete: z.boolean().optional(),
  reasonCode: z.string().trim().min(1).optional(),
}).strict();

export type QuickBooksNaturalKeySearchEvidence = z.infer<typeof naturalKeySearchSchema>;

const attestationSchema = z.object({
  evidenceType: z.literal(QUICKBOOKS_OPERATOR_RESOLUTION_EVIDENCE_TYPE),
  evidenceVersion: z.literal("1.0"),
  preparationId: z.string().regex(/^qbm_[a-f0-9]{32}$/u),
  providerRequestId: z.string().trim().min(1),
  attemptId: z.string().regex(/^qbea_[a-f0-9]{32}$/u),
  entity: z.string().trim().min(1),
  operation: z.string().trim().min(1),
  attestedBy: z.string().trim().min(1),
  /**
   * The only accepted value. There is deliberately no autonomous variant: a
   * standing delegation authorises compiled Case operations by actionId, and an
   * attestation is not one, so no delegated authority can be expressed here.
   */
  attestationAuthority: z.literal("HUMAN_EXPLICIT_CONFIRMATION"),
  /** How strongly the Host identified the attesting principal. Recorded, not asserted. */
  attestedByIdentityAssurance: z.enum(["TRUSTED_HOST_CONTEXT", "INSTALLATION_ONLY", "LEGACY_SHARED_BEARER"]),
  confirmationPhraseHash: z.string().regex(/^[a-f0-9]{64}$/u),
  operatorNote: z.string().trim().min(1),
  attestedAt: z.string().datetime({ offset: true }),
});

export const quickBooksOperatorResolutionReceiptSchema = z.discriminatedUnion("finding", [
  attestationSchema.extend({
    finding: z.literal("ABSENT"),
    providerMutationPossible: z.literal(false),
    naturalKeySearch: naturalKeySearchSchema,
  }).strict(),
  attestationSchema.extend({
    finding: z.literal("PRESENT"),
    providerEntityId: z.string().trim().min(1),
    readbackVerification: z.literal("OPERATOR_ATTESTED_EXACT_ID_READBACK"),
  }).strict(),
]);

export type QuickBooksOperatorResolutionReceipt = z.infer<typeof quickBooksOperatorResolutionReceiptSchema>;

/**
 * The sentence an operator must confirm, derived only from durable row identity
 * plus what is being attested. Migration 038 recomputes this hash in SQL, so a
 * confirmation of one finding can never be replayed as another, and a
 * confirmation for one preparation can never be replayed onto a second.
 */
export function quickBooksOperatorResolutionPhrase(input: {
  finding: QuickBooksOperatorResolutionFinding;
  preparationId: string;
  boundTargetRefSafe: string;
  payloadHash: string;
  providerEntityId?: string;
}): string {
  const adopted = input.finding === "PRESENT" ? ` ${input.providerEntityId ?? ""}` : "";
  return `CONFIRM QUICKBOOKS OPERATOR RESOLUTION ${input.finding}${adopted}` +
    ` FOR ${input.preparationId} IN ${input.boundTargetRefSafe} PAYLOAD ${input.payloadHash}`;
}

export function quickBooksOperatorResolutionPhraseHash(input: Parameters<typeof quickBooksOperatorResolutionPhrase>[0]): string {
  return sha256(quickBooksOperatorResolutionPhrase(input));
}

export function issueQuickBooksOperatorResolutionReceipt(input: {
  preparationId: string;
  providerRequestId: string;
  attemptId: string;
  entity: string;
  operation: string;
  attestedBy: string;
  attestedByIdentityAssurance: QuickBooksOperatorResolutionReceipt["attestedByIdentityAssurance"];
  confirmationPhraseHash: string;
  operatorNote: string;
  attestedAt: Date;
} & (
  | { finding: "ABSENT"; naturalKeySearch: QuickBooksNaturalKeySearchEvidence }
  | { finding: "PRESENT"; providerEntityId: string }
)): QuickBooksOperatorResolutionReceipt {
  const common = {
    evidenceType: QUICKBOOKS_OPERATOR_RESOLUTION_EVIDENCE_TYPE,
    evidenceVersion: "1.0",
    preparationId: input.preparationId,
    providerRequestId: input.providerRequestId,
    attemptId: input.attemptId,
    entity: input.entity,
    operation: input.operation,
    attestedBy: input.attestedBy,
    attestationAuthority: "HUMAN_EXPLICIT_CONFIRMATION",
    attestedByIdentityAssurance: input.attestedByIdentityAssurance,
    confirmationPhraseHash: input.confirmationPhraseHash,
    operatorNote: input.operatorNote,
    attestedAt: input.attestedAt.toISOString(),
  } as const;
  const receipt = input.finding === "ABSENT"
    ? {
        ...common,
        finding: "ABSENT",
        providerMutationPossible: false,
        naturalKeySearch: input.naturalKeySearch,
      }
    : {
        ...common,
        finding: "PRESENT",
        providerEntityId: input.providerEntityId,
        readbackVerification: "OPERATOR_ATTESTED_EXACT_ID_READBACK",
      };
  return Object.freeze(quickBooksOperatorResolutionReceiptSchema.parse(receipt));
}

/** True only for a receipt that attests the Provider holds nothing for this write. */
export function quickBooksOperatorAttestedAbsent(
  receipt: QuickBooksOperatorResolutionReceipt | undefined,
): boolean {
  return receipt !== undefined &&
    receipt.evidenceType === QUICKBOOKS_OPERATOR_RESOLUTION_EVIDENCE_TYPE &&
    receipt.finding === "ABSENT" &&
    receipt.providerMutationPossible === false &&
    receipt.naturalKeySearch.matchCount === 0;
}
