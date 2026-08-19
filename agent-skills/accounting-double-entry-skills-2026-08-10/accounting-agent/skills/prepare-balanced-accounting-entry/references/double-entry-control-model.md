# Double-entry control model

## 1. State model

Keep these states independent:

| State | Meaning | Does not prove |
|---|---|---|
| Source recorded | A source document or business event was preserved | Accounting treatment |
| Balanced proposal | Proposed debits equal proposed credits | Correct accounts, posting, reconciliation, or close |
| Posted and read back | The formal accounting system returned an ID and exact read-back of a ledger-effective state | Independent reconciliation or close |
| Reconciled | Ledger activity was compared with the relevant independent record or subledger | Period close |
| Closed | Required reconciliations, adjustments, review, approval, period lock, and independent locked-status read-back completed | Statutory filing, audit, or assurance unless separately evidenced |

Do not use a review register as a general ledger. Do not use an entry batch control as a formal-ledger Trial Balance. Treat a provider `DRAFT` or preparation receipt as unposted unless that formal system explicitly defines the state as ledger-effective and the exact read-back confirms it. A source/work-store receipt proves only its own storage action.

## 2. Debit and credit direction

Use the economic event and account type, not the words `money in` or `money out`:

| Account family | Increase normally recorded as | Decrease normally recorded as |
|---|---|---|
| Asset | Debit | Credit |
| Liability | Credit | Debit |
| Equity | Credit | Debit |
| Revenue/income | Credit | Debit |
| Expense | Debit | Credit |

Treat contra accounts, tax accounts, foreign exchange, accumulated depreciation, retained earnings, and other specialist accounts according to the live Chart of Accounts and approved policy.

## 3. Choose the accounting route first

Prefer native accounting-system transactions for routine operational events because formal accounting systems generate the underlying double-entry journals from approved bills, invoices, payments, expenses, and bank transactions. Xero and QuickBooks are examples, not Skill dependencies.

Use a manual-journal candidate sparingly for events such as:

- accruals and reversals;
- prepayment or deferred-income adjustments;
- depreciation and amortization;
- supported reclassification or correcting entries;
- approved allocations that have no more appropriate native transaction.

Do not force routine AP/AR/payment activity through a manual journal when doing so would bypass supplier/customer subledgers, tax behavior, payment allocation, or provider controls.

## 4. Illustrative patterns

Treat every pattern as an account-family example. Bind final accounts, codes, tax treatment, dates, contacts, and dimensions to the current accounting file.

### Supplier bill and later payment

Recognition of a supported bill, ignoring tax only when tax is confirmed not applicable:

- Debit: expense, inventory, prepayment, or asset account.
- Credit: accounts payable.

Later payment:

- Debit: accounts payable.
- Credit: bank.

Do not debit the expense again at payment if the bill already recognized it.

### Customer invoice and later receipt

Recognition of a supported invoice, ignoring tax only when tax is confirmed not applicable:

- Debit: accounts receivable.
- Credit: revenue or other supported income account.

Later receipt:

- Debit: bank.
- Credit: accounts receivable.

Keep partial receipts, approved discounts, credit notes, overpayments, refunds, and customer deposits separate and source-backed.

### Bank service fee

When the bank account, amount, date, business ownership, and classification are supported:

- Debit: bank-fee expense.
- Credit: bank.

If the fee classification or account mapping is unconfirmed, keep it as a candidate instead of using an invented account code.

### Loan, owner funding, and bank transfer

- Loan proceeds: debit bank; credit loan liability. Do not call it revenue.
- Owner/shareholder funding: debit bank; credit the supported equity or shareholder balance account. Do not call it revenue.
- Transfer between company bank accounts: debit destination bank; credit source bank. Do not create income or expense.

### Compound and tax-bearing entry

Permit more than two lines. For a tax-bearing supplier bill, the candidate may debit a net expense/asset account and a recoverable-tax account, then credit AP for the gross amount. Use this split only when the invoice basis, tax jurisdiction, tax code, registration/eligibility, and rounding are supported.

## 5. Month-end meaning

Apply the following controls separately:

1. **Entry balance:** every posted entry has equal debits and credits.
2. **Trial Balance:** the formal ledger's debit balances equal its credit balances at the reporting date.
3. **Reconciliation:** bank/credit-card statements, AP and AR subledgers, loans, tax, payroll, fixed assets, intercompany, inventory, and other in-scope balances agree to independent support or have explained reconciling items.
4. **Adjustments and cut-off:** missing entries, accruals, prepayments, depreciation, foreign exchange, tax, errors, and period cut-off are reviewed and posted where applicable.
5. **Close:** financial statements and exceptions are reviewed and authorized, the period is locked through the formal system, and a separate status read-back confirms that exact entity and period is locked.

A balanced Trial Balance is necessary but not sufficient. It can still contain omitted transactions, duplicates, wrong accounts, wrong periods, reversed treatments, or offsetting errors. Do not make accounts zero merely to make a period look closed, and do not treat ordinary non-zero asset, liability, equity, revenue, or expense balances as an imbalance.

For bank reconciliation, compare the book balance with the statement balance for the same account, currency, and date. Explain deposits in transit and outstanding payments separately; post book-side omissions or errors through supported entries. Require adjusted bank balance to equal adjusted book balance before calling that account reconciled.

## 6. Authoritative references

- Singapore Companies Act 1967, sections 199 and 201: accounting records must explain transactions and financial position and support true and fair financial statements: https://sso.agc.gov.sg/Act/COA1967?ProvIds=pr199-%2Cpr200-%2Cpr201-
- IFRS Conceptual Framework: financial statements recognize assets, liabilities, equity, income, and expenses: https://www.ifrs.org/issued-standards/list-of-standards/conceptual-framework/
- Xero Journal report: approved business transactions create double-entry postings in the general ledger: https://central.xero.com/s/article/Journal-report
- Xero manual journals: a manual journal needs two or more lines and total debits must equal total credits before posting: https://central.xero.com/s/article/Add-import-and-post-manual-journals-US
- Xero bank reconciliation: compare accounting records with bank statements and explain reconciling items: https://www.xero.com/us/glossary/what-is-bank-reconciliation/
- QuickBooks journal entries: total debits must equal total credits: https://quickbooks.intuit.com/learn-support/en-us/help-article/accounting-bookkeeping/create-journal-entry-quickbooks-online/L6Bzy9mT9_US_en_US
- QuickBooks month-end close: review, reconcile, adjust, report, and finalize monthly activity: https://quickbooks.intuit.com/r/bookkeeping/month-end-close/
