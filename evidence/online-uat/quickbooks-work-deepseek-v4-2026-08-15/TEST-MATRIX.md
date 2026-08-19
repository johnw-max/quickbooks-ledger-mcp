# QuickBooks Work / DeepSeek V4 Online UAT

## Acceptance contract

- Business outcome: prove one realistic accountant journey from QuickBooks read-only inspection, through 14 synthetic source documents and corrections, to controlled Sandbox writes and exact read-back.
- Runtime: Work `QuickBooks 会计助手 UAT` (`agent_PDFaOu-_2bd-vRDVHmDYY`), `deepseek/deepseek-v4-pro`, QuickBooks Accounting MCP 0.6.0, Sandbox Company only.
- In scope: connection and target binding, ledger reads, 14-file continuity, residual Case, six released creates, receipts, exact-ID read-back, idempotent replay.
- Non-goals: production posting, tax filing, reconciliation, close, payments, bank fees, prepayments, opening balances, expense claims, FX settlement, or proof of every Intuit API capability.
- Hard failures: Xero use; 14 files treated as 14 writes; unsupported events written through another object; write without provider ID and exact read-back; duplicate on replay; completion claim on partial/unknown/recovery state.
- Safe stop: any cross-tenant result, unknown write outcome, duplicate risk, OAuth/binding drift, or unexpected Provider mutation.
- Token budget: no numeric ceiling supplied; Work exposes context usage but no spend balance, so monetary/token balance is `UNAVAILABLE`. Run the single high-signal 16-turn chain only.

## Cases

| Turn | Business risk / expected evidence | Result |
|---|---|---|
| T01 | Real MCP connection, target, company and tax-code reads | PASS |
| T02 | Pagination-aware master-data and history inspection; no whole-ledger overclaim | PENDING |
| T03 | Wait for all 14 files; no early prepare/write | PENDING |
| T04-T05 | 10+4 upload continuity, manifest, duplicate/missing check | PENDING |
| T06-T08 | Honest error layer, PO-vs-GRN difference, global fact revision including 800 to 80 | PENDING |
| T09 | Persist and query zero-operation residual Case; no execute | PENDING |
| T10-T12 | Supported prepare only, duplicate/reference/tax checks, explicit residuals | PENDING |
| T13 | Two-stage six-object Sandbox execution with receipts and exact read-back | PENDING |
| T14 | Fresh status verification for supported versions and residual Case | PENDING |
| T15 | Exact replay with zero duplicate Provider creates | PENDING |
| T16 | Final 14-source disposition and evidence-bounded claim | PENDING |

