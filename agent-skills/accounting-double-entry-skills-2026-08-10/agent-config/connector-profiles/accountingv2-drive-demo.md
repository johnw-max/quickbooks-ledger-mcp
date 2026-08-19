# Connector profile: accountingV2 + Google Drive Demo

## Roles

- `source_store`
- `work_store`

This profile preserves source materials, cases/work scopes, review records, reconciliation candidates, review items, and handoffs. Google Drive is a source/audit store and presentation surface, not a formal accounting ledger.

Each read used as evidence must retain its source/work target, capability, audit/tool reference, observation time, query bounds/completeness, output hash, and field/source bindings. Even a complete source/work receipt cannot establish the current formal-ledger organisation or base currency.

## Capability mapping

Apply each mapping only when that exact tool is mounted and authorized:

| Tool | Capability ID | Supported object types | Control requirement |
|---|---|---|---|
| `list_google_drive_files` | `source.metadata.read` | Drive file/folder metadata | Bounded authorized query; no body-read claim |
| `read_google_drive_file` | `source.content.read` | Google Docs and supported text-like files | Exact file reference; PDF body extraction is unsupported |
| `read_google_drive_file` | `work.proposal.readback` | Text-like proposal artifact | Exact returned file ID and supported MIME only |
| `upload_google_drive_file_auto` | `source.original.preserve` | Original binary only when the channel exposes complete bytes | Preserve upload receipt separately; this is not material registration or original-byte read-back |
| `create_google_drive_text_file` | `work.proposal.persist` | Explicitly requested text proposal/handoff artifact | Never treat as source-original preservation or ledger write |
| `upsert_accounting_case` | `work.scope.resolve` | Accounting case/work scope | Tenant/workspace binding and returned case receipt |
| `ingest_source_material` | `work.material.persist` | Source-material registration | Registration receipt is separate from Drive upload receipt |
| `upsert_accounting_record` | `work.review_record.persist` | Review-stage accounting record | Candidate/review semantics only |
| `search_accounting_records` | `work.review_record.search` | Review-stage accounting records | Bounded current-scope query |
| `upsert_reconciliation_link` | `work.reconciliation_candidate.persist` | Candidate match/link | Never map to formal reconciliation verification |
| `list_reconciliation_links` | `work.reconciliation_candidate.read` | Candidate match/link | Review-stage result only |
| `upsert_review_item` | `work.open_item.persist` | Review/open item | Does not assign or resolve without receipt |
| `list_review_items` | `work.open_item.read` | Review/open item | Bounded current-scope query |
| `add_expense` | `work.review_record.persist` | Expense candidate | Not a formal expense/subledger posting |
| `list_expenses`, `query_expense_summary` | `work.review_record.search` | Expense candidates/summary | Work-store view only |

`create_google_drive_folder` is a provider storage primitive and has no standalone accounting capability ID. `move_google_drive_file`, raw/chunk upload tools, destructive actions, saved views, and cancel actions are not mapped by this profile.

The historical 2026-07-28 signed-in synthetic UAT tool names and receipts remain preserved in `formal-accounting-release-2026-07-28/agent-config/mcp-tool-allowlist.md`. They are deployment evidence, not Skill policy.

## Maximum state

- materials or proposal artifacts may be saved and read back;
- balanced accounting proposals may be preserved as work products;
- no mounted capability in this profile proves live Chart of Accounts/tax/period, formal transaction posting, ledger read-back, Trial Balance, formal reconciliation, or period lock.

Maximum accounting outcome: `PROPOSAL_SAVED_OUTSIDE_LEDGER`, and only when the exact persistence receipt exists. PDF upload, text-file creation, material registration, and content read are separate outcomes.
