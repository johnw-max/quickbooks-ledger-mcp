# Online Agent UAT results

## Current verdict

IN PROGRESS — Work host OAuth, Agent MCP mounting, live read-only tools, and controlled Sandbox write prerequisites are verified. The 14-document mutation chain is not yet accepted.

## Verified preflight

- Work MCP status: Connected.
- Agent: `QuickBooks 会计助手 UAT` (`agent_PDFaOu-_2bd-vRDVHmDYY`).
- Model: `deepseek/deepseek-v4-pro`.
- Runtime: QuickBooks MCP 0.6.0, 18-tool Accounting Case surface.
- Target: exact Sandbox Company allowlist.
- Write controls: enabled only for Customer, Vendor, Invoice, Bill, CreditMemo and VendorCredit; standing delegation active at revision 1.
- Persistence/readiness: ready; migrations through 034; no legacy compiler rows.
- T01 live result: four real QuickBooks MCP calls succeeded and returned Sandbox Company US c694, USD, multi-currency disabled, and two active sales tax groups. No write occurred.

## Claim boundary

Nothing in this file yet proves the 14-document write/read-back/idempotency journey. Final verdict remains pending the rest of the live conversation.

