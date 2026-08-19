# Connector-neutral capability routing

## 1. Layer boundary

| Layer | Owns | Must not own |
|---|---|---|
| Accounting Skill | Economic-event interpretation, accounting treatment, evidence requirements, approval gate, business outcome wording | Raw provider API fields, OAuth, folder/range logic |
| Domain runtime | Canonical intent, lifecycle, deterministic validation, permission view, idempotency, audit, capability routing | Provider-specific business shortcuts |
| MCP/provider adapter | Authorized data/action execution, provider mapping, tenant enforcement, receipts, read-back | Changing the approved accounting meaning |
| Destination | Source evidence, workflow state, or formal books according to its declared role | A role it was not authorized to serve |

MCP is a protocol/tool surface. It does not make different tools semantically interchangeable. Portability requires a stable business capability contract or an adapter that maps provider-specific tools into that contract.

## 2. Portable accounting intent

Pass an immutable business envelope to the execution layer:

```text
intent_id / proposal_id / version / digest
requested_entity_label / verified_ledger_target_ref / binding_revision
entity_scope / period / transaction_date / base_currency
transaction_kind / native_or_manual_route
source_refs[] / counterparty_ref when relevant
fact_evidence_refs[]
lines[]: account_ref, debit, credit, tax, dimensions, description
total_debit / total_credit
approval_ref / approver_scope / approved_at
idempotency_key
```

The adapter may translate this envelope to a bill, invoice, payment, bank transaction, credit note, transfer, or manual journal. It may not silently change the business intent or accounting lines.

## 3. Destination roles

- `source_store`: original files and source metadata.
- `work_store`: optional case/work state, extracted fields, review records, proposals, approvals, handoffs, and business audit.
- `ledger_sor`: authoritative accounting transactions, journals, subledgers, reports, reconciliations, and period state.

One connector may implement several roles, and one workflow may compose several connectors. Determine the role from the authorized connection manifest, not from a brand name.

## 4. Semantic capability families

Tool names may differ. The deployment adapter maps them to capabilities such as:

```text
source.metadata.read / source.content.read
source.original.preserve / source.original.readback
work.scope.resolve / work.material.persist / work.material.readback
work.review_record.persist / work.review_record.readback / work.review_record.search
work.proposal.persist / work.proposal.readback
work.open_item.persist / work.open_item.read
work.reconciliation_candidate.persist / work.reconciliation_candidate.read
ledger.target.resolve
ledger.reference.accounts.read / ledger.reference.tax.read
ledger.reference.counterparty.read / ledger.period.status.read
ledger.transaction.search
ledger.transaction.native.prepare / ledger.transaction.native.execute
ledger.transaction.journal.prepare / ledger.transaction.journal.execute
ledger.object.read_exact
ledger.report.read
ledger.report.trial_balance.read
ledger.reconciliation.verify
ledger.period.lock
control.approval.verify / control.outcome.reconcile
```

A connection manifest should return a safe connection reference, destination role, authorized entity scope, safe target reference, binding revision, capability IDs, provider-state semantics version, and last verification time. Each read used as evidence also needs the normalized provenance envelope from the capability contract. The Skill must not infer missing capabilities from another tool on the same server.

## 5. Target and fact provenance gate

- Keep a user- or source-supplied entity label separate from the formal-ledger target.
- Resolve the active ledger target from current host-bound or `ledger.target.resolve` evidence. Re-resolve after a binding change.
- Require every later ledger read to carry the same safe target reference and binding revision, plus audit/tool reference, observation time, query bounds/completeness, output hash, and field bindings.
- Missing or stale target evidence is `TARGET_UNVERIFIED`; conflicting trusted targets are `TARGET_CONFLICT`; a read missing its envelope is `READ_EVIDENCE_REJECTED`. None permits a ledger-scoped join or write.
- A remembered name, example, attachment claim, file/work-store record, or prior chat cannot repair missing ledger-target evidence.

## 6. Maximum state by available capability

| Available capability | Maximum truthful state |
|---|---|
| None | `READY_FOR_MANUAL_POSTING` in chat |
| A source/work-store persistence action | `PROPOSAL_SAVED_OUTSIDE_LEDGER`, even if a ledger connector is mounted but unused |
| Formal-ledger context read | `PREPARED_UNPOSTED` |
| Formal-ledger non-effective draft write and read-back | `PROVIDER_DRAFT_UNPOSTED` |
| Definitive successful formal-ledger write without successful exact read-back | `WRITE_RESULT_UNVERIFIED`; this includes unavailable, failed, partial, or timed-out read-back |
| Timeout or ambiguous execution result | `OUTCOME_UNKNOWN`; query the original attempt when supported, otherwise investigate manually, and never resubmit |
| Exact read-back conflicts with approved intent | `WRITE_RESULT_MISMATCH` |
| Ledger-effective write plus exact read-back | `POSTED_READBACK_VERIFIED` |
| Trial Balance read | Separate Trial Balance evidence only |
| Reconciliation action plus support | Separate account-level reconciliation evidence only |
| All close controls plus authorized period lock and independent locked-status read-back | `CLOSED_VERIFIED` for the exact entity and period |

## 7. Provider examples

- With only a file/storage connector, read or preserve the source and optionally save the proposal/handoff. Never use a file or spreadsheet row as a journal receipt.
- With an accounting connector in read-only mode, use live company, account, tax, and history data to improve the proposal but stop before write.
- With a formal accounting connector, prefer its native business object. A provider draft remains unposted when that state does not affect the ledger.
- When source evidence is in Google Drive and the formal ledger is QuickBooks or Xero, use both connectors in one workflow: Drive for evidence, the authorized ledger connector for the accounting write and read-back.

## 8. Deterministic server controls

Every high-risk adapter must enforce tenant/entity binding, target/fact provenance, authorization, balance, valid account/tax/period, approval scope, idempotency, duplicate detection, state transition, outcome-unknown recovery, audit, and read-back comparison. These invariants must not depend only on the model following a Skill.
