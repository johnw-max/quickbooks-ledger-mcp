import { describe, expect, it, vi } from "vitest";
import { assertInternalQuickBooksCaller } from "../src/quickbooks/callerPolicy.js";
import { verifyQuickBooksSourceAttestation } from "../src/quickbooks/sourceAttestation.js";
import type { RequestContext } from "../src/security/requestContext.js";
import { createOAuthRequestContextFromAuthInfo } from "../src/security/requestContext.js";
import { quickBooksPrepareMutationSchema } from "../src/quickbooks/schemas.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: "request-a",
    actorId: "installation-a",
    scopes: ["quickbooks.read"],
    roles: [],
    authn: {
      issuer: "https://mcp.jiayuanwang.xyz",
      subject: "quickbooks-installation:installation-a",
      audience: "https://mcp.jiayuanwang.xyz/quickbooks/mcp",
      tokenId: "token-a",
    },
    legacyDemo: false,
    ...overrides,
  };
}

describe("QuickBooks composition trust boundaries", () => {
  it("labels the current broker honestly and rejects external/public roles", () => {
    expect(assertInternalQuickBooksCaller(context())).toBe("INSTALLATION_ONLY");
    expect(() => assertInternalQuickBooksCaller(context({ roles: ["external_client"] }))).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(() => assertInternalQuickBooksCaller(context({ subjectType: "PUBLIC" as never }))).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    const trusted = {
      workspaceId: "workspace-a",
      subjectType: "USER" as const,
      subjectId: "user-a",
      userId: "user-a",
      agentId: "agent-a",
      oauthInstallationId: "installation-a",
      bindingId: "binding-a",
      connectionId: "connection-a",
      bindingRevision: 1,
      identityAssurance: "TRUSTED_HOST_CONTEXT" as const,
    };
    expect(assertInternalQuickBooksCaller(context({
      ...trusted,
      actorId: "workspace-a:user:user-a",
    }))).toBe("TRUSTED_HOST_CONTEXT");
    expect(assertInternalQuickBooksCaller(context({
      ...trusted,
      identityAssurance: "INSTALLATION_ONLY",
      actorId: "workspace-a:user:user-a",
    }))).toBe("INSTALLATION_ONLY");
    expect(() => assertInternalQuickBooksCaller(context({ ...trusted, actorId: "installation-a" }))).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("does not let Broker AuthInfo self-upgrade to trusted Host identity", () => {
    const audience = "https://mcp.jiayuanwang.xyz/quickbooks/mcp";
    const contextFromBroker = createOAuthRequestContextFromAuthInfo({
      issuer: "https://mcp.jiayuanwang.xyz/quickbooks/oauth",
      expectedAudience: audience,
      authInfo: {
        token: "discarded-opaque-token",
        clientId: "work-quickbooks",
        scopes: ["quickbooks.read"],
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        resource: new URL(audience),
        extra: {
          credentialId: "credential-a",
          installationId: "installation-a",
          bindingId: "binding-a",
          connectionId: "connection-a",
          bindingRevision: 1,
          authorizationId: "authorization-a",
          workspaceId: "broker-synthetic-workspace",
          subjectType: "USER",
          subjectId: "broker-synthetic-subject",
          agentId: "work-quickbooks",
          policyId: "policy-a",
          tenantId: "9341457658718743",
          identityAssurance: "TRUSTED_HOST_CONTEXT",
        },
      },
    });
    expect(contextFromBroker.identityAssurance).toBe("INSTALLATION_ONLY");
    expect(assertInternalQuickBooksCaller(contextFromBroker)).toBe("INSTALLATION_ONLY");
  });

  it("does not accept a model-asserted HOST source digest without WorkStore verification", async () => {
    const base = {
      actorId: "installation-a",
      sourceRef: "work-material:case-7:receipt-1",
      sourceSha256: "a".repeat(64),
      provenance: "HOST_PROVIDED_ORIGINAL_FILE_SHA256" as const,
      attestationRef: "work-attestation-opaque-1",
      boundTargetRefSafe: `quickbooks-target:${"b".repeat(32)}`,
      bindingRevision,
    };
    await expect(verifyQuickBooksSourceAttestation(base)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const verify = vi.fn().mockResolvedValue({ attestationDigest: "d".repeat(64) });
    await expect(verifyQuickBooksSourceAttestation({ ...base, verifier: { verify } }))
      .resolves.toBe("d".repeat(64));
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "installation-a",
      sourceRef: "work-material:case-7:receipt-1",
      sourceSha256: "a".repeat(64),
      boundTargetRefSafe: `quickbooks-target:${"b".repeat(32)}`,
    }));
  });

  it("requires the opaque WorkStore attestation only for HOST provenance", () => {
    const target_session_ref = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
    const hostClaim = {
      target_session_ref,
      request_id: "qbo.customer.attestation.002",
      entity: "Customer" as const,
      operation: "CREATE" as const,
      payload: { DisplayName: "Acme" },
      business_reason: "Create the accepted customer.",
      source_ref: "work-material:receipt-1",
      source_sha256: "a".repeat(64),
      source_digest_provenance: "HOST_PROVIDED_ORIGINAL_FILE_SHA256" as const,
    };
    expect(quickBooksPrepareMutationSchema.safeParse(hostClaim).success).toBe(false);
    expect(quickBooksPrepareMutationSchema.safeParse({
      ...hostClaim,
      source_attestation_ref: "opaque-workstore-attestation",
    }).success).toBe(true);
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref,
      request_id: "qbo.customer.attestation.001",
      entity: "Customer",
      operation: "CREATE",
      payload: { DisplayName: "Acme" },
      business_reason: "Create the accepted customer.",
      source_ref: "work-material:receipt-1",
      source_sha256: "a".repeat(64),
      source_digest_provenance: "AGENT_SUPPLIED_TEXT_FINGERPRINT",
      source_attestation_ref: "opaque-workstore-attestation",
    }).success).toBe(false);
  });

  it("persists the verified attestation digest in the in-memory contract path", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const now = new Date("2026-08-13T00:00:00.000Z");
    const created = await repository.createOrGet({
      preparationId: `qbm_${"a".repeat(32)}`,
      actorId: "actor-a",
      realmId: "9341457701636490",
      connectionRefSafe: `quickbooks-connection:${"a".repeat(32)}`,
      boundTargetRefSafe: `quickbooks-target:${"b".repeat(32)}`,
      bindingRevision,
      entity: "Customer",
      operation: "CREATE",
      risk: "LOW",
      executionMode: "EXPLICIT_CONFIRMATION",
      providerEffect: "MASTER_DATA",
      clientRequestId: "qbo.customer.attested.001",
      providerRequestId: "zc.attested.001",
      payload: { DisplayName: "Acme" },
      payloadHash: "e".repeat(64),
      businessReason: "Create accepted customer.",
      sourceRef: "work-material:receipt-1",
      sourceSha256: "a".repeat(64),
      sourceDigestProvenance: "HOST_PROVIDED_ORIGINAL_FILE_SHA256",
      sourceAttestationDigest: "d".repeat(64),
      confirmationPhraseHash: "f".repeat(64),
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      now,
    });
    expect(created.preparation.sourceAttestationDigest).toBe("d".repeat(64));
    await expect(repository.get(created.preparation.preparationId)).resolves
      .toMatchObject({ sourceAttestationDigest: "d".repeat(64) });
  });
});

const bindingRevision = `quickbooks-binding-revision:${"c".repeat(32)}`;
