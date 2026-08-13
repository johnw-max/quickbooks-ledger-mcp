import { z } from "zod/v4";
import type { QuickBooksEnvironment } from "../providers/quickbooksTypes.js";
import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS } from "./accountingCase.js";
import { QUICKBOOKS_WRITE_CAPABILITIES } from "./writePolicy.js";

const csv = z.string().transform((value, context) => {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    context.addIssue({ code: "custom", message: "must contain at least one entry" });
    return z.NEVER;
  }
  return entries;
});

const base64Key = z.string().refine((value) => {
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}, "must be a base64-encoded 32-byte key");

const booleanFlag = z.enum(["true", "false"]).default("false").transform((value) => value === "true");

const optionalMinorVersion = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().int().min(1).max(999).optional(),
);

const optionalCsv = z.string().optional().transform((value, context) => {
  if (value === undefined || value.trim() === "") return [];
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    context.addIssue({ code: "custom", message: "must contain at least one entry" });
    return z.NEVER;
  }
  return entries;
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  QUICKBOOKS_HOST: z.string().min(1).default("127.0.0.1"),
  QUICKBOOKS_PORT: z.coerce.number().int().min(1).max(65_535).default(3010),
  QUICKBOOKS_PUBLIC_BASE_URL: z.string().url().transform((value) => value.replace(/\/$/, "")),
  DATABASE_URL: z.string().min(1),
  QUICKBOOKS_MCP_BEARER_TOKEN: z.string().min(32),
  QUICKBOOKS_MCP_ALLOWED_ORIGINS: csv,
  QUICKBOOKS_MCP_ALLOWED_HOSTS: csv,
  QUICKBOOKS_REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(5_242_880).default(1_048_576),
  QUICKBOOKS_CLIENT_ID: z.string().min(1),
  QUICKBOOKS_CLIENT_SECRET: z.string().min(1),
  QUICKBOOKS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  QUICKBOOKS_MINOR_VERSION: optionalMinorVersion,
  QUICKBOOKS_WRITE_ENABLED: booleanFlag,
  QUICKBOOKS_WRITE_TARGET_MODE: z.enum(["exact_allowlist", "oauth_bound"]).default("exact_allowlist"),
  QUICKBOOKS_ALLOWED_REALM_ID: z.string().regex(/^\d{3,32}$/).optional(),
  QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES: optionalCsv,
  QUICKBOOKS_RESTRICTED_REVIEWER_ACTORS: optionalCsv,
  QUICKBOOKS_STANDING_DELEGATION_ENABLED: booleanFlag,
  QUICKBOOKS_STANDING_DELEGATION_ACTIONS: optionalCsv,
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_B64: base64Key,
  QUICKBOOKS_DEMO_ACTOR_ID: z.string().min(1).max(128).default("quickbooks-demo-operator"),
  QUICKBOOKS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  QUICKBOOKS_MCP_OAUTH_ENABLED: booleanFlag,
  QUICKBOOKS_MCP_OAUTH_CLIENT_ID: z.string().min(8).max(256).optional(),
  QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET: z.string().min(32).max(512).optional(),
  QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS: optionalCsv,
  QUICKBOOKS_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3_600),
  QUICKBOOKS_MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3_600).max(31_536_000).default(2_592_000),
  QUICKBOOKS_TARGET_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
});

export interface QuickBooksRuntimeConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  mcpBearerToken: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  requestBodyLimitBytes: number;
  oauth: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    environment: QuickBooksEnvironment;
    minorVersion?: number;
  };
  writeEnabled: boolean;
  writeTargetMode: "exact_allowlist" | "oauth_bound";
  allowedRealmId?: string;
  allowedWriteCapabilities: string[];
  restrictedReviewerActors: string[];
  standingDelegationEnabled: boolean;
  standingDelegationActions: string[];
  targetSessionTtlSeconds: number;
  tokenEncryptionKey: Buffer;
  demoActorId: string;
  logLevel: "debug" | "info" | "warn" | "error";
  mcpOAuth?: {
    clientId: string;
    clientSecret: string;
    redirectUris: string[];
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  };
}

export function loadQuickBooksConfig(env: NodeJS.ProcessEnv = process.env): QuickBooksRuntimeConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid QuickBooks configuration: ${message}`);
  }
  const value = parsed.data;
  const knownWriteCapabilities = new Set(
    QUICKBOOKS_WRITE_CAPABILITIES.map((capability) => `${capability.operation}:${capability.entity}`),
  );
  const unknownWriteCapabilities = value.QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES
    .filter((capability) => !knownWriteCapabilities.has(capability));
  if (unknownWriteCapabilities.length > 0) {
    throw new Error(`Invalid QuickBooks configuration: unknown write capabilities ${unknownWriteCapabilities.join(", ")}`);
  }
  const releasedCaseActions = new Set<string>(QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS);
  const unknownStandingDelegationActions = value.QUICKBOOKS_STANDING_DELEGATION_ACTIONS
    .filter((action) => !releasedCaseActions.has(action));
  if (unknownStandingDelegationActions.length > 0) {
    throw new Error(
      `Invalid QuickBooks configuration: standing delegation contains unreleased Accounting Case actions ${unknownStandingDelegationActions.join(", ")}`,
    );
  }
  if (value.QUICKBOOKS_STANDING_DELEGATION_ENABLED && value.QUICKBOOKS_STANDING_DELEGATION_ACTIONS.length === 0) {
    throw new Error(
      "Invalid QuickBooks configuration: QUICKBOOKS_STANDING_DELEGATION_ACTIONS is required when standing delegation is enabled",
    );
  }
  const publicUrl = new URL(value.QUICKBOOKS_PUBLIC_BASE_URL);
  if (
    value.NODE_ENV === "production" &&
    (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash ||
      publicUrl.username || publicUrl.password)
  ) {
    throw new Error("Invalid QuickBooks configuration: public base URL must be an HTTPS origin in production");
  }
  if (
    value.QUICKBOOKS_WRITE_ENABLED &&
    value.QUICKBOOKS_WRITE_TARGET_MODE === "exact_allowlist" &&
    !value.QUICKBOOKS_ALLOWED_REALM_ID
  ) {
    throw new Error("Invalid QuickBooks configuration: QUICKBOOKS_ALLOWED_REALM_ID is required when writes are enabled");
  }
  if (value.QUICKBOOKS_MCP_OAUTH_ENABLED) {
    if (
      !value.QUICKBOOKS_MCP_OAUTH_CLIENT_ID ||
      !value.QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET ||
      value.QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS.length === 0
    ) {
      throw new Error("Invalid QuickBooks configuration: MCP OAuth client, secret, and redirect URI are required when enabled");
    }
    for (const redirectUri of value.QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS) {
      const redirect = new URL(redirectUri);
      if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash) {
        throw new Error("Invalid QuickBooks configuration: MCP OAuth redirect URIs must be HTTPS URLs without credentials or fragments");
      }
    }
  }
  return {
    nodeEnv: value.NODE_ENV,
    host: value.QUICKBOOKS_HOST,
    port: value.QUICKBOOKS_PORT,
    publicBaseUrl: value.QUICKBOOKS_PUBLIC_BASE_URL,
    databaseUrl: value.DATABASE_URL,
    mcpBearerToken: value.QUICKBOOKS_MCP_BEARER_TOKEN,
    allowedOrigins: value.QUICKBOOKS_MCP_ALLOWED_ORIGINS,
    allowedHosts: value.QUICKBOOKS_MCP_ALLOWED_HOSTS.map((host) => new URL(`http://${host}`).hostname),
    requestBodyLimitBytes: value.QUICKBOOKS_REQUEST_BODY_LIMIT_BYTES,
    oauth: {
      clientId: value.QUICKBOOKS_CLIENT_ID,
      clientSecret: value.QUICKBOOKS_CLIENT_SECRET,
      redirectUri: `${value.QUICKBOOKS_PUBLIC_BASE_URL}/oauth/quickbooks/callback`,
      environment: value.QUICKBOOKS_ENVIRONMENT,
      ...(value.QUICKBOOKS_MINOR_VERSION === undefined ? {} : { minorVersion: value.QUICKBOOKS_MINOR_VERSION }),
    },
    writeEnabled: value.QUICKBOOKS_WRITE_ENABLED,
    writeTargetMode: value.QUICKBOOKS_WRITE_TARGET_MODE,
    ...(value.QUICKBOOKS_ALLOWED_REALM_ID ? { allowedRealmId: value.QUICKBOOKS_ALLOWED_REALM_ID } : {}),
    allowedWriteCapabilities: value.QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES,
    restrictedReviewerActors: value.QUICKBOOKS_RESTRICTED_REVIEWER_ACTORS,
    standingDelegationEnabled: value.QUICKBOOKS_STANDING_DELEGATION_ENABLED,
    standingDelegationActions: value.QUICKBOOKS_STANDING_DELEGATION_ACTIONS,
    targetSessionTtlSeconds: value.QUICKBOOKS_TARGET_SESSION_TTL_SECONDS,
    tokenEncryptionKey: Buffer.from(value.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_B64, "base64"),
    demoActorId: value.QUICKBOOKS_DEMO_ACTOR_ID,
    logLevel: value.QUICKBOOKS_LOG_LEVEL,
    ...(value.QUICKBOOKS_MCP_OAUTH_ENABLED ? {
      mcpOAuth: {
        clientId: value.QUICKBOOKS_MCP_OAUTH_CLIENT_ID as string,
        clientSecret: value.QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET as string,
        redirectUris: value.QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS,
        accessTokenTtlSeconds: value.QUICKBOOKS_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenTtlSeconds: value.QUICKBOOKS_MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      },
    } : {}),
  };
}
