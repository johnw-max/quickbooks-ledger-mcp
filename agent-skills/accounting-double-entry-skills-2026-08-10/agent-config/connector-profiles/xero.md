# Connector profile: Xero formal ledger

## Role

- `ledger_sor`

Map only mounted tools after the platform verifies the connection, tenant binding, scopes, permission, object support, and current write gate:

| Tool | Capability ID | Supported object types | Control requirement |
|---|---|---|---|
| `xero_connection_status` | `connector.connection.status.read` | `connector_control_plane`: connection health and bound-connection display | Server-resolved connection; never target proof by itself |
| `xero_get_organisation` | `ledger.target.resolve` | Xero organisation | Bound tenant, `xero.read` |
| `xero_list_accounts` | `ledger.reference.accounts.read` | Account | Bound tenant, `xero.read` |
| `xero_list_tax_rates` | `ledger.reference.tax.read` | Tax rate | Bound tenant, `xero.read` |
| `xero_list_contacts`, `xero_get_contact`, `xero_search_contacts` | `ledger.reference.counterparty.read` | Contact | Bound tenant, `xero.read` |
| `xero_list_invoices`, `xero_list_credit_notes`, `xero_list_payments`, `xero_list_bank_transactions`, `xero_list_manual_journals`, `xero_list_quotes`, `xero_list_purchase_orders` | `ledger.transaction.search` | Invoice/Bill, CreditNote, Payment, BankTransaction, ManualJournal, Quote, PurchaseOrder | Bounded read |
| `xero_get_invoice`, `xero_get_supplier_bill`, `xero_get_bank_transaction`, `xero_get_manual_journal`, `xero_get_quote`, `xero_get_purchase_order` | `ledger.object.read_exact` | Exact returned accounting object | Exact provider object ID |
| `xero_list_items`, `xero_get_item` | `ledger.reference.item.read` | Item | Bounded list or exact provider object ID |
| `xero_prepare_supplier_bill_draft`, `xero_prepare_sales_invoice_draft`, `xero_prepare_credit_note_draft` | `ledger.transaction.native.prepare` | Bill, Invoice, CreditNote | Review-stage preparation only |
| `xero_create_draft_supplier_bill`, `xero_create_draft_sales_invoice`, `xero_create_credit_note_draft` | `ledger.transaction.native.execute` | Bill, Invoice, CreditNote in `DRAFT` | Explicit confirmation, tenant/scope/write gate, idempotency; ledger-effective=false |
| `xero_prepare_manual_journal_draft` | `ledger.transaction.journal.prepare` | ManualJournal | Balanced review-stage preparation |
| `xero_create_manual_journal_draft` | `ledger.transaction.journal.execute` | ManualJournal in `DRAFT` | Explicit confirmation, tenant/scope/write gate, idempotency; ledger-effective=false |
| `xero_get_trial_balance` | `ledger.report.trial_balance.read` | Trial Balance | Exact tenant/date/basis; report bounds retained |

`xero_connection_status` is connection health, not a verified ledger target or accounting outcome. Contact/item/quote/purchase-order mutation tools are outside this candidate's accounting-entry execution route unless a later profile maps and validates them explicitly.

## Provider semantics

- Prefer native bill, invoice, payment, credit-note, bank-transaction, and transfer objects for routine activity.
- Treat Xero `DRAFT` as unposted for this profile. It is always `PROVIDER_DRAFT_UNPOSTED`, never `POSTED_READBACK_VERIFIED`.
- Bind every capability to the authorized tenant; never accept a tenant replacement from user text.
- Before exposing current organisation, currency, accounts, contacts, transactions, or reports as business facts, return the normalized target/provenance envelope in the capability contract. Every later read must match the target reference and binding revision returned by `xero_get_organisation`; otherwise stop at `TARGET_UNVERIFIED`, `TARGET_CONFLICT`, or `READ_EVIDENCE_REJECTED`.

## Current evidence boundary

The local Xero codebase contains live reference reads, controlled balanced Manual Journal DRAFT preparation/creation, exact-ID read-back controls, and bounded Trial Balance reads. That code is not automatically mounted by this Skill package. The latest 2026-08-09 online UAT recorded reads only; an older controlled Supplier Bill AUTHORISED test is not proof of a general journal or month-end close route.

The Xero MCP used in the 2026-08-10 isolated online UAT still returned bare ordinary-read payloads and therefore did not meet this candidate's normalized provenance contract. A local source patch now returns a backward-compatible envelope with a persisted audit reference, safe target and binding references, observation time, capability revision, query bounds/completeness, output hash, and fact paths; local type checks, all default and required HTTP/PostgreSQL test gates, and the production build pass. That patch has not been deployed or re-tested through the live MCP. Until deployment and a clean isolated online regression, this profile is not plug-and-play live-ready.

The currently mapped write tools can reach only `PROVIDER_DRAFT_UNPOSTED`. No mapped tool in this profile proves an effective post, formal reconciliation, or period lock.
