---
name: singapore-gst-ledger-mapping
description: Map a reviewed Singapore accounting proposal onto the exact account codes and tax codes of the connected ledger before execution. Use whenever a balanced proposal for a Singapore entity is about to be executed against a formal ledger connector, or whenever GST treatment, account selection, or a GST-inclusive amount must be resolved. Always read the ledger's live accounts and tax rates first and propose only values that exist there; never invent a code, never assume a rate.
---

# Singapore GST ledger mapping

Turn a reviewed accounting proposal into the exact account-coding and tax-code
values the connected ledger will accept, for a Singapore-registered entity. The
literal field names and the shape of that coding are connector-specific — take
them from the connected ledger's live reads and its connector profile, never
from another connector's contract or from memory.

This Skill owns the **accounting judgment**. The ledger connector owns
**verification**: it will independently check that every code you declare exists
in that organisation, that the tax amount equals the ledger's own rate applied to
the net, and that what was written reads back identically. It will refuse
anything it cannot confirm. Your job is to propose values that are correct and
real — not to reassure yourself that they are.

## Procedure

1. **Read before proposing.** Call the accounts and tax-rate reads for the pinned
   organisation (the exact client entity this session is bound to — an
   Organisation in Xero, a Company in QuickBooks, or the equivalent elsewhere).
   Never propose an account code or tax code you have not seen in that
   organisation's live data in this conversation. A code that worked for another
   client does not exist here until you have read it here.
2. **Confirm the entity is Singapore-registered for GST** from the organisation
   read. If it is not GST-registered, no standard-rated output tax applies;
   route to no-tax treatment and say so.
3. **Classify the economic event**, then select tax treatment, then select the
   account. In that order — the account never determines the tax treatment.
4. **Resolve amounts** before writing anything down (see below).
5. **Declare explicitly**: per line, the account or item coding, the tax code,
   quantity, unit amount excluding tax, and the line tax amount; per document,
   the declared net, tax and gross — using the exact field names and coding
   shape the connected ledger's own contract expects, never another connector's.
6. **Stop rather than guess.** If the right account or tax code is genuinely
   ambiguous, present the candidates and ask. An unresolved item is a normal
   accounting outcome; a confidently wrong code is not.

## Establish the document direction first

Before any tax decision, settle whose books you are in and which side of the
document that entity is on. Output tax and input tax are opposite answers to this
one question, and getting it wrong makes every later step wrong in a way that
still looks internally consistent.

The pinned organisation **is** the client whose books you are writing. So:

- If that organisation **issued** the document, it is a customer invoice — the
  counterparty is the customer, and any GST is **output** tax.
- If that organisation **received** the document, it is a supplier bill — the
  counterparty is the supplier, and any GST is **input** tax.

Colleagues rarely say this explicitly. A phrase like "put X's invoice into their
books, made out to Y" names two companies and leaves the direction implicit.
Resolve it against the organisation read rather than by word order:

- If X is the pinned organisation, X issued it → customer invoice, Y is the customer.
- If Y is the pinned organisation, X billed them → supplier bill, X is the supplier.
- **If neither name matches the pinned organisation, stop and ask.** The
  organisation's display name may legitimately differ from the client's trading
  name — say what organisation you are actually connected to and have the
  colleague confirm it before continuing. Never assume you are in the right books
  because the request sounded confident.

A useful cross-check: the tax codes available in the organisation often reveal
the direction you can actually support. If only output-direction codes are
active, an expense line has no valid code — say so rather than forcing one. Some
connectors name or restrict a tax code by direction; others expose a single
named code that is valid on both sides without saying so in its name. Read the
live tax data to find out which is true here — never assume direction from a
code's name, or from what another organisation or connector did.

## GST treatment

Singapore GST is **9%** for supplies made on or after 2024-01-01. Verify the rate
from the ledger's tax-rate read rather than trusting this number — if the
organisation's rate differs, the organisation is right and this Skill is stale.

| Situation | Treatment |
|---|---|
| Ordinary local sale by a GST-registered entity | Standard-rated output |
| Ordinary local purchase with a valid tax invoice | Standard-rated input |
| Export of goods, international services | Zero-rated |
| Financial services, sale/lease of residential property | Exempt |
| Supply outside GST scope, non-business receipts | Out of scope |
| Entity not GST-registered, or no GST on the document | No tax |

Two Singapore-specific points that are easy to get wrong:

- **Exempt supplies split by Regulation 33.** Regulation 33 exempt supplies
  (certain incidental financial services) are treated separately from ordinary
  exempt supplies because they do not restrict input tax recovery the same way.
  If a document involves exempt output, determine which it is; do not merge them.
- **Zero-rated is not exempt.** Both carry 0% tax, but they report differently
  and affect input-tax recovery differently. Export → zero-rated. Residential
  property or financial services → exempt.

Tax-code identity and naming vary by connector. Some connectors encode direction
in the code itself — a distinct code for output and a distinct code for input.
Others use one descriptively-named code that is valid on both sides, or restrict
a code to one side without saying so in its name or label. **Treat any code or
name you recall from memory, another organisation, or a past conversation as a
hint for what to look for, never as truth** — organisations rename and customise
tax codes, and naming conventions differ by connector. Always take the actual
code or name, and its allowed direction, from this organisation's live
tax-rate/tax-code read, and check the connector profile for how that connector
represents direction and applicability.

## Amount resolution

The ledger verifies `line tax == round(net × the ledger's own rate for that tax
code)` to the currency's minor unit, with **zero tolerance**. So resolve amounts
exactly:

- **Tax-exclusive document**: net is given. Tax = net × rate, rounded to the
  minor unit. Gross = net + tax.
- **GST-inclusive document** (common on Singapore retail invoices and receipts):
  net = gross ÷ (1 + rate), rounded to the minor unit; tax = gross − net.
  Worked example at 9%: gross S$1,200.00 → net 1,100.92, tax 99.08.
  Verify net + tax = gross exactly before declaring.
- **Multi-line**: tax is computed and rounded **per line**, then summed. Do not
  compute tax on the document total and distribute it — that produces cent
  differences the connector will reject.
- **Never plug.** If declared totals do not reconcile, that is a finding about
  the source document, not something to force.

## Account selection

Select from the organisation's live chart of accounts — or items, or whichever
posting targets the connector uses on a document line — matching the economic
nature of the item. Connectors differ in how they carve this up: some code every
line to an account; some require sales lines to be coded to an item and reserve
direct account coding for purchase lines; some differ again. Take the exact
posting-target type each line requires, and its exact live name or code, from
the connector's reference reads and its connector profile — not from habit
formed on another connector. Whatever you select must be one that accepts direct
posting.

Sanity checks worth making every time: revenue-side posting targets for customer
invoices and expense-side posting targets for supplier bills, not the reverse;
the tax code's direction must match the document direction (output tax on sales,
input tax on purchases); and the tax code must be applicable to that posting
target's class — the ledger exposes this and will refuse a mismatch.

## QuickBooks specifics

This connector's coding shape, confirmed from the schema the mounted tool
actually validates against — `src/quickbooks/accountingCaseBusinessIntake.ts`.
Submit the **business intake** shape; the server derives its own internal
representation from it. Both schemas are strict, so an unrecognised key is
rejected outright rather than ignored.

- A document line carries `description`, `quantity`, `unit_amount`,
  `source_tax_amount` (the line's declared tax **amount**, for example
  `72.00` — never a tax-code name), `coding_type` (`ITEM` or `ACCOUNT`),
  `coding_name` (the exact live Item or Account name), and `tax_code_name`
  (the exact live QuickBooks TaxCode name). There is no `account_code` /
  `tax_type` pair here: `coding_type` + `coding_name` is the posting-target
  contract, and `tax_code_name` is the tax contract.
- At the document level: `document_type`, `counterparty_name`, `document_date`,
  optional `due_date` and `document_number`, `currency`, `tax_mode`
  (`NO_TAX`, `TAX_EXCLUDED`, `TAX_INCLUSIVE`), `lines`, and the totals
  `declared_net`, `declared_tax`, `declared_gross` that this Skill's "Amount
  resolution" section describes.
- `tax_code_name` is required on every line whenever `tax_mode` is
  `TAX_EXCLUDED` or `TAX_INCLUSIVE`, and must be omitted entirely when
  `tax_mode` is `NO_TAX`. Do not send an empty string in either direction.
- Sales-side documents (`document_type` `INVOICE` or `CREDIT_MEMO`) must use
  `ITEM` coding on every line; `ACCOUNT` coding is rejected there. Only
  purchase-side documents (`BILL`, `VENDOR_CREDIT`) may code a line directly to
  an account. This is the concrete case of the account-versus-item split
  described above.
- QuickBooks TaxCode names (read live via the tax reference read) are
  descriptive display names, not mnemonic codes, and a name does not reveal its
  direction. A tenant may publish a purchase-only code, a code valid on both
  sides, and a non-taxable code. Read each code's own purchase and sales
  applicability before using it — never infer direction from what the name
  sounds like.
- QuickBooks has no universal draft state. A successful Case execution creates
  the real QuickBooks object directly; there is no draft copy to promote later.
  Treat an unexecuted Case version as a local, immutable plan only, never as a
  write. Treat a Case operation as complete only once it carries a provider
  object id, an authorization receipt, a provider receipt, and an exact matching
  read-back — all four together.

## Boundary

This Skill proposes. It does not:

- assert that the source document is genuine, complete, or belongs to this client;
- claim anything was written — only the connector's own object id, its receipt,
  and an exact read-back together establish that;
- treat any intermediate, unexecuted, or locally-held state — a provider draft, a
  prepared-but-not-executed plan, or any status short of a verified provider
  write — as posted;
- decide authorization. Execution authority comes from the platform binding.

Every proposal remains an accountant-reviewable draft. Use
[references/singapore-gst-cases.md](references/singapore-gst-cases.md) for worked
cases and the situations that most often need a human decision.
