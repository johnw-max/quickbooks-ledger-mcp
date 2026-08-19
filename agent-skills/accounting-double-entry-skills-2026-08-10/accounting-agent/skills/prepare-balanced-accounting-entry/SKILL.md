---
name: prepare-balanced-accounting-entry
description: Prepare connector-neutral, evidence-bound double-entry proposals with balanced debit and credit lines. Use whenever the user asks for 复式记账、复式分录、复式分录草案、会计分录、会计分录草案、借贷分录、借方/贷方、计提或预提、冲销、折旧、摊销、如何记账, a journal entry, accounting impact, posting proposal, or batch balance check. Keep account and tax mapping reviewable and never claim storage, posting, reconciliation, or close without authoritative evidence.
---

# Prepare Balanced Accounting Entry

Prepare a reviewable accounting-entry proposal. Do not post it or present it as the general ledger. Route an explicit request to execute an approved proposal to `execute-approved-accounting-entry`.

Treat any entity/company name from user text, remembered conversation, or an example as `USER_ASSERTED`: it is a request label, not proof of the authorized ledger target. Ledger-scoped facts or actions require current matching `HOST_BOUND` or `MCP_READ` evidence; otherwise mark the ledger target unverified, do not fill it from memory, and do not merge conflicting targets.

Enforce the evidence contract for the destination role. Treat a bare `ledger_sor` payload such as `{result: ...}` as `READ_EVIDENCE_REJECTED`: it cannot prove the current organisation, base currency, accounts, tax, balances, transactions, reports, posting, reconciliation, or close. A source- or work-store read may support only the material or review object identified by its own authorized receipt; it never proves a ledger fact. Continue from user-visible facts only at the highest non-ledger state they support.

## Separate the accounting layers

- Treat a receipt, invoice, bank line, contract, spreadsheet row, or review-register row as a `source record`, not as a journal entry.
- Treat the output of this Skill as a `balanced proposal` only.
- Call an item `posted` only after an authorized formal-ledger connector returns a record ID or journal reference and an exact read-back confirms the same entity, period, amount, currency, and a system state that actually affects the general ledger or reports. A non-effective provider `DRAFT`, preparation receipt, source/work-store receipt, or saved proposal is not posted.
- Keep `balanced`, `posted`, `reconciled`, and `closed` as separate conclusions. Never upgrade one into another.

## Procedure

1. Keep the requested entity label separate from the host-authorized accounting file. Resolve the latter, its base currency, and its binding revision only from current matching host/MCP evidence when the proposal uses current-ledger facts or mappings. With no verified ledger capability, continue from user-visible facts at the unsaved, unmapped proposal state; mark the accounting file, base currency, account/tax codes, and any ledger-scoped field unverified rather than inventing them. Missing or conflicting ledger evidence blocks ledger mapping and execution, not a category-level balanced proposal outside the ledger.
2. Identify the economic event and recognition point. Keep a supplier bill separate from its later payment, and a customer invoice separate from its later receipt.
3. Select the proposed business route before writing lines; do not branch the accounting treatment by connector brand:
   - prefer a native bill, invoice, payment, expense, spend/receive-money, credit-note, transfer, or other formal-accounting transaction when that route represents the event;
   - use a manual-journal candidate only for adjustments, accruals, prepayments, depreciation, reclassifications, corrections, or accountant-directed cases that are not better represented by a native transaction.
4. Bind account names/codes, tax codes, tracking dimensions, contacts, base currency, and period status to current authorized formal-ledger data when available. If the live Chart of Accounts or tax treatment is unavailable, use an account-family candidate and mark `account mapping required`; do not invent a code.
5. Build one entry header and two or more entry lines. For each line include account or account-family candidate, debit or credit amount, currency/base-currency amount when relevant, tax treatment or unresolved tax flag, description, tracking/contact when supported, and source reference.
6. Calculate total debits, total credits, and the difference in the accounting file's base currency using its currency precision. Mark the proposal balanced only when the difference is exactly zero after approved currency rounding.
7. Run the controls below. If any hard control fails, return a blocked proposal and name the smallest evidence or mapping needed.
8. Present the proposal, evidence basis, assumptions, unresolved items, and the next approval/capability gate in ordinary accounting language.
9. State the required destination role and semantic capability separately from any installed tool name. With no connector, keep the proposal in chat; with source/work storage, save it only when requested and label it outside the ledger; use `execute-approved-accounting-entry` for an authorized formal-ledger action.

## Hard controls

- Require at least two lines. Permit compound entries with multiple debit and/or credit lines.
- Put a positive amount on exactly one side of each line. Never place values on both debit and credit for the same line.
- Require total debits to equal total credits for each entry and for any proposed batch control.
- Never use an unexplained plug, `other expense`, `miscellaneous income`, retained earnings, or suspense/clearing line merely to force equality. Use suspense or clearing only when an authorized accounting policy explicitly permits it and capture the reason, owner, approval, and resolution deadline as an open item.
- Do not equate a bank statement's `debit/credit` label with the ledger side. First map whether cash increased or decreased; for example, a bank-statement debit that reduces cash normally maps to a credit to the bank ledger account.
- Do not infer that debit means money in or credit means money out. Determine the side from the account type and economic event.
- Do not turn unknown incoming cash into revenue, a loan into revenue, owner funding into revenue, an inter-account transfer into income/expense, or an asset purchase into current-period expense without supported accounting treatment.
- Do not double count. When a bill or invoice already recognized AP/AR, record the later cash event against AP/AR rather than recognizing the expense or revenue again.
- Do not finalize tax, foreign-exchange, fixed-asset, payroll, inventory, intercompany, impairment, write-off, or equity treatment from incomplete facts. Keep the affected line or proposal blocked for accountant review.
- Treat duplicate source references or materially identical source fingerprints as a possible repeat. Do not prepare a second posting proposal until the duplicate is resolved.
- Correct a posted item through the formal system's supported reversal, credit note, or correcting-entry workflow. Never silently overwrite historical accounting evidence.
- Never claim that a balanced proposal changed the ledger, Trial Balance, financial statements, bank reconciliation, AP/AR balance, or close status.

## Output shape

Lead with one status: `平衡分录草案`, `分录草案待补信息`, or `无法形成分录草案`.

Then show:

1. entity/file, period, transaction date, source references, currency, and proposed accounting route;
2. one line table with `科目/科目类别`, `借方`, `贷方`, `税务/维度`, `说明`, and `依据`;
3. total debit, total credit, difference, and balance result;
4. assumptions and unresolved account/tax/period/evidence items;
5. destination role and next gate: accountant review, live Chart-of-Accounts mapping, proposal persistence, human approval, controlled formal-ledger execution, or exact read-back.

For several economic events, create a separate entry proposal for each event and show a batch debit/credit control afterward. Do not call a draft batch control a Trial Balance; a Trial Balance must come from the formal ledger after posting.

Use [references/double-entry-control-model.md](references/double-entry-control-model.md) for account-direction guidance, accounting-route selection, examples, and month-end interpretation.
