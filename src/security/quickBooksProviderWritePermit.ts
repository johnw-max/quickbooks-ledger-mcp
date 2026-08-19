import { AppError } from "../errors.js";
import type { QuickBooksMutationPreparation } from "../quickbooks/mutationModels.js";
import {
  QUICKBOOKS_WRITABLE_ENTITIES,
  QUICKBOOKS_WRITE_OPERATIONS,
  type QuickBooksWritableEntity,
  type QuickBooksWriteOperation,
} from "../quickbooks/writePolicy.js";
import { hashObject } from "./hash.js";

declare const quickBooksProviderWritePermitBrand: unique symbol;

/** Every credentialed raw QuickBooks adapter operation covered by this authority. */
export const QUICKBOOKS_PROVIDER_WRITE_ADAPTER_OPERATIONS = [
  "QuickBooksAccountingProvider.executeMutation",
] as const;

export type QuickBooksProviderWriteAdapterOperation =
  typeof QUICKBOOKS_PROVIDER_WRITE_ADAPTER_OPERATIONS[number];

export interface QuickBooksProviderMutationCommand {
  readonly entity: QuickBooksWritableEntity;
  readonly operation: QuickBooksWriteOperation;
  readonly payload: Record<string, unknown>;
  readonly targetId?: string;
  readonly syncToken?: string;
  readonly requestId: string;
}

/**
 * Process-local, non-serialisable authority for exactly one raw provider call.
 *
 * The object contains no authority-bearing properties. Its claims and consumed
 * state live only in this module's WeakMap, so a copied, reconstructed or
 * deserialised object cannot authorise provider I/O.
 */
export type QuickBooksProviderWritePermit = Readonly<{
  [quickBooksProviderWritePermitBrand]: never;
}>;

export interface QuickBooksProviderWritePermitClaims {
  readonly providerId: "quickbooks";
  readonly adapterOperation: QuickBooksProviderWriteAdapterOperation;
  readonly realmId: string;
  readonly providerRequestId: string;
  readonly entity: QuickBooksWritableEntity;
  readonly operation: QuickBooksWriteOperation;
  readonly canonicalPayloadHash: string;
  readonly targetIdHash: string;
  readonly syncTokenHash: string;
}

export type IssueQuickBooksProviderWritePermitInput = Readonly<{
  /** The repository-returned record after an exclusive execution claim. */
  claimedPreparation: QuickBooksMutationPreparation;
}>;

interface PermitState {
  readonly claims: Readonly<QuickBooksProviderWritePermitClaims>;
  consumed: boolean;
}

type PermitDenialReason =
  | "INVALID"
  | "CONSUMED"
  | "PROVIDER_MISMATCH"
  | "ADAPTER_OPERATION_MISMATCH"
  | "REALM_MISMATCH"
  | "PROVIDER_REQUEST_MISMATCH"
  | "ENTITY_MISMATCH"
  | "OPERATION_MISMATCH"
  | "PAYLOAD_MISMATCH"
  | "TARGET_MISMATCH"
  | "SYNC_TOKEN_MISMATCH";

type PermitIssuanceFailureReason =
  | "INVALID_CLAIM"
  | "CLAIM_NOT_EXECUTING";

const permitState = new WeakMap<object, PermitState>();
const writableEntities = new Set<string>(QUICKBOOKS_WRITABLE_ENTITIES);
const writeOperations = new Set<string>(QUICKBOOKS_WRITE_OPERATIONS);

function ownValue(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function permitDenied(reason: PermitDenialReason): AppError {
  return new AppError(
    "FORBIDDEN",
    "The raw QuickBooks provider write is not authorised by a valid one-shot permit.",
    {
      httpStatus: 403,
      retryable: false,
      details: { providerMutationPossible: false, permitReason: reason },
    },
  );
}

function permitIssuanceFailed(reason: PermitIssuanceFailureReason): AppError {
  return new AppError(
    "APPROVAL_INVALID",
    "The claimed QuickBooks mutation cannot issue a raw provider-write permit.",
    {
      httpStatus: 409,
      retryable: false,
      details: { providerMutationPossible: false, permitReason: reason },
    },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function commandHashes(command: Pick<
  QuickBooksProviderMutationCommand,
  "payload" | "targetId" | "syncToken"
>): Pick<
  QuickBooksProviderWritePermitClaims,
  "canonicalPayloadHash" | "targetIdHash" | "syncTokenHash"
> {
  return {
    canonicalPayloadHash: hashObject(command.payload),
    targetIdHash: hashObject(command.targetId ?? null),
    syncTokenHash: hashObject(command.syncToken ?? null),
  };
}

function validClaimedPreparation(
  value: unknown,
): value is QuickBooksMutationPreparation {
  if (!isRecord(value)) return false;
  const realmId = ownValue(value, "realmId");
  const providerRequestId = ownValue(value, "providerRequestId");
  const entity = ownValue(value, "entity");
  const operation = ownValue(value, "operation");
  const payload = ownValue(value, "payload");
  const targetId = ownValue(value, "targetId");
  const syncToken = ownValue(value, "syncToken");
  return isExactNonEmptyString(realmId) &&
    isExactNonEmptyString(providerRequestId) &&
    typeof entity === "string" && writableEntities.has(entity) &&
    typeof operation === "string" && writeOperations.has(operation) &&
    isRecord(payload) &&
    (targetId === undefined || isExactNonEmptyString(targetId)) &&
    (syncToken === undefined || isExactNonEmptyString(syncToken));
}

/**
 * Security-sensitive issuer. Production imports are architecture-gated so
 * only QuickBooksMutationService can mint this permit, and it can do so only
 * from the repository record returned after the exclusive EXECUTING claim.
 */
export function issueQuickBooksProviderWritePermit(
  input: IssueQuickBooksProviderWritePermitInput,
): QuickBooksProviderWritePermit {
  if (!isRecord(input) || !validClaimedPreparation(input.claimedPreparation)) {
    throw permitIssuanceFailed("INVALID_CLAIM");
  }
  const preparation = input.claimedPreparation;
  if (Object.getOwnPropertyDescriptor(preparation, "state")?.value !== "EXECUTING") {
    throw permitIssuanceFailed("CLAIM_NOT_EXECUTING");
  }

  const claims = Object.freeze({
    providerId: "quickbooks" as const,
    adapterOperation: "QuickBooksAccountingProvider.executeMutation" as const,
    realmId: preparation.realmId,
    providerRequestId: preparation.providerRequestId,
    entity: preparation.entity,
    operation: preparation.operation,
    ...commandHashes(preparation),
  }) satisfies Readonly<QuickBooksProviderWritePermitClaims>;

  const permit = Object.freeze(Object.create(null)) as QuickBooksProviderWritePermit;
  permitState.set(permit, { claims, consumed: false });
  return permit;
}

function mismatchReason(
  actual: Readonly<QuickBooksProviderWritePermitClaims>,
  expected: Readonly<QuickBooksProviderWritePermitClaims>,
): PermitDenialReason | undefined {
  if (actual.providerId !== expected.providerId) return "PROVIDER_MISMATCH";
  if (actual.adapterOperation !== expected.adapterOperation) return "ADAPTER_OPERATION_MISMATCH";
  if (actual.realmId !== expected.realmId) return "REALM_MISMATCH";
  if (actual.providerRequestId !== expected.providerRequestId) return "PROVIDER_REQUEST_MISMATCH";
  if (actual.entity !== expected.entity) return "ENTITY_MISMATCH";
  if (actual.operation !== expected.operation) return "OPERATION_MISMATCH";
  if (actual.canonicalPayloadHash !== expected.canonicalPayloadHash) return "PAYLOAD_MISMATCH";
  if (actual.targetIdHash !== expected.targetIdHash) return "TARGET_MISMATCH";
  if (actual.syncTokenHash !== expected.syncTokenHash) return "SYNC_TOKEN_MISMATCH";
  return undefined;
}

/**
 * Irreversibly consumes the authority before the first raw provider request.
 * Poisoning precedes claim comparison, so a mismatched first presentation can
 * never be corrected and reused for another write.
 */
export function consumeQuickBooksProviderWritePermit(
  permit: QuickBooksProviderWritePermit | undefined,
  expected: Readonly<{
    realmId: string;
    command: QuickBooksProviderMutationCommand;
  }>,
): Readonly<QuickBooksProviderWritePermitClaims> {
  if (!permit || (typeof permit !== "object" && typeof permit !== "function")) {
    throw permitDenied("INVALID");
  }
  const state = permitState.get(permit);
  if (!state) throw permitDenied("INVALID");
  if (state.consumed) throw permitDenied("CONSUMED");

  // This synchronous transition has no await point. Poison first so even
  // malformed expectations or getters cannot preserve reusable authority.
  state.consumed = true;
  const expectedClaims = Object.freeze({
    providerId: "quickbooks" as const,
    adapterOperation: "QuickBooksAccountingProvider.executeMutation" as const,
    realmId: expected.realmId,
    providerRequestId: expected.command.requestId,
    entity: expected.command.entity,
    operation: expected.command.operation,
    ...commandHashes(expected.command),
  }) satisfies Readonly<QuickBooksProviderWritePermitClaims>;
  const mismatch = mismatchReason(state.claims, expectedClaims);
  if (mismatch) throw permitDenied(mismatch);
  return state.claims;
}
