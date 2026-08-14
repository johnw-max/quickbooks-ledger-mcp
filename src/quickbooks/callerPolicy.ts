import { AppError } from "../errors.js";
import {
  requireOAuthBoundRequestContext,
  type RequestContext,
} from "../security/requestContext.js";

const EXTERNAL_LEDGER_ROLES = new Set([
  "anonymous",
  "client_intake",
  "external",
  "external_client",
  "guest",
  "public",
]);

export type QuickBooksIdentityAssurance =
  | "TRUSTED_HOST_CONTEXT"
  | "INSTALLATION_ONLY"
  | "LEGACY_SHARED_BEARER";

/**
 * Ledger access is internal-only. The QuickBooks OAuth broker resolves a
 * server-owned installation binding even when the host does not provide its
 * richer Work user tuple. Such a connector principal is still isolated per
 * consent, access-token family, QBO connection, and exact Company.
 */
export function assertInternalQuickBooksCaller(context: RequestContext): QuickBooksIdentityAssurance {
  const subjectType = context.subjectType as string | undefined;
  if (subjectType && subjectType !== "USER" && subjectType !== "TEAM") {
    throw new AppError("FORBIDDEN", "External or anonymous callers cannot access the QuickBooks ledger MCP.", {
      httpStatus: 403,
    });
  }
  if (context.roles.some((role) => EXTERNAL_LEDGER_ROLES.has(role.trim().toLowerCase()))) {
    throw new AppError("FORBIDDEN", "External or anonymous callers cannot access the QuickBooks ledger MCP.", {
      httpStatus: 403,
    });
  }
  if (context.legacyDemo) return "LEGACY_SHARED_BEARER";
  if (
    context.workspaceId &&
    context.subjectType &&
    context.subjectId &&
    context.agentId &&
    context.oauthInstallationId &&
    context.bindingId &&
    context.connectionId &&
    Number.isSafeInteger(context.bindingRevision) &&
    (context.bindingRevision ?? 0) > 0
  ) {
    requireOAuthBoundRequestContext(context);
    // A complete broker-created installation tuple isolates tokens and the QBO
    // Company, but it is not proof of the Host's human/workspace identity.
    // Only a separately verified Host identity assertion may raise assurance.
    return context.identityAssurance === "TRUSTED_HOST_CONTEXT"
      ? "TRUSTED_HOST_CONTEXT"
      : "INSTALLATION_ONLY";
  }
  return "INSTALLATION_ONLY";
}
