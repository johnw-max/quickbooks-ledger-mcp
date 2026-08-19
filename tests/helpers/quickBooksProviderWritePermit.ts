import type { QuickBooksMutationPreparation } from "../../src/quickbooks/mutationModels.js";
import {
  issueQuickBooksProviderWritePermit,
  type QuickBooksProviderMutationCommand,
  type QuickBooksProviderWritePermit,
} from "../../src/security/quickBooksProviderWritePermit.js";

export function issueQuickBooksProviderWriteTestPermit(
  command: QuickBooksProviderMutationCommand,
  realmId = "934145",
): QuickBooksProviderWritePermit {
  return issueQuickBooksProviderWritePermit({
    claimedPreparation: claimedQuickBooksMutationPreparationFixture(command, realmId),
  });
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
