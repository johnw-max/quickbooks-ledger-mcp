# Accounting Double-Entry Skills — Local Revision Candidate

Revision date: 2026-08-10

## Decision

This candidate corrects the accounting-layer gap found in the 2026-07-28 review-stage release. The existing line-by-line material and reconciliation registers remain useful, but they are now explicitly treated as source/review records rather than a general ledger or completed bookkeeping.

This is the product standard for an accounting-firm bookkeeping and month-end workflow. It is not a claim that every small business in every jurisdiction is legally required to keep double-entry books.

The candidate adds `prepare-balanced-accounting-entry` and `execute-approved-accounting-entry`, then updates the coordinator, material/review Skills, close-readiness, Agent instructions, and capability boundary so that the workflow distinguishes:

1. source record received;
2. balanced accounting-entry proposal prepared;
3. proposal saved outside the ledger, provider draft, or ledger-effective transaction posted and read back from an authorized formal accounting system;
4. account reconciled;
5. period closed and locked.

Equal debits and credits are required for every proposed entry, but they do not prove that the entry is correct, posted, reconciled, or closed.

## Candidate scope

- Preserve source facts and review uncertainty.
- Prepare two-line or compound debit/credit proposals.
- Separate invoice recognition from later receipt or payment.
- Prefer native accounting-system forms for routine bills, invoices, payments, expenses, and bank transactions; reserve manual-journal routes for adjustments or accountant-directed cases.
- Bind final account codes, tax codes, currency rules, and periods to the connected accounting system rather than inventing them.
- Keep the explicitly bound formal accounting system as the ledger system of record; Xero and QuickBooks are supported adapter examples rather than Skill dependencies.

## Layering and portability

- **Accounting Skills:** own economic-event interpretation, accounting treatment, evidence requirements, approval gates, exception handling, and truthful business states.
- **Capability router/domain runtime:** owns the canonical accounting intent, effective-capability calculation, policy, lifecycle, idempotency, audit, and adapter selection.
- **MCP/provider adapters:** own authorized data access/action execution, provider mapping, tenant binding, deterministic validation, receipts, and read-back.
- **Destinations:** declare `source_store`, `work_store`, or `ledger_sor` roles. A Google Drive or work-store receipt cannot be promoted to a formal-ledger receipt.

The same business Skill can run with no connector, source/work storage, a read-only accounting connector, or a ledger read/write connector. The accounting judgment remains stable while the maximum truthful completion state changes. See [agent-config/capability-contract.md](agent-config/capability-contract.md).

## Current boundary

This folder remains the local release candidate; it has not replaced the production Accounting or Xero Agent. On 2026-08-10, derived copies of all 11 Skills plus the candidate Agent instructions were loaded into an isolated Work UAT Agent and exercised against the existing Xero MCP without reconnecting OAuth or performing a write. Skill-first routing, company-conflict handling, balanced-unposted proposal behavior, and refusal to equate Trial Balance with close were demonstrated. The integrated result is nevertheless **not production-ready** because current ordinary Xero reads still return bare `{result: ...}` payloads and the model did not reliably enforce the missing-provenance rejection. See [the integrated UAT results](../reviews/accounting-double-entry-integrated-xero-uat-2026-08-10/ONLINE-UAT-RESULTS.md).

Deployment-specific MCP mappings live in connector profiles rather than the business Skills. A deployment may reach only the state supported by its effective capabilities and exact receipts. Agent instructions are a separate deployment artifact: uploading the 11 Skill ZIPs alone does not install the mandatory Skill-loading and provenance gate.

The candidate now treats entity and ledger-fact provenance as a release gate: a user-supplied or remembered company name is only a request label; current organisation, base currency, and ledger data require a current host/MCP target receipt and matching binding revision. Missing, stale, conflicting, or envelope-free reads must remain unverified and cannot be joined or written.

The current accountingV2 + Drive deployment profile is source/work-store only and cannot prove posting. A separate Xero codebase supports live account/tax reads, balanced Manual Journal DRAFT controls, exact-ID read-back, and bounded Trial Balance reads, but it is not automatically mounted by this package. The Xero MCP used in the isolated online UAT still emitted non-conforming bare ordinary-read receipts. A conforming read-envelope patch now passes local type checking, all 869 default and required-gate tests in their applicable HTTP/PostgreSQL environments, and a production build, but it has not been deployed or re-tested online. The QuickBooks adapter also remains subject to its own current deployment evidence. See [agent-config/mcp-tool-allowlist.md](agent-config/mcp-tool-allowlist.md) and the connector profiles.

Treat this folder as the canonical source for the 2026-08-10 local candidate. Keep the 2026-07-28 formal release and v5/v6 packages unchanged as historical evidence.

## Accounting Agent Skill inventory

1. `accounting-workflow-coordinator`
2. `accounting-material-intake`
3. `expense-reconciliation`
4. `ap-reconciliation`
5. `ar-reconciliation`
6. `cash-reconciliation`
7. `prepare-balanced-accounting-entry`
8. `execute-approved-accounting-entry`
9. `close-readiness-handoff`
10. `accounting-follow-up-drafting`
11. `finalize-management-close`

## Validation

Run:

```text
python3 scripts/validate_double_entry_candidate.py
```

The validator checks the Skill contract, representative balanced/blocked accounting cases, connector capability/degradation cases, canonical capability IDs, complete ordinary-read mappings for the declared Xero and QuickBooks profiles, nine target/provenance regressions, mandatory Skill-first natural-language routing, no-connector/Drive-only unsaved-proposal degradation, synthetic-company leakage, and byte-for-byte deploy-package parity.
