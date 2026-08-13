export interface QuickBooksAuditIntent {
  callId: string;
  actorId: string;
  tenantId?: string;
  toolName: string;
  requestHash: string;
  resultStatus: "IN_PROGRESS";
  startedAt: Date;
}

export interface QuickBooksAuditCompletion {
  resultStatus: "SUCCEEDED" | "REJECTED" | "FAILED";
  providerRequestId?: string;
  recordId?: string;
  errorClass?: string;
  finishedAt: Date;
}

/** Provider-local control plane. It contains no Xero tables or domain types. */
export interface QuickBooksControlRepository {
  readiness(): Promise<boolean>;
  saveOAuthState(stateHash: string, browserSessionHash: string, actorId: string, expiresAt: Date): Promise<void>;
  consumeOAuthState(
    stateHash: string,
    browserSessionHash: string,
    now: Date,
  ): Promise<{ actorId: string } | undefined>;
  saveConnectTicket(ticketHash: string, actorId: string, expiresAt: Date): Promise<void>;
  consumeConnectTicket(ticketHash: string, now: Date): Promise<{ actorId: string } | undefined>;
  saveOperatorSession(sessionHash: string, actorId: string, expiresAt: Date): Promise<void>;
  getOperatorSession(sessionHash: string, now: Date): Promise<{ actorId: string } | undefined>;
  revokeOperatorSessions(actorId: string): Promise<number>;
  saveReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    expiresAt: Date,
  ): Promise<void>;
  consumeReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    now: Date,
  ): Promise<boolean>;
  beginAudit(intent: QuickBooksAuditIntent): Promise<void>;
  completeAudit(callId: string, completion: QuickBooksAuditCompletion): Promise<void>;
}
