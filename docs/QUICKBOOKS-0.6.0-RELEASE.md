# QuickBooks Ledger MCP 0.6.0 release boundary

## PM conclusion

This version is suitable for a controlled Sandbox demo and developer handoff. It demonstrates per-user OAuth, exact Company binding, accountant reads, typed document intake, governed Case preparation, standing-delegation execution, provider receipt, and exact read-back.

It is not a production accounting close/tax engine and does not release all 71 official Intuit write operations to an Agent. The catalog and the released workflow are deliberately separate.

## Architecture

```mermaid
flowchart LR
  C["Client / document source"] --> S["Drive, DB, or WorkStore MCP"]
  S --> A["Internal accountant Agent"]
  A --> Q["QuickBooks Ledger MCP"]
  Q --> H["Agent2 or Work Host OAuth client"]
  H --> O["Per-installation OAuth binding"]
  O --> T["Exact Company target session"]
  T --> K["Accounting Case compiler + control kernel"]
  K --> P["QuickBooks Online"]
  P --> R["Provider receipt + exact read-back"]
```

Xero is a separate MCP and deployment. It may be configured on the same Agent, but it shares no OAuth token, provider-specific write policy, Company/Organisation binding, mutation table, or repository with this service. Both connectors conform to the same provider-neutral ledger-control contract—typed Case, exact target, deterministic validation, source/payload hashes, one-shot Provider write permission, durable idempotency, receipt/read-back, and conservative recovery—while their provider adapters remain independent.

## Released journey

1. Agent2 or Work starts OAuth through its own registered confidential Host client; the user consents on Intuit.
2. The connector creates one installation identity and stores one active QBO Company connection.
3. The Agent resolves a short-lived target session, reads Company/history/reference data, and prepares an Accounting Case.
   If that proof expires, the same OAuth installation may issue a fresh target
   proof and resume the Case only when the server-resolved connection, binding
   revision, and QuickBooks Company Realm are all unchanged.
4. The compiler verifies supplied-source coverage, fact revision lineage, document totals, tax inputs, currency rules, exact references, and released actions.
5. Execution requires the matching transport scope, exact standing delegation, write kill switch, static capability policy, unchanged OAuth binding, and target session.
6. Every provider mutation is idempotent and must end with receipt plus read-back or a recovery state.

Agent2 and Work do not share a Host `client_id`, secret, redirect URI, token family, or allowed browser origin. The Intuit App and server-side Intuit callback remain one provider boundary. Until a Host supplies a separately verifiable identity assertion, the Broker labels its generated principal `INSTALLATION_ONLY`, never `TRUSTED_HOST_CONTEXT`.

## Capability layers

| Layer | Meaning | 0.6.0 status |
|---|---|---|
| Official Intuit catalog | Operations Intuit's official MCP/API can expose | Catalogued for product planning |
| Deployment policy | Operations enabled for this environment and Company | Default-safe, explicit allowlist supported |
| Accounting Case release | Operations an Agent can compile from typed business facts | Six create capabilities |
| Standing delegation | Exact actions this Agent installation may execute autonomously | Explicit list; empty/unknown list fails startup |
| Crash-safe Provider outcome | One durable attempt, pre-POST dispatch marker, fenced lease, exact QuickBooks entity ID and request-bound receipt | Stale pre-dispatch work may be reclaimed; post-dispatch no-ID work requires operator resolution and cannot re-arm; a late exact ID from the same fenced attempt moves only forward to exact-ID GET recovery; no path repeats the POST |

## Intentionally not released

- cash receipt/payment, refund, deposit, transfer;
- JournalEntry;
- delete/void and CompanyInfo changes;
- general updates and arbitrary provider-shaped payloads;
- automatic cross-ledger copying between Xero and QuickBooks;
- external/public Client Intake access to ledger credentials.

These are not missing API wrappers. They require accounting policy, compiler semantics, source/evidence rules, conflict handling, and UAT before becoming Agent-facing.
