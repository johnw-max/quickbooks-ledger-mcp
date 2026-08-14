import type { QuickBooksMutationPreparation } from "../../src/quickbooks/mutationModels.js";
import {
  issueQuickBooksProviderWritePermit,
  issueQuickBooksSupplierBillProviderWritePermit,
  type QuickBooksProviderMutationCommand,
  type QuickBooksProviderWritePermit,
} from "../../src/security/quickBooksProviderWritePermit.js";
import type { QuickBooksSupplierBillInput } from "../../src/providers/quickbooksTypes.js";
import type { QuickBooksPostingRequest } from "../../src/quickbooks/models.js";

export function issueQuickBooksProviderWriteTestPermit(
  command: QuickBooksProviderMutationCommand,
  realmId = "934145",
): QuickBooksProviderWritePermit {
  return issueQuickBooksProviderWritePermit({
    claimedPreparation: claimedQuickBooksMutationPreparationFixture(command, realmId),
  });
}

export function issueQuickBooksSupplierBillProviderWriteTestPermit(
  input: QuickBooksSupplierBillInput,
  realmId = "934145",
): QuickBooksProviderWritePermit {
  const now = new Date("2026-08-13T00:00:00.000Z");
  const { requestId: providerRequestId, ...billPayload } = input;
  const posting: QuickBooksPostingRequest = {
    postingRequestId: `test-posting-${providerRequestId}`,
    actorId: "test-actor",
    realmId,
    clientRequestId: `client-${providerRequestId}`,
    providerRequestId,
    sourceRef: input.sourceRef,
    sourceSha256: input.sourceSha256,
    payload: {
      ...billPayload,
      clientRequestId: `client-${providerRequestId}`,
      connectionRefSafe: "quickbooks-connection:test",
      boundTargetRefSafe: "quickbooks-target:test",
      bindingRevision: "quickbooks-binding-revision:test",
    },
    payloadHash: "test-posting-envelope-hash",
    state: "POSTING",
    approvedBy: "test-controller",
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  return issueQuickBooksSupplierBillProviderWritePermit({ claimedPosting: posting });
}

export function claimedQuickBooksMutationPreparationFixture(
  command: QuickBooksProviderMutationCommand,
  realmId = "934145",
): QuickBooksMutationPreparation {
  const now = new Date("2026-08-13T00:00:00.000Z");
  const claimedPreparation: QuickBooksMutationPreparation = {
    preparationId: `test-preparation-${command.requestId}`,
    actorId: "test-actor",
    realmId,
    connectionRefSafe: "quickbooks-connection:test",
    boundTargetRefSafe: "quickbooks-target:test",
    bindingRevision: "quickbooks-binding-revision:test",
    entity: command.entity,
    operation: command.operation,
    risk: "LOW",
    executionMode: "EXPLICIT_CONFIRMATION",
    providerEffect: "MASTER_DATA",
    clientRequestId: `client-${command.requestId}`,
    providerRequestId: command.requestId,
    ...(command.targetId ? { targetId: command.targetId } : {}),
    ...(command.syncToken ? { syncToken: command.syncToken } : {}),
    payload: structuredClone(command.payload),
    payloadHash: "test-preparation-envelope-hash",
    businessReason: "Test-only provider boundary claim.",
    confirmationPhraseHash: "test-confirmation-hash",
    state: "EXECUTING",
    approvedBy: "test-controller",
    approvedAt: now,
    createdAt: now,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    updatedAt: now,
  };
  return claimedPreparation;
}
