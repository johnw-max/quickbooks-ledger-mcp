---
name: quickbooks-accountant
description: Orchestrate accountant-led document intake, analysis, preparation, execution, and verification through the QuickBooks Ledger MCP. Use for multi-document QuickBooks work that must preserve source coverage, stage contacts before documents, keep unsupported cash or FX actions explicit, and require Provider receipts plus exact read-back before claiming completion.
---

# QuickBooks Accountant

Use the QuickBooks MCP as the ledger boundary. Do not duplicate its validation,
authorization, idempotency, tax, receipt, or recovery logic in prose.

## Operating rules

- Use only the QuickBooks MCP for QuickBooks ledger work. Xero labels on source
  documents do not select a Xero connector.
- Resolve the current connection and exact Company before reading or preparing.
  Treat Drive, database, chat attachments, and Client Intake as source-material
  layers; QuickBooks remains the system of record.
- Never infer that a document issuer matches the bound Company. Require explicit
  mapping evidence. Honor an explicit synthetic-UAT mapping only inside that UAT.
- Preserve one disposition for every source unit. Evidence-only and unsupported
  events remain in the audit trail; they are not ignored.
- Treat `PREPARED` as a local immutable plan, never as a QuickBooks write.
- Call an operation written only when Provider Id, authorization receipt,
  Provider receipt, and exact read-back are all verified.

## Build the Cases

1. Read the full supplied set and apply later user corrections to the complete
   working fact set. Preserve source-versus-user revision lineage.
2. When the user authorizes saving the plan, prepare a separate zero-operation
   residual Case for evidence-only and unsupported events; query its status and
   never execute it.
   - Use the business intake shape: `source_key`, `label`, then `units` containing
     `unit_key` and one or more business `facts`.
   - Supply typed `UNSUPPORTED_EVENT`, `EVIDENCE`, or `CONTROL_FINDING` facts for
     every residual unit. Zero Provider operations does not mean zero facts.
   - Do not manufacture `factId`, lineage, revision, internal source links,
     Provider ids, source hashes, or attestations. The MCP derives internal ids;
     the Host may add verified original-file identity in a later integration.
3. Prepare the supported Case version 1 with only absent Customer and Vendor
   records required by released downstream documents.
4. Execute version 1 only when the user asks to write. Require exact read-back.
5. Re-resolve the exact contact ids, then prepare version 2 with Invoice, Bill,
   CreditMemo, and VendorCredit.
6. Execute version 2 only when requested. Query status and verify every receipt.
7. On replay, reuse the same Case, version, and request id. Never create a new
   Case to simulate idempotency.
8. In each document line, `source_tax_amount` is a numeric amount such as
   `72.00`; put the QuickBooks tax-code name only in `tax_code_name`.

## Classify conservatively

- A released Invoice or Bill may be staged even when its Payment or BillPayment
  is unsupported. Keep the settlement and resulting open-balance mismatch as an
  explicit residual; never claim cash, reconciliation, or the whole chain is
  complete.
- Do not create standalone master data solely for a downstream event that is
  blocked in the current release.
- Do not compile a document that requires approval until explicit approval
  evidence is present.
- Treat a foreign-currency Bill as blocked when the current typed Case cannot
  preserve the user-confirmed exchange rate. Do not let QuickBooks silently
  select a different rate.
- Never replace unsupported Payment, BillPayment, prepayment, bank fee, opening
  balance, ExpenseClaim, or FX settlement with JournalEntry or arbitrary JSON.
- If a write outcome is unknown, query Case status. Follow exact-id read-back
  recovery only; never repeat the Provider POST.

## Report honestly

- Separate released capability, prepared plan, verified Provider write, and
  whole-business completeness.
- Report every residual blocker with the source units it covers and the next
  safe action. Evidence-only does not mean discarded.
- Before a final write audit or 14-source completion report, call Case status
  for every supported version and the residual Case in that same turn. Do not
  rely on conversational memory as receipt evidence.
- Do not call a Sandbox UAT production posting, close, reconciliation, or tax
  filing proof.
