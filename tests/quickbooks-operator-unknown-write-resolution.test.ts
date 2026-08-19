import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logging.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import {
  QuickBooksMutationService,
  quickBooksPreparationConfirmedNotWritten,
} from "../src/quickbooks/mutationService.js";
import { quickBooksOperatorResolutionPhrase } from "../src/quickbooks/operatorResolution.js";
import type { QuickBooksMutationRuntimePolicy } from "../src/quickbooks/mutationService.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../src/quickbooks/service.js";
import type { RequestContext } from "../src/security/requestContext.js";
import { sha256 } from "../src/security/hash.js";
import {
  consumeQuickBooksProviderWritePermit,
  type QuickBooksProviderMutationCommand,
  type QuickBooksProviderWritePermit,
} from "../src/security/quickBooksProviderWritePermit.js";
import { quickBooksWriteFailure } from "./helpers/quickBooksCompletedProviderResponse.js";

const realmId = "9341457701636490";
const targetSessionRef = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
const workspaceId = "workspace-operator";
const actorId = `${workspaceId}:user:accountant-a`;
const operatorNote = "Checked the Bills list in QuickBooks for the whole year; this document is not there.";

function operatorContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: `request-${randomBytes(4).toString("hex")}`,
    actorId,
    workspaceId,
    subjectType: "USER",
    subjectId: "accountant-a",
    agentId: "agent-a",
    oauthInstallationId: "installation-a",
    bindingId: "binding-a",
    connectionId: "connection-a",
    bindingRevision: 1,
    scopes: ["quickbooks.read", "quickbooks.mutation.prepare", "quickbooks.mutation.execute"],
    roles: [],
    identityAssurance: "INSTALLATION_ONLY",
    authn: {
      issuer: "https://mcp.test",
      subject: "user:accountant-a",
      audience: "https://mcp.test/quickbooks/mcp",
      tokenId: "token-a",
    },
    legacyDemo: false,
    ...overrides,
  };
}

function emptySearch(complete = true) {
  return {
    records: [],
    searchWindow: {
      requestedLimit: 100,
      returned: 0,
      scanned: 12,
      scanLimit: 10_000,
      complete,
      stoppedReason: complete ? "source_exhausted" as const : "scan_limit" as const,
    },
  };
}

/** Intuit never completed a response: the one genuinely unknown outcome. */
const lostInTransport = () => vi.fn(async (
  input: QuickBooksProviderMutationCommand,
  permit: QuickBooksProviderWritePermit,
  _record: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
  markProviderDispatch: () => Promise<void>,
) => {
  consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
  await markProviderDispatch();
  throw await quickBooksWriteFailure(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }, realmId);
});

function providerStub(overrides: Partial<QuickBooksProviderCapabilities> = {}): QuickBooksProviderCapabilities {
  return {
    executeMutation: lostInTransport(),
    recoverMutation: vi.fn(),
    getMutationTarget: vi.fn(),
    findExistingAccountingDocuments: vi.fn(async () => []),
    searchCustomers: vi.fn(async () => emptySearch()),
    searchVendors: vi.fn(async () => emptySearch()),
    ...overrides,
  } as unknown as QuickBooksProviderCapabilities;
}

function recordingLogger(): Logger & { warnings: { message: string; context?: Record<string, unknown> }[] } {
  const warnings: { message: string; context?: Record<string, unknown> }[] = [];
  return {
    warnings,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message: string, context?: Record<string, unknown>) => {
      warnings.push({ message, ...(context ? { context } : {}) });
    },
    error: vi.fn(),
  };
}

function mutationRuntime(options: {
  provider: QuickBooksProviderCapabilities;
  standingDelegationProvider?: QuickBooksMutationRuntimePolicy["standingDelegationProvider"];
  logger?: Logger;
}) {
  const repository = new InMemoryQuickBooksMutationRepository();
  const resolver: QuickBooksProviderResolver = {
    connectionStatus: vi.fn(),
    resolve: vi.fn(async () => ({
      realmId,
      companyName: "Marina Bay Sandbox",
      connectionRefSafe: "qbc-safe",
      boundTargetRefSafe: "qbt-safe",
      bindingRevision: "qbr-safe",
      provider: options.provider,
    })),
  };
  const service = new QuickBooksMutationService(repository, resolver, {
    writeEnabled: true,
    writeTargetMode: "exact_allowlist",
    allowedRealmId: realmId,
    publicBaseUrl: "https://mcp.test",
    ...(options.standingDelegationProvider
      ? { standingDelegationProvider: options.standingDelegationProvider }
      : {}),
  }, undefined, undefined, undefined, options.logger);
  return { repository, service };
}

/** A contact create that reached the Provider and never came back. */
async function strandedContactWrite(options: {
  provider?: QuickBooksProviderCapabilities;
  requestId?: string;
  logger?: Logger;
  standingDelegationProvider?: QuickBooksMutationRuntimePolicy["standingDelegationProvider"];
} = {}) {
  const provider = options.provider ?? providerStub();
  const { repository, service } = mutationRuntime({
    provider,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.standingDelegationProvider
      ? { standingDelegationProvider: options.standingDelegationProvider }
      : {}),
  });
  const request = {
    target_session_ref: targetSessionRef,
    request_id: options.requestId ?? `qbocase.${randomBytes(8).toString("hex")}`,
    entity: "Vendor" as const,
    operation: "CREATE" as const,
    payload: { DisplayName: "Marina Bay Consulting Pte Ltd", CurrencyRef: { value: "SGD" } },
    business_reason: "Accounting Case stable source operation.",
  };
  const prepared = await service.prepareCaseOperation(actorId, request);
  await expect(service.executeWithConfirmation(actorId, {
    preparation_id: prepared.preparation_id,
    request_id: request.request_id,
    confirmation_phrase: prepared.confirmation_phrase as string,
  })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID" });
  const stranded = await repository.get(prepared.preparation_id);
  expect(stranded).toMatchObject({
    state: "WRITE_RESULT_UNKNOWN_NO_ID",
    executionAttempt: { state: "WRITE_RESULT_UNKNOWN_NO_ID" },
  });
  const phrase = (finding: "ABSENT" | "PRESENT", providerEntityId?: string) =>
    quickBooksOperatorResolutionPhrase({
      finding,
      preparationId: prepared.preparation_id,
      boundTargetRefSafe: "qbt-safe",
      payloadHash: prepared.canonical_payload_hash,
      ...(providerEntityId ? { providerEntityId } : {}),
    });
  return { repository, service, provider, prepared, request, phrase };
}

/** A supplier bill create in the same condition, so the document search runs. */
async function strandedBillWrite(options: { provider?: QuickBooksProviderCapabilities } = {}) {
  const provider = options.provider ?? providerStub();
  const { repository, service } = mutationRuntime({ provider });
  const request = {
    target_session_ref: targetSessionRef,
    request_id: `qbocase.${randomBytes(8).toString("hex")}`,
    entity: "Bill" as const,
    operation: "CREATE" as const,
    payload: {
      VendorRef: { value: "63" },
      DocNumber: "MBC-2026-0820",
      CurrencyRef: { value: "SGD" },
      Line: [{ Amount: 1_200, DetailType: "AccountBasedExpenseLineDetail" }],
    },
    business_reason: "Accounting Case stable source operation.",
  };
  const prepared = await service.prepareCaseOperation(actorId, request);
  const csrfHash = sha256(`csrf-${randomBytes(8).toString("hex")}`);
  const sessionHash = sha256("session-operator");
  await repository.saveReviewCsrf({
    csrfHash,
    sessionHash,
    actorId,
    preparationId: prepared.preparation_id,
    expiresAt: new Date(Date.now() + 600_000),
  });
  await expect(service.executeAfterHumanReview({
    actorId,
    preparationId: prepared.preparation_id,
    approvedBy: actorId,
    sessionHash,
    csrfHash,
  })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID" });
  const phrase = (finding: "ABSENT" | "PRESENT", providerEntityId?: string) =>
    quickBooksOperatorResolutionPhrase({
      finding,
      preparationId: prepared.preparation_id,
      boundTargetRefSafe: "qbt-safe",
      payloadHash: prepared.canonical_payload_hash,
      ...(providerEntityId ? { providerEntityId } : {}),
    });
  return { repository, service, provider, prepared, request, phrase };
}

describe("QuickBooks operator resolution of an unknown write outcome", () => {
  it("attests absence without moving the state, and that alone lets the document be booked again", async () => {
    const logger = recordingLogger();
    const { repository, service, prepared, request, phrase } = await strandedContactWrite({
      requestId: "qbocase.3281698c384e7a795a4ae7ba93ca53be653a3570",
      logger,
    });

    const resolution = await service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: phrase("ABSENT"),
    });

    expect(resolution).toMatchObject({
      finding: "ABSENT",
      // The durable state is deliberately unchanged: the outcome genuinely was
      // unknown, and rewriting that would falsify what the machine knew.
      state: "WRITE_RESULT_UNKNOWN_NO_ID",
      provider_write_executed: false,
      supersession_available: true,
      recovery_action: "PREPARE_NEW_CASE_VERSION",
      natural_key_check: { method: "CONTACT_DISPLAY_NAME", checked: true, matchCount: 0, complete: true },
    });

    const attested = await repository.get(prepared.preparation_id);
    expect(attested?.state).toBe("WRITE_RESULT_UNKNOWN_NO_ID");
    // Evidence accretes: what the machine knew is left exactly as written.
    expect(attested?.executionAttempt?.resolutionReceipt).toMatchObject({
      resolution: "WRITE_RESULT_UNKNOWN_NO_ID",
      providerMutationPossible: true,
      operatorResolutionRequired: true,
    });
    expect(attested?.operatorResolutionReceipt).toMatchObject({
      evidenceType: "QUICKBOOKS_OPERATOR_RESOLUTION",
      finding: "ABSENT",
      providerMutationPossible: false,
      attestedBy: actorId,
      attestationAuthority: "HUMAN_EXPLICIT_CONFIRMATION",
      attestedByIdentityAssurance: "INSTALLATION_ONLY",
      operatorNote,
      confirmationPhraseHash: sha256(phrase("ABSENT")),
    });
    expect(quickBooksPreparationConfirmedNotWritten(attested as never)).toBe(true);

    // The Case restates the very same document; its request id is a content
    // hash and never changes, so only the new generation makes it bookable.
    const second = await service.prepareCaseOperation(actorId, request);
    expect(second.state).toBe("PREPARED");
    expect(second.preparation_id).not.toBe(prepared.preparation_id);
    const superseding = await repository.get(second.preparation_id);
    expect(superseding?.clientRequestId).toBe(`${request.request_id}.g2`);
    expect(superseding?.providerRequestId).not.toBe(attested?.providerRequestId);

    expect(logger.warnings.at(-1)?.context).toMatchObject({
      preparationId: prepared.preparation_id,
      operatorResolutionFinding: "ABSENT",
      naturalKeySearchMethod: "CONTACT_DISPLAY_NAME",
      naturalKeySearchChecked: true,
    });
  });

  it("refuses to attest absence when the Provider still holds the document", async () => {
    const findExistingAccountingDocuments = vi.fn(async () => [{
      entity: "Bill" as const,
      providerEntityId: "289",
      counterpartyId: "63",
      docNumber: "MBC-2026-0820",
      txnDate: "2026-08-01",
      total: "1200.00",
    }]);
    const { repository, service, prepared, phrase } = await strandedBillWrite({
      provider: providerStub({ findExistingAccountingDocuments }),
    });

    await expect(service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: phrase("ABSENT"),
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        reasonCodes: ["PROVIDER_OBJECT_FOUND_BY_NATURAL_KEY"],
        // The refusal hands back the id, so the operator can attest the truth.
        providerEntityId: "289",
        recoveryAction: "ATTEST_PROVIDER_OBJECT_PRESENT",
      },
    });
    expect(findExistingAccountingDocuments).toHaveBeenCalledWith({
      entity: "Bill",
      counterpartyId: "63",
      docNumber: "MBC-2026-0820",
    });
    const untouched = await repository.get(prepared.preparation_id);
    expect(untouched?.operatorResolutionReceipt).toBeUndefined();
    expect(quickBooksPreparationConfirmedNotWritten(untouched as never)).toBe(false);
  });

  it("records honestly that no automated check was possible when the entity has no natural key", async () => {
    const provider = providerStub();
    const { repository, service } = mutationRuntime({ provider });
    const request = {
      target_session_ref: targetSessionRef,
      request_id: `qbo.journal.${randomBytes(8).toString("hex")}`,
      entity: "TimeActivity" as const,
      operation: "CREATE" as const,
      payload: { NameOf: "Employee", Hours: 3 },
      business_reason: "Log the reviewed timesheet entry.",
    };
    const prepared = await service.prepare(actorId, request);
    await expect(service.executeWithConfirmation(actorId, {
      preparation_id: prepared.preparation_id,
      request_id: request.request_id,
      confirmation_phrase: prepared.confirmation_phrase as string,
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID" });

    const resolution = await service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: quickBooksOperatorResolutionPhrase({
        finding: "ABSENT",
        preparationId: prepared.preparation_id,
        boundTargetRefSafe: "qbt-safe",
        payloadHash: prepared.canonical_payload_hash,
      }),
    });

    expect(resolution.natural_key_check).toMatchObject({
      method: "NONE",
      checked: false,
      matchCount: 0,
      reasonCode: "NO_NATURAL_KEY_SEARCH_AVAILABLE_FOR_THIS_ENTITY",
    });
    // The attestation still stands — a person took responsibility — but the
    // receipt never claims a search happened.
    expect(quickBooksPreparationConfirmedNotWritten(
      await repository.get(prepared.preparation_id) as never,
    )).toBe(true);
  });

  it("refuses the whole attestation when the veto search itself cannot run", async () => {
    const findExistingAccountingDocuments = vi.fn(async () => {
      throw new Error("QuickBooks query failed");
    });
    const { repository, service, prepared, phrase } = await strandedBillWrite({
      provider: providerStub({ findExistingAccountingDocuments }),
    });

    await expect(service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: phrase("ABSENT"),
    })).rejects.toThrow();
    // A veto that did not happen must never read as a veto that passed.
    expect((await repository.get(prepared.preparation_id))?.operatorResolutionReceipt).toBeUndefined();
  });

  it("adopts an attested Id only after it reads back as the prepared payload", async () => {
    const recoverMutation = vi.fn(async (_command: unknown, providerEntityId: string) => ({
      providerEntityId,
      receipt: { provider: "quickbooks-online", verified: true, verification: "RECOVERY_EXACT_ID_READBACK" },
      readback: { Id: providerEntityId, DisplayName: "Marina Bay Consulting Pte Ltd" },
    }));
    const { repository, service, provider, prepared, phrase } = await strandedContactWrite({
      provider: providerStub({ recoverMutation }),
    });

    const resolution = await service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "PRESENT",
      providerEntityId: "312",
      operatorNote: "Found the vendor in QuickBooks; its Id is 312.",
      confirmationPhrase: phrase("PRESENT", "312"),
    });

    expect(resolution).toMatchObject({
      finding: "PRESENT",
      state: "POSTED_READBACK_VERIFIED",
      provider_entity_id: "312",
      provider_write_executed: true,
      supersession_available: false,
    });
    const adopted = await repository.get(prepared.preparation_id);
    expect(adopted).toMatchObject({
      state: "POSTED_READBACK_VERIFIED",
      providerEntityId: "312",
      providerOutcomeReceipt: { adoptedBy: "OPERATOR_RESOLUTION_EXACT_ID_READBACK" },
      operatorResolutionReceipt: {
        finding: "PRESENT",
        providerEntityId: "312",
        readbackVerification: "OPERATOR_ATTESTED_EXACT_ID_READBACK",
      },
    });
    // A row that carries an attested Id can never be superseded.
    expect(quickBooksPreparationConfirmedNotWritten(adopted as never)).toBe(false);
    // The Provider was read, never written a second time.
    expect(recoverMutation.mock.calls.every(([, id]) => id === "312")).toBe(true);
    expect(vi.mocked(provider.executeMutation)).toHaveBeenCalledTimes(1);
  });

  it("refuses an attested Id whose read-back does not match, and leaves the row untouched", async () => {
    const recoverMutation = vi.fn(async () => {
      throw Object.assign(new Error("QuickBooks exact-Id recovery did not match the immutable approved mutation."), {
        code: "READBACK_MISMATCH",
      });
    });
    const { repository, service, prepared, phrase } = await strandedContactWrite({
      provider: providerStub({ recoverMutation }),
    });

    await expect(service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "PRESENT",
      providerEntityId: "999",
      operatorNote: "Thought this was the vendor we created.",
      confirmationPhrase: phrase("PRESENT", "999"),
    })).rejects.toThrow();

    const untouched = await repository.get(prepared.preparation_id);
    expect(untouched?.state).toBe("WRITE_RESULT_UNKNOWN_NO_ID");
    expect(untouched?.providerEntityId).toBeUndefined();
    expect(untouched?.operatorResolutionReceipt).toBeUndefined();
  });

  it("requires the exact confirmation phrase for this preparation and finding", async () => {
    const { repository, service, prepared, phrase } = await strandedContactWrite();

    await expect(service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: "CONFIRM QUICKBOOKS OPERATOR RESOLUTION ABSENT",
    })).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
      details: {
        reasonCodes: ["OPERATOR_CONFIRMATION_PHRASE_MISMATCH"],
        expectedConfirmationPhrase: phrase("ABSENT"),
      },
    });
    // A confirmation of one finding cannot be replayed as the other.
    await expect(service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "PRESENT",
      providerEntityId: "312",
      operatorNote,
      confirmationPhrase: phrase("ABSENT"),
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect((await repository.get(prepared.preparation_id))?.operatorResolutionReceipt).toBeUndefined();
  });

  it("keeps the first attestation, because an attestation is immutable", async () => {
    const { repository, service, prepared, phrase } = await strandedContactWrite();
    await service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: phrase("ABSENT"),
    });

    await expect(service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "PRESENT",
      providerEntityId: "312",
      operatorNote: "Actually it is there after all.",
      confirmationPhrase: phrase("PRESENT", "312"),
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reasonCodes: ["OPERATOR_RESOLUTION_ALREADY_RECORDED"] },
    });
    const attested = await repository.get(prepared.preparation_id);
    expect(attested?.operatorResolutionReceipt).toMatchObject({ finding: "ABSENT" });
    expect(attested?.providerEntityId).toBeUndefined();
  });

  it("refuses to attest a write whose outcome is not unknown", async () => {
    const { service } = mutationRuntime({ provider: providerStub() });
    const request = {
      target_session_ref: targetSessionRef,
      request_id: `qbo.prepared.${randomBytes(8).toString("hex")}`,
      entity: "Vendor" as const,
      operation: "CREATE" as const,
      payload: { DisplayName: "Never Dispatched Pte Ltd" },
      business_reason: "Prepare only.",
    };
    const prepared = await service.prepare(actorId, request);

    await expect(service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: quickBooksOperatorResolutionPhrase({
        finding: "ABSENT",
        preparationId: prepared.preparation_id,
        boundTargetRefSafe: "qbt-safe",
        payloadHash: prepared.canonical_payload_hash,
      }),
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reasonCodes: ["OPERATOR_RESOLUTION_STATE_INVALID"], state: "PREPARED" },
    });
  });

  it("gives a standing delegation no way to attest", async () => {
    // Wired to authorise anything, so that "it was never asked" is the finding.
    const standingDelegationProvider = vi.fn(async () => [{
      delegationId: "delegation-a",
      revision: 1,
      status: "ACTIVE" as const,
      providerId: "quickbooks",
      workspaceId,
      agentId: "agent-a",
      tenantIds: [realmId],
      actionIds: ["quickbooks_resolve_unknown_write", "CREATE:Vendor"],
    }]);
    const { repository, service, prepared, phrase } = await strandedContactWrite({ standingDelegationProvider });

    await service.resolveUnknownWrite(operatorContext(), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: phrase("ABSENT"),
    });

    // The ledger control kernel is never consulted: an attestation is not a
    // capability key and carries no compiled operation, so there is no
    // delegation shape that could express it.
    expect(standingDelegationProvider).not.toHaveBeenCalled();
    const receipt = (await repository.get(prepared.preparation_id))?.operatorResolutionReceipt;
    expect(receipt?.attestationAuthority).toBe("HUMAN_EXPLICIT_CONFIRMATION");
    expect(receipt?.attestedBy).toBe(actorId);
    expect(receipt?.attestedBy.startsWith("standing:")).toBe(false);
  });

  it("refuses a caller presenting itself as a standing delegation, or with no bound principal", async () => {
    const { repository, service, prepared, phrase } = await strandedContactWrite();
    const delegationActor = "standing:user:delegation-a";

    await expect(service.resolveUnknownWrite(operatorContext({
      actorId: delegationActor,
      workspaceId: "standing",
      subjectId: "delegation-a",
    }), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: phrase("ABSENT"),
    })).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reasonCodes: ["OPERATOR_ATTESTATION_REQUIRES_A_NAMED_PRINCIPAL"] },
    });

    await expect(service.resolveUnknownWrite(operatorContext({ legacyDemo: true }), {
      targetSessionRef,
      preparationId: prepared.preparation_id,
      finding: "ABSENT",
      operatorNote,
      confirmationPhrase: phrase("ABSENT"),
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await repository.get(prepared.preparation_id))?.operatorResolutionReceipt).toBeUndefined();
  });
});
