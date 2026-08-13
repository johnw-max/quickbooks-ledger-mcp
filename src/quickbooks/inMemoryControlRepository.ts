import type {
  QuickBooksAuditCompletion,
  QuickBooksAuditIntent,
  QuickBooksControlRepository,
} from "./controlRepository.js";

type StoredAudit = QuickBooksAuditIntent | (Omit<QuickBooksAuditIntent, "resultStatus"> & QuickBooksAuditCompletion);

export class InMemoryQuickBooksControlRepository implements QuickBooksControlRepository {
  readonly #oauth = new Map<string, { browserSessionHash: string; actorId: string; expiresAt: Date; consumed: boolean }>();
  readonly #tickets = new Map<string, { actorId: string; expiresAt: Date; consumed: boolean }>();
  readonly #sessions = new Map<string, { actorId: string; expiresAt: Date }>();
  readonly #csrf = new Map<string, {
    sessionHash: string; actorId: string; postingRequestId: string; expiresAt: Date; consumed: boolean;
  }>();
  readonly #audits = new Map<string, StoredAudit>();

  async readiness() { return true; }
  async saveOAuthState(stateHash: string, browserSessionHash: string, actorId: string, expiresAt: Date) {
    if (!this.#oauth.has(stateHash)) this.#oauth.set(stateHash, { browserSessionHash, actorId, expiresAt, consumed: false });
  }
  async consumeOAuthState(stateHash: string, browserSessionHash: string, now: Date) {
    const state = this.#oauth.get(stateHash);
    if (!state || state.consumed || state.expiresAt <= now || state.browserSessionHash !== browserSessionHash) return undefined;
    state.consumed = true;
    return { actorId: state.actorId };
  }
  async saveConnectTicket(ticketHash: string, actorId: string, expiresAt: Date) {
    if (!this.#tickets.has(ticketHash)) this.#tickets.set(ticketHash, { actorId, expiresAt, consumed: false });
  }
  async consumeConnectTicket(ticketHash: string, now: Date) {
    const ticket = this.#tickets.get(ticketHash);
    if (!ticket || ticket.consumed || ticket.expiresAt <= now) return undefined;
    ticket.consumed = true;
    return { actorId: ticket.actorId };
  }
  async saveOperatorSession(sessionHash: string, actorId: string, expiresAt: Date) {
    this.#sessions.set(sessionHash, { actorId, expiresAt });
  }
  async getOperatorSession(sessionHash: string, now: Date) {
    const session = this.#sessions.get(sessionHash);
    return session && session.expiresAt > now ? { actorId: session.actorId } : undefined;
  }
  async revokeOperatorSessions(actorId: string) {
    let count = 0;
    for (const [key, session] of this.#sessions) if (session.actorId === actorId) { this.#sessions.delete(key); count += 1; }
    return count;
  }
  async saveReviewCsrf(csrfHash: string, sessionHash: string, actorId: string, postingRequestId: string, expiresAt: Date) {
    this.#csrf.set(csrfHash, { sessionHash, actorId, postingRequestId, expiresAt, consumed: false });
  }
  async consumeReviewCsrf(csrfHash: string, sessionHash: string, actorId: string, postingRequestId: string, now: Date) {
    const token = this.#csrf.get(csrfHash);
    if (!token || token.consumed || token.expiresAt <= now || token.sessionHash !== sessionHash ||
        token.actorId !== actorId || token.postingRequestId !== postingRequestId) return false;
    token.consumed = true;
    return true;
  }
  async beginAudit(intent: QuickBooksAuditIntent) { this.#audits.set(intent.callId, structuredClone(intent)); }
  async completeAudit(callId: string, completion: QuickBooksAuditCompletion) {
    const audit = this.#audits.get(callId);
    if (!audit || audit.resultStatus !== "IN_PROGRESS") throw new Error("Audit intent is missing or complete");
    this.#audits.set(callId, { ...audit, ...structuredClone(completion) });
  }
}
