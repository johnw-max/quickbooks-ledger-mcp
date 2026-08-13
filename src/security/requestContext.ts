import { randomUUID } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AppError } from "../errors.js";

export type BindingSubjectType = "USER" | "TEAM";

/** Provider-neutral trusted token view required by RequestContext construction. */
export interface ResolvedMcpAccessToken {
  tokenId: string;
  clientId: string;
  resource: string;
  audience: string;
  grantedScopes: string[];
  issuedAt: Date;
  expiresAt: Date;
  installationId: string;
  bindingId: string;
  connectionId: string;
  bindingRevision: number;
  authorizationId: string;
  workspaceId: string;
  subjectType: BindingSubjectType;
  subjectId: string;
  agentId: string;
  policyId: string;
  tenantId: string;
}

export interface RequestAuthentication {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  readonly tokenId: string;
}

/**
 * Trusted identity and connection context resolved at the HTTP edge.
 *
 * Optional fields are intentionally absent during the shared-bearer migration.
 * Production resolvers must derive them from a verified token and server-side
 * bindings; they must never copy identity or tenant values from request headers
 * or MCP tool arguments.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly actorId: string;
  readonly workspaceId?: string;
  readonly subjectType?: BindingSubjectType;
  readonly subjectId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly conversationId?: string;
  readonly oauthInstallationId?: string;
  readonly bindingId?: string;
  readonly connectionId?: string;
  readonly bindingRevision?: number;
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
  readonly authn: RequestAuthentication;
  readonly legacyDemo: boolean;
}

export interface OAuthBoundRequestContext extends RequestContext {
  readonly workspaceId: string;
  readonly subjectType: BindingSubjectType;
  readonly subjectId: string;
  readonly agentId: string;
  readonly oauthInstallationId: string;
  readonly bindingId: string;
  readonly connectionId: string;
  readonly bindingRevision: number;
  readonly legacyDemo: false;
}

/**
 * Fails closed unless every server-resolved identity/binding tuple field is
 * present. Legacy contexts deliberately do not acquire synthetic OAuth claims.
 */
export function requireOAuthBoundRequestContext(context: RequestContext): OAuthBoundRequestContext {
  const nonEmpty = (value: string | undefined): value is string =>
    typeof value === "string" && value.length > 0 && value === value.trim();
  const subjectType = context.subjectType;
  if (
    context.legacyDemo ||
    !nonEmpty(context.workspaceId) ||
    (subjectType !== "USER" && subjectType !== "TEAM") ||
    !nonEmpty(context.subjectId) ||
    !nonEmpty(context.agentId) ||
    !nonEmpty(context.oauthInstallationId) ||
    !nonEmpty(context.bindingId) ||
    !nonEmpty(context.connectionId) ||
    !Number.isSafeInteger(context.bindingRevision) ||
    (context.bindingRevision ?? 0) < 1
  ) {
    throw new AppError("FORBIDDEN", "The OAuth request is missing its trusted connection binding.", {
      httpStatus: 403,
    });
  }

  const expectedActorId = `${context.workspaceId}:${subjectType.toLowerCase()}:${context.subjectId}`;
  if (context.actorId !== expectedActorId) {
    throw new AppError("FORBIDDEN", "The OAuth request identity does not match its connection binding.", {
      httpStatus: 403,
    });
  }
  return context as OAuthBoundRequestContext;
}

/**
 * Resolves the tenant safety gate for a write without weakening either runtime.
 * OAuth/Broker requests are already pinned to one active server-side binding,
 * so that exact bound tenant is the allowlist. The legacy shared-bearer path
 * has no such identity binding and must continue to use the explicit deploy
 * allowlist.
 */
export function allowedWriteTenantForRequest(
  context: RequestContext,
  boundTenantId: string,
  configuredLegacyAllowedTenantId?: string,
): string | undefined {
  if (context.legacyDemo) return configuredLegacyAllowedTenantId;
  requireOAuthBoundRequestContext(context);
  if (boundTenantId.length === 0 || boundTenantId !== boundTenantId.trim()) {
    throw new AppError("FORBIDDEN", "The OAuth request has no exact bound ledger tenant.", {
      httpStatus: 403,
    });
  }
  return boundTenantId;
}

/**
 * Transitional adapter for the existing single shared MCP Bearer credential.
 * Only server-owned configuration is accepted; a fresh request ID is always
 * generated here at the trusted edge.
 */
export function createLegacySharedBearerRequestContext(options: {
  actorId: string;
  audience: string;
  scopes?: readonly string[];
  issuer?: string;
  subjectPrefix?: string;
  tokenId?: string;
}): RequestContext {
  const scopes = Object.freeze([...(options.scopes ?? [])]);
  const roles = Object.freeze([] as string[]);
  const authn = Object.freeze({
    issuer: options.issuer ?? "urn:ledger-mcp:legacy-demo",
    subject: `${options.subjectPrefix ?? "legacy-demo"}:${options.actorId}`,
    audience: options.audience,
    tokenId: options.tokenId ?? "legacy-demo-shared-bearer",
  });

  return Object.freeze({
    requestId: randomUUID(),
    actorId: options.actorId,
    scopes,
    roles,
    authn,
    legacyDemo: true,
  });
}

export function actorIdForResolvedBinding(
  binding: Pick<ResolvedMcpAccessToken, "workspaceId" | "subjectType" | "subjectId">,
): string {
  return `${binding.workspaceId}:${binding.subjectType.toLowerCase()}:${binding.subjectId}`;
}

/** Builds the only non-legacy RequestContext accepted by the MCP runtime. */
export function createOAuthRequestContext(options: {
  issuer: string;
  resolvedToken: ResolvedMcpAccessToken;
}): RequestContext {
  const token = options.resolvedToken;
  if (!Number.isSafeInteger(token.bindingRevision) || token.bindingRevision < 1) {
    throw new AppError("AUTH_REQUIRED", "The resolved OAuth token has no valid binding revision.", {
      httpStatus: 401,
    });
  }
  const scopes = Object.freeze([...token.grantedScopes]);
  const roles = Object.freeze([] as string[]);
  const authn = Object.freeze({
    issuer: options.issuer,
    subject: `${token.subjectType.toLowerCase()}:${token.subjectId}`,
    audience: token.audience,
    tokenId: token.tokenId,
  });

  return Object.freeze({
    requestId: randomUUID(),
    actorId: actorIdForResolvedBinding(token),
    workspaceId: token.workspaceId,
    subjectType: token.subjectType,
    subjectId: token.subjectId,
    ...(token.subjectType === "USER" ? { userId: token.subjectId } : {}),
    agentId: token.agentId,
    oauthInstallationId: token.installationId,
    bindingId: token.bindingId,
    connectionId: token.connectionId,
    bindingRevision: token.bindingRevision,
    scopes,
    roles,
    authn,
    legacyDemo: false,
  });
}

function requiredAuthInfoString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new AppError("AUTH_REQUIRED", `The verified OAuth token is missing ${field}.`, {
      httpStatus: 401,
    });
  }
  return value;
}

function requiredAuthInfoPositiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppError("AUTH_REQUIRED", `The verified OAuth token is missing ${field}.`, {
      httpStatus: 401,
    });
  }
  return value;
}

/**
 * Converts only SDK-verified AuthInfo into the runtime principal. The bearer
 * token itself is intentionally discarded; identity and connection values
 * come exclusively from the Broker's resolved server-side token record.
 */
export function createOAuthRequestContextFromAuthInfo(options: {
  issuer: string;
  expectedAudience: string;
  authInfo: AuthInfo;
}): RequestContext {
  const { authInfo } = options;
  if (authInfo.resource?.href !== options.expectedAudience) {
    throw new AppError("AUTH_REQUIRED", "The verified OAuth token has the wrong audience.", {
      httpStatus: 401,
    });
  }
  const extra = authInfo.extra ?? {};
  const subjectType = extra.subjectType;
  if (subjectType !== "USER" && subjectType !== "TEAM") {
    throw new AppError("AUTH_REQUIRED", "The verified OAuth token has no trusted subject type.", {
      httpStatus: 401,
    });
  }
  const resolvedToken: ResolvedMcpAccessToken = {
    tokenId: requiredAuthInfoString(extra.credentialId, "credential ID"),
    clientId: requiredAuthInfoString(authInfo.clientId, "client ID"),
    resource: options.expectedAudience,
    audience: options.expectedAudience,
    grantedScopes: [...authInfo.scopes],
    issuedAt: new Date(0),
    expiresAt: new Date((authInfo.expiresAt ?? 0) * 1_000),
    installationId: requiredAuthInfoString(extra.installationId, "installation ID"),
    bindingId: requiredAuthInfoString(extra.bindingId, "binding ID"),
    connectionId: requiredAuthInfoString(extra.connectionId, "connection ID"),
    bindingRevision: requiredAuthInfoPositiveSafeInteger(extra.bindingRevision, "binding revision"),
    authorizationId: requiredAuthInfoString(extra.authorizationId, "authorization ID"),
    workspaceId: requiredAuthInfoString(extra.workspaceId, "workspace ID"),
    subjectType,
    subjectId: requiredAuthInfoString(extra.subjectId, "subject ID"),
    agentId: requiredAuthInfoString(extra.agentId, "agent ID"),
    policyId: requiredAuthInfoString(extra.policyId, "policy ID"),
    tenantId: requiredAuthInfoString(extra.tenantId, "tenant ID"),
  };
  if (!Number.isFinite(resolvedToken.expiresAt.getTime()) || resolvedToken.expiresAt <= new Date()) {
    throw new AppError("AUTH_REQUIRED", "The verified OAuth token is expired.", {
      httpStatus: 401,
    });
  }
  return createOAuthRequestContext({ issuer: options.issuer, resolvedToken });
}
