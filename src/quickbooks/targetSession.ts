import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { AppError } from "../errors.js";
import type { TokenCipher } from "../security/tokenCipher.js";

const TARGET_SESSION_PREFIX = "qbts_";
const TARGET_SESSION_CONTEXT = "quickbooks-target-session:v1";

const claimsSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  actorId: z.string().min(1).max(256),
  connectionId: z.string().min(1).max(256),
  realmId: z.string().regex(/^\d{3,32}$/),
  bindingRevision: z.string().regex(/^quickbooks-binding-revision:[a-f0-9]{32}$/),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export type QuickBooksTargetSessionClaims = z.infer<typeof claimsSchema>;

export interface QuickBooksTargetSession {
  readonly targetSessionRef: string;
  readonly expiresAt: Date;
}

/**
 * Issues an opaque, short-lived capability that pins a workflow step to one
 * actor + connection + Realm + binding revision. It is intentionally stateless:
 * replacement/revocation is enforced by re-reading the connection on every use.
 */
export class QuickBooksTargetSessionService {
  readonly #cipher: TokenCipher;
  readonly #ttlSeconds: number;
  readonly #now: () => Date;

  constructor(options: {
    cipher: TokenCipher;
    ttlSeconds?: number;
    now?: () => Date;
  }) {
    this.#cipher = options.cipher;
    this.#ttlSeconds = options.ttlSeconds ?? 900;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#ttlSeconds) || this.#ttlSeconds < 60 || this.#ttlSeconds > 3_600) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks target session TTL must be between 60 and 3600 seconds.", {
        httpStatus: 500,
      });
    }
  }

  issue(input: {
    actorId: string;
    connectionId: string;
    realmId: string;
    bindingRevision: string;
  }): QuickBooksTargetSession {
    const issuedAt = this.#now();
    const expiresAt = new Date(issuedAt.getTime() + this.#ttlSeconds * 1_000);
    const claims = claimsSchema.parse({
      version: 1,
      sessionId: randomUUID(),
      actorId: input.actorId,
      connectionId: input.connectionId,
      realmId: input.realmId,
      bindingRevision: input.bindingRevision,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return {
      targetSessionRef: `${TARGET_SESSION_PREFIX}${this.#cipher.encrypt(JSON.stringify(claims), TARGET_SESSION_CONTEXT)}`,
      expiresAt,
    };
  }

  verify(targetSessionRef: string, expectedActorId: string): QuickBooksTargetSessionClaims {
    if (
      typeof targetSessionRef !== "string" ||
      !targetSessionRef.startsWith(`${TARGET_SESSION_PREFIX}v1.`) ||
      targetSessionRef.length > 2_048
    ) {
      throw this.#invalid();
    }
    try {
      const plaintext = this.#cipher.decrypt(
        targetSessionRef.slice(TARGET_SESSION_PREFIX.length),
        TARGET_SESSION_CONTEXT,
      );
      const claims = claimsSchema.parse(JSON.parse(plaintext));
      const now = this.#now().getTime();
      const issuedAt = new Date(claims.issuedAt).getTime();
      const expiresAt = new Date(claims.expiresAt).getTime();
      if (issuedAt > now + 30_000 || expiresAt <= now || expiresAt <= issuedAt) throw this.#invalid();
      if (claims.actorId !== expectedActorId) {
        throw new AppError("FORBIDDEN", "The QuickBooks target session belongs to another MCP installation.", {
          httpStatus: 403,
        });
      }
      return claims;
    } catch (error) {
      if (error instanceof AppError && error.code === "FORBIDDEN") throw error;
      throw this.#invalid(error);
    }
  }

  #invalid(cause?: unknown): AppError {
    return new AppError("AUTH_REQUIRED", "The QuickBooks target session is invalid or expired; resolve the target again.", {
      httpStatus: 401,
      retryable: true,
      cause,
    });
  }
}
