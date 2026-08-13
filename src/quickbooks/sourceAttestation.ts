import { AppError } from "../errors.js";

export interface QuickBooksSourceAttestationVerifier {
  verify(input: {
    actorId: string;
    sourceRef: string;
    sourceSha256: string;
    attestationRef: string;
    boundTargetRefSafe: string;
    bindingRevision: string;
  }): Promise<{ attestationDigest: string }>;
}

/**
 * HOST_PROVIDED is a trust claim, not a label the model may self-assert.
 * Until WorkStore injects a verifier, that provenance fails closed while the
 * existing Agent/external-unverified evidence paths remain available.
 */
export async function verifyQuickBooksSourceAttestation(options: {
  actorId: string;
  sourceRef?: string;
  sourceSha256?: string;
  provenance?:
    | "AGENT_SUPPLIED_TEXT_FINGERPRINT"
    | "HOST_PROVIDED_ORIGINAL_FILE_SHA256"
    | "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256";
  attestationRef?: string;
  boundTargetRefSafe: string;
  bindingRevision: string;
  verifier?: QuickBooksSourceAttestationVerifier;
}): Promise<string | undefined> {
  if (options.provenance !== "HOST_PROVIDED_ORIGINAL_FILE_SHA256") {
    if (options.attestationRef) {
      throw new AppError("VALIDATION_FAILED", "A WorkStore attestation is only valid with HOST_PROVIDED source provenance.", {
        httpStatus: 422,
      });
    }
    return undefined;
  }
  if (!options.sourceRef || !options.sourceSha256 || !options.attestationRef) {
    throw new AppError("VALIDATION_FAILED", "Host-provided source evidence requires a complete WorkStore attestation.", {
      httpStatus: 422,
    });
  }
  if (!options.verifier) {
    throw new AppError("FORBIDDEN", "Trusted WorkStore source attestation verification is not configured.", {
      httpStatus: 403,
    });
  }
  const verified = await options.verifier.verify({
    actorId: options.actorId,
    sourceRef: options.sourceRef,
    sourceSha256: options.sourceSha256,
    attestationRef: options.attestationRef,
    boundTargetRefSafe: options.boundTargetRefSafe,
    bindingRevision: options.bindingRevision,
  });
  if (!/^[a-f0-9]{64}$/.test(verified.attestationDigest) || /^0{64}$/.test(verified.attestationDigest)) {
    throw new AppError("CONFIGURATION_ERROR", "The WorkStore attestation verifier returned an invalid digest.", {
      httpStatus: 503,
    });
  }
  return verified.attestationDigest;
}
