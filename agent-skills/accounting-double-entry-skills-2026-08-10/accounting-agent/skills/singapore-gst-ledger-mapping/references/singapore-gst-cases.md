# Singapore GST worked cases

Companion to `SKILL.md`. Every account code and tax code below is illustrative —
resolve the real ones from the connected organisation's live reads.

## 1. GST-inclusive catering invoice (the rounding case)

Source: catering invoice, S$1,200.00, stated GST-inclusive, local corporate
customer, issuer GST-registered.

```
rate            9%  (from the tax-rate read, not assumed)
net             1200.00 / 1.09 = 1100.9174...  -> 1100.92
tax             1200.00 - 1100.92             =   99.08
gross                                          = 1200.00   ✓ reconciles
treatment       standard-rated output
```

Declare net 1100.92, tax 99.08, gross 1200.00 — not 1100.9174. The connector
rounds to the minor unit and compares exactly.

The trap: computing tax as `net × 9%` on an already-rounded net gives
`1100.92 × 0.09 = 99.0828`. Round that to 99.08 and it agrees. But if you round
the net *after* computing tax you can land a cent off. Resolve net first, then
derive tax as the remainder for inclusive documents.

## 2. Multi-line bill, tax per line

Three lines at 300.00, 250.50, 99.90 net, all standard-rated input at 9%:

```
line 1  300.00 × 0.09 = 27.00
line 2  250.50 × 0.09 = 22.545  -> 22.55  (round half up, per line)
line 3   99.90 × 0.09 =  8.991  ->  8.99
tax total                       = 58.54
```

Computing on the document total instead gives `650.40 × 0.09 = 58.536 → 58.54`
— the same here, but not always. Always sum per-line rounded amounts; the
connector aggregates per line and a divergence is rejected.

## 3. Export sale — zero-rated, not exempt

Goods shipped to a customer in Malaysia, export documentation held.

Zero-rated output, 0% tax. Declare tax 0.00 and net = gross.

Why it matters: zero-rated supplies are taxable supplies at 0%, so input tax
attributable to them remains recoverable. Booking this as exempt would misstate
the input-tax position even though both show 0.00 tax.

## 4. Exempt output — which kind

Interest earned on a fixed deposit, incidental to the main business.

This is typically a **Regulation 33** exempt supply. Regulation 33 supplies are
excluded when computing the exempt-supply threshold for input tax apportionment,
so classifying them as ordinary exempt output can wrongly restrict input tax
recovery.

If it is genuinely unclear whether a supply falls under Regulation 33, that is a
question for the accountant, not a coin flip. Present both candidates.

## 5. Supplier not GST-registered

Supplier bill showing no GST and no GST registration number.

No-tax treatment, tax 0.00. Do not impute input tax that was never charged.

## 6. Entity not GST-registered

The organisation read shows the entity is not registered for GST.

No standard-rated output applies at all. Every sale is no-tax regardless of what
the source document suggests. If a customer invoice arrives showing GST, that is
a finding to raise, not a treatment to replicate.

## Situations that should go to a human

- The document shows GST but the stated tax does not match any available rate.
- Mixed supplies on one document (standard-rated and exempt lines together)
  where the split is not stated.
- A tax invoice missing the supplier's GST registration number where input tax
  is being claimed.
- Any transitional-rate question spanning a rate change date.
- Foreign-currency documents where the GST amount in SGD is not stated — GST must
  be reported in SGD and the document's own SGD figure is authoritative.

In each case: state what is missing, give the candidate treatments, and stop.
