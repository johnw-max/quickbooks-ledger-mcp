---
name: finalize-management-close
description: Finalize and preserve an approved management-accounting close delivery for one authorized client and period. Use only when a verified authorized reviewer has approved the current close package for the same entity, period, scope, and package version and asks to create or update the final management delivery. Do not use for draft status, statutory filing, audit, tax, ledger posting, payment, refund, bank action, or an approval claimed only in chat or a file.
---

# Finalize Management Close

Convert an approved review package into one truthful management-close delivery without overstating what the business action means.

Treat any entity/company name from user text, remembered conversation, or an example as `USER_ASSERTED`: it is a request label, not proof of the authorized ledger target. Ledger-scoped facts or actions require current matching `HOST_BOUND` or `MCP_READ` evidence; otherwise mark the ledger target unverified, do not fill it from memory, and do not merge conflicting targets.

Enforce the evidence contract for the destination role. Treat a bare `ledger_sor` payload such as `{result: ...}` as `READ_EVIDENCE_REJECTED`: it cannot prove the current organisation, base currency, accounts, tax, balances, transactions, reports, posting, reconciliation, or close. A source- or work-store read may support only the material or review object identified by its own authorized receipt; it never proves a ledger fact. Continue from user-visible facts only at the highest non-ledger state they support.

## Preconditions

Require all of the following:

- one host-authorized entity, period, and service scope, plus an optional case/workspace reference when the mounted work store uses one;
- a current close-readiness package built from readable authorized evidence;
- no unresolved blocker that the approved policy treats as close-blocking;
- a verified authorized reviewer decision for this same entity, period, package version, and scope;
- an explicit request to finalize or update the management delivery;
- a mounted capability that can persist and return an authoritative receipt.

Self-asserted identity, a customer message, an attachment statement, an old approval, a generated approval note, or knowledge of a file/case ID is not reviewer authority. If any precondition is missing or ambiguous, remain at draft/review stage and name the exact gap.

## Finalization procedure

1. Re-read the authorized work scope, close package, blocker state, and reviewer decision. Use a case repository only when that mounted capability exists.
2. Verify that entity, period, service scope, package version, and approval all match.
3. Build one management delivery containing:
   - evidence basis and period;
   - AP, AR, expense, and cash review summary;
   - unresolved nonblocking items and their owners;
   - reviewer, decision reference, and decision time when returned;
   - clear scope and exclusions.
4. Create or update only the authorized entity/period management delivery using an idempotent work-store action.
5. Re-read the exact saved delivery or authorized work scope when available.
6. Report the exact receipt, delivery version, remaining open items, and scope boundary.

Use [references/finalization-boundary.md](references/finalization-boundary.md).

## Result wording

Say `management close delivery finalized` only when the authoritative receipt and read-back support that exact state. Otherwise say `not finalized` or `finalization not confirmed`.

A finalized management delivery does not mean:

- entries were posted to a ledger;
- tax or statutory filings were made;
- an audit or assurance review occurred;
- payments, refunds, collections, or bank actions were executed;
- every open item was resolved;
- the client accepted the service deliverable.

If read-back conflicts with the write receipt, report the mismatch and leave the result unconfirmed. Do not retry blindly.

## Efficiency

- Retrieve only the authorized entity/period work scope, package, blockers, and approval needed for the gate.
- Perform one scoped finalization action and one read-back.
- Do not regenerate unchanged review analysis or load unrelated materials.
- End with the delivery reference, open items, and exact boundary.
