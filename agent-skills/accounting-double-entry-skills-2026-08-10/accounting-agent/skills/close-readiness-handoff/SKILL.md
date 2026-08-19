---
name: close-readiness-handoff
description: Prepare month-end accounting status, double-entry control summaries, close-readiness drafts, boss-facing summaries, accountant handoff notes, blocker lists, and review queues from visible or authorized accounting materials. Use when the user asks for month-end status, whether the books balance, Trial Balance or reconciliation readiness, close package draft, handoff, boss update, open issues, or review summary. Produces drafts only without claiming close completion, posting, execution, or formal sign-off.
---

# Close Readiness Handoff

## Business Rules

- Work only from facts visible in the current conversation or returned by a mounted capability for the authorized entity, period, or work scope; preserve material uncertainty.
- Treat any entity/company name from user text, remembered conversation, or an example as `USER_ASSERTED`: it is a request label, not proof of the authorized ledger target. Ledger-scoped facts or actions require current matching `HOST_BOUND` or `MCP_READ` evidence; otherwise mark the ledger target unverified, do not fill it from memory, and do not merge conflicting targets.
- Enforce the evidence contract for the destination role. Treat a bare `ledger_sor` payload such as `{result: ...}` as `READ_EVIDENCE_REJECTED`: it cannot prove the current organisation, base currency, accounts, tax, balances, transactions, reports, posting, reconciliation, or close. A source- or work-store read may support only the material or review object identified by its own authorized receipt; it never proves a ledger fact. Continue from user-visible facts only at the highest non-ledger state they support.
- Keep saved records, matches, review items, and handoff notes at review stage until authorized finance evidence confirms a formal outcome.
- Report only business changes that were actually completed. If an action is incomplete, state what was preserved and what still needs attention.
- Use ordinary accounting language. Do not turn a review-stage record into a claim that an item was posted, approved, paid, collected, cleared, written off, or closed.

## Close and Handoff Summary

- Build the summary from the current authorized entity/period facts and visible supporting materials.
- Separate organized materials, reviewable matches, open review items, and the next evidence required.
- Do not describe the period as ready to close while material review items remain unresolved.
- Treat any saved handoff as a review-stage note, not formal close approval.
- If the user asks only for a summary, produce a draft. Preserve it through a work-store capability only when the user asks to save or hand it off.
- When retrieving review items, records, or matches, send only confirmed authorized-scope identifiers and the minimum filter needed for the request. Leave optional fields absent rather than inventing issue types, assignees, linked IDs, views, or worksheet settings. A failed, over-filtered, or ambiguous list result does not prove there are zero open items; describe system visibility as unconfirmed and continue only from visible evidence.


Turn visible review work into a calm close/status/handoff draft.

## Procedure

1. Separate source groups: AP/payables items, employee or company expenses, AR/receivables evidence, bank/cash lines, ledger/category candidates, and unresolved items.
2. Summarize what is organized, what remains missing, what conflicts, and who should review or answer.
3. Keep variance/source hierarchy visible when numbers differ across ERP export, bank statement, spreadsheet, manual table, or remittance note.
4. State the visible source basis used, such as status packet, bank statement, supplier statement, invoice list, AP register, or user note.
5. If newer visible material or a user correction supersedes an earlier fact, say which field changed and do not reuse the older value in the close summary except as conflict history.
6. Treat returned, reversed, failed, voided, pending, or retry payment evidence as close blockers or review items, not paid or complete evidence.
7. Treat pending credit notes and unapplied/unknown cash as allocation review items, not settled offsets.
8. Prepare boss-facing status only with safe wording: main progress, key blockers, review owners, and next date/action.
9. Prepare accountant handoff notes as copyable drafts; save them through an available work-store capability only when the user asks.
10. If the user asks for a draft, says `别发`, `不要发送`, or asks for wording to send later, start the answer or the draft section with `以下只是草稿，我不会发送。`
11. Keep month-end tables at review status level, but make labels natural. Use phrases such as `金额和对象能对应上`, `只对上了一部分`, `还要确认`, `还缺材料`, `这笔付款后来被退回`, `等财务分类`, or `现在不能下结论`; do not convert these into final close, posting, reimbursement, AR clearing, or AP paid conclusions.
12. When useful, include a single-case review queue draft: item, reason, owner/reviewer, needed input, needed-by date if visible, source labels, severity, and recommended next reviewer question.

## Double-entry and close controls

- Separate entry balance, formal-ledger Trial Balance, reconciliation, and close approval. Report each status independently.
- Treat equal debits and credits for each proposed or posted entry as a necessary arithmetic control, not proof that the accounts, tax, period, completeness, or business treatment are correct.
- Call a Trial Balance balanced only from the formal accounting system's report for the exact entity, currency basis, and reporting date. A balanced proposal batch or review register is not a Trial Balance.
- Require authoritative posting and exact read-back before treating adjustments as part of the books. Draft entries and review records do not change the Trial Balance.
- Assess in-scope bank/credit-card reconciliations, AP and AR subledger-to-control-account agreement, loans, tax, payroll, fixed assets, intercompany, inventory, accruals, prepayments, depreciation, foreign exchange, cut-off, duplicates, unusual balances, and suspense/clearing items according to the client's scope.
- Treat a balanced Trial Balance as insufficient for close while omissions, duplicates, wrong accounts, wrong periods, reversed entries, offsetting errors, unexplained reconciling items, or unresolved blockers may remain.
- Require financial-statement review, authorized close approval, formal-ledger period lock, and an independent locked-status read-back for the exact entity and period before calling a period closed. Do not interpret close as every ledger account being zero.
- If Trial Balance, reconciliation, or period-lock capabilities are not mounted, still prepare a bounded close-readiness draft from visible evidence, but mark the corresponding system verification as unavailable. Missing system capability can never be converted into a positive close result.

## Boundaries

- Do not say close complete, greenlight, immaterial, minor issue, small tail item, ready to close, posted, approved, tax-filed, audited, or reviewed by finance unless visible authorized reviewer evidence supports it.
- Do not write boss/accountant summaries that say `完美对齐`, `可冲销`, `可直接入账`, `报销驳回`, `无需重复付款`, or `异常已处理` unless visible authorized finance/system evidence supports that exact conclusion. Rephrase as review findings and missing evidence.
- Do not use final-looking output/table statuses such as `√ 匹配成功`, `完全匹配`, `完全对齐`, `已入账`, `已核销`, `销账完毕`, `未入账`, `需补记账`, `补提日记账`, `内控异常`, `红旗风险`, `不可支付`, or `补齐前不可支付`. Use natural review language such as `银行流水有对应记录，是否核销待财务确认`, `这项看起来是手续费，等财务分类`, `审批还没看到`, or `补齐材料后再复核`.
- Do not prepare close status from a filename, upload claim, unrelated work scope, or remembered example. If the close packet or underlying AP/AR/cash/expense details are unavailable both in the conversation and authorized mounted results, ask for the packet or pasted summary.
- Filename-only gate: when only filenames exist and no authorized mounted result provides readable content, do not infer close status, blockers, pass/fail judgment, or a boss-ready summary.
- If the user asks to pass month-end despite missing support, do not provide conditional greenlight wording such as `如无异常即可关账`, `无其他问题可推进`, or `继续按计划关账`. Draft the status as blocked or review-pending until the named evidence is supplied.
- Do not produce final or posted journal entries in this summary Skill. Route accounting treatment to `prepare-balanced-accounting-entry` and an explicitly approved execution request to `execute-approved-accounting-entry`; require separate formal-ledger evidence for posting.
- Do not turn prior AI/bookkeeper/team conclusions into evidence. Rebuild from visible source materials.
- Do not hide, delete, omit, or replace exceptions to make the status look cleaner.
- Treat bank fees, category candidates, and ledger/category suggestions as classification review items only. Do not tell the user to book, post, record, charge, classify to a specific account, or include them as final close treatment.
- Do not say or imply that a draft will be sent, scheduled, assigned, or handed off. Avoid phrases like `拟于今日发给...` unless the user explicitly asks for a proposed plan, and even then make clear it is only suggested wording.
- Review queues and handoff summaries remain draft outputs for the current entity and period. Do not describe them as formal accounting updates or close approval.
- `Ready for accountant review` means review can start from visible materials; it never means ready to close, close complete, posted, approved, signed off, or controller-approved.
- Use ordinary business language in user-facing answers. When evidence helps, mention the visible file name or document label.

## Output Shape

Use the audience's language:

- Boss: short status, blockers, decision needed.
- Accountant: itemized open issues, source refs, owner questions.
- Team handoff: included items, excluded/blocked items, next actions.

Default to a short status update, not a full close memo. For running-material chats, summarize with a compact review register using natural labels like `能对应上`, `待确认`, and `现在不能下结论` before any prose. Avoid `已对上` if it could read as final reconciliation, and do not call the review register a general ledger.

Prefer `已完成主要整理`, `待财务复核`, `关键待确认事项`, and `确认后再判断是否可关账` when unresolved risks remain.
For compact review registers, use status values that preserve uncertainty in plain Chinese: `金额和对象能对应上`, `只收到一部分`, `付款退回还要查`, `可能重复报销，先确认付款来源`, `这笔入账性质还没确认`, and `等财务分类`. Add the smallest next action beside each item.
Use simplified Chinese consistently when the user writes simplified Chinese. Avoid raw HTML in tables or bullets. Avoid repeated closing offers such as `如果你愿意，我下一条可以...`; provide the next decision or owner directly.
