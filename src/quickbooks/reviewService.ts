import { randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import { sha256 } from "../security/hash.js";
import type { QuickBooksControlRepository } from "./controlRepository.js";

type ReviewSecurityRepository = Pick<
  QuickBooksControlRepository,
  "saveOperatorSession" | "getOperatorSession" | "revokeOperatorSessions"
>;

/**
 * Operator browser-session lifecycle for the QuickBooks OAuth callback. It
 * carries no posting or mutation authority: Accounting Case writes are
 * authorised by standing delegation, never by an operator review page.
 */
export class QuickBooksReviewService {
  readonly #security: ReviewSecurityRepository;

  constructor(options: { security: ReviewSecurityRepository }) {
    this.#security = options.security;
  }

  async createOperatorSession(actorId: string): Promise<{ session: string; expiresAt: Date }> {
    const session = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 4 * 60 * 60_000);
    await this.#security.saveOperatorSession(sha256(`quickbooks:${session}`), actorId, expiresAt);
    return { session, expiresAt };
  }

  async authenticate(session: string): Promise<{ actorId: string; sessionHash: string }> {
    const sessionHash = sha256(`quickbooks:${session}`);
    const authenticated = await this.#security.getOperatorSession(sessionHash, new Date());
    if (!authenticated) {
      throw new AppError("AUTH_REQUIRED", "A valid QuickBooks review session is required.", { httpStatus: 401 });
    }
    return { actorId: authenticated.actorId, sessionHash };
  }

  async revokeActorSessions(actorId: string): Promise<number> {
    return this.#security.revokeOperatorSessions(actorId);
  }
}
