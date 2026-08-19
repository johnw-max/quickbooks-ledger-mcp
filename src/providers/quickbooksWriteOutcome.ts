/**
 * What is known about **QuickBooks' ledger** after a write was dispatched.
 *
 * The names describe the Provider's books, not what our process did. That is
 * the distinction the durable write lifecycle exists to preserve, and the one
 * the code had lost: it implemented CONFIRMED_WRITTEN and UNKNOWN and let
 * CONFIRMED_NOT_WRITTEN collapse into UNKNOWN, so a refusal Intuit spelled out
 * in a Fault body was recorded as "an object may exist that we hold no Id for".
 *
 * - CONFIRMED_WRITTEN     — an exact Provider Id is in hand; checkpoint it,
 *                           read it back, terminalize.
 * - CONFIRMED_NOT_WRITTEN — Intuit completed a response cycle and refused.
 *                           Nothing exists in the Company. The work can be
 *                           corrected and re-issued.
 * - UNKNOWN               — no completed response, or one we cannot interpret.
 *                           A write may have been applied. No automatic re-arm,
 *                           ever.
 *
 * UNKNOWN is the default for everything not positively proved otherwise.
 */
export type QuickBooksProviderWriteOutcome =
  | "CONFIRMED_WRITTEN"
  | "CONFIRMED_NOT_WRITTEN"
  | "UNKNOWN";

/**
 * Statuses in which Intuit's own structured refusal proves nothing was created.
 *
 *   400 — the document was rejected on validation (wrong currency for the
 *         vendor, unknown account, malformed line). No entity is created.
 *   401 — the credential was not accepted, so the request never reached the
 *         accounting engine.
 *   403 — the Company or the capability was denied for the same reason.
 *   404 — the addressed record does not exist; there is nothing to have
 *         changed.
 *
 * Deliberately excluded:
 *   409 — the record changed under us. That can be a concurrent creation of
 *         this very document, so it is not proof of a non-write.
 *   429 — already retryable with backoff; the existing path is correct.
 *   5xx — Intuit answered, but the write may well have been applied before the
 *         failure surfaced. This is what UNKNOWN is for.
 */
const CONFIRMED_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404]);

/**
 * Evidence about one Provider HTTP exchange. Only the Provider adapter can
 * produce this: it is the sole layer that observes whether a response cycle
 * completed, what the body actually was, and which endpoint was addressed.
 */
export interface QuickBooksProviderResponseEvidence {
  /** A response was received and its body read. False for transport errors, aborts and timeouts. */
  responseCompleted: boolean;
  httpStatus: number;
  /** Intuit's own `Fault.Error` structure was recognised in the parsed body. */
  faultRecognised: boolean;
  /** The multipart `/upload` endpoint rather than an entity endpoint. */
  uploadEndpoint: boolean;
}

/**
 * Decide what QuickBooks' ledger holds after a failed write.
 *
 * Every condition below is required, and each rules out a way a refusal can be
 * counterfeited:
 *
 *  - A completed response cycle. A transport error, abort or timeout tells us
 *    nothing about whether the POST was applied.
 *  - Intuit's own Fault structure in the body. A bare 401 or 403 from an edge
 *    proxy, gateway or WAF is not Intuit speaking: the request may never have
 *    reached the accounting engine, or may have reached it and been applied
 *    before the intermediary rewrote the response. Only Intuit's structured
 *    refusal is proof.
 *  - An entity endpoint, not `/upload`. The multipart attachment endpoint has
 *    its own response semantics — it can report per-part outcomes and can
 *    return a non-2xx while having accepted the upload — so a 400 there is not
 *    reasoned through here and is not claimed as proof.
 *  - A status in the confirmed-refusal set.
 *
 * Anything short of all four is UNKNOWN, which is the safe answer.
 */
export function classifyQuickBooksProviderWriteFailure(
  evidence: QuickBooksProviderResponseEvidence,
): Extract<QuickBooksProviderWriteOutcome, "CONFIRMED_NOT_WRITTEN" | "UNKNOWN"> {
  if (!evidence.responseCompleted) return "UNKNOWN";
  if (!evidence.faultRecognised) return "UNKNOWN";
  if (evidence.uploadEndpoint) return "UNKNOWN";
  if (!CONFIRMED_REFUSAL_STATUSES.has(evidence.httpStatus)) return "UNKNOWN";
  return "CONFIRMED_NOT_WRITTEN";
}

/**
 * Read back the outcome the Provider adapter stamped on a failed write.
 *
 * Callers must use this rather than inspecting an error's code or shape.
 * VALIDATION_FAILED, NOT_FOUND and FORBIDDEN are all raised locally too — by
 * Zod, by business rules, by fencing checks — and classifying on the shape of
 * the last error is exactly the mistake migrations 036 and 037 were written to
 * undo. Absence of the stamp means UNKNOWN.
 */
export function quickBooksProviderWriteOutcome(error: {
  details?: Record<string, unknown> | undefined;
}): QuickBooksProviderWriteOutcome {
  const stamped = error.details?.providerWriteOutcome;
  return stamped === "CONFIRMED_NOT_WRITTEN" || stamped === "CONFIRMED_WRITTEN"
    ? stamped
    : "UNKNOWN";
}
