# zCloak QuickBooks Ledger MCP

Independent QuickBooks Online MCP for accountant-operated Agents. It is intentionally separate from the Xero MCP and has its own OAuth, database tables, deployment unit, release gate, and provider-specific write policy.

It reuses the same provider-neutral ledger-control contract proven by the Xero MCP: typed Accounting Cases, exact ledger targeting, deterministic validation, source and payload hashes, one-shot Provider write permission, durable idempotency, receipt plus exact read-back, and fail-closed recovery. QuickBooks-specific adapters own Realm/Company binding, Intuit OAuth, SyncToken, tax, currency, and entity semantics. The two MCPs never share credentials, tenant data, or mutation state.

## Product boundary

- The accountant's internal Work Agent connects this MCP. Public Client Intake Agents should not receive ledger credentials.
- Drive, a database, or WorkStore remains the source-material and collaboration layer. QuickBooks is the formal ledger/system of record.
- Each Agent2 or Work OAuth consent creates an isolated installation principal and binds it to one active QuickBooks Company. Each Host is a separate confidential OAuth client with its own secret, exact redirect allowlist, and origin allowlist. A short-lived `target_session_ref` pins every read and Case write to that exact Company.
- The official Intuit write catalog is exposed as capability information, not as a promise that every action is Agent-released.

## Agent-facing Accounting Case release (0.6.0)

The public write surface accepts typed facts and source coverage, never raw provider IDs or arbitrary QuickBooks JSON. The compiler currently releases:

- Create Customer
- Create Vendor
- Create Invoice
- Create Bill
- Create Credit Memo
- Create Vendor Credit

When a new Customer or Vendor and its document arrive together, the Case stages them safely: version 1 creates and reads back the contact; version 2 resolves the new provider ID and creates the document. It never invents an ID or duplicates an existing exact-name contact.

Other official Intuit write capabilities remain catalogued but are not executable through Accounting Case 0.6.0. Cash movement, journals, delete, CompanyInfo changes, and broad update flows need explicit product policy and compiler support before release.

## Write completion standard

`PREPARED` is not a successful write. A Case operation is complete only when all of these are durable:

1. exact OAuth installation, connection, Company, and target session;
2. complete supplied-source coverage and deterministic totals/tax/currency validation;
3. active standing delegation for the exact action and tenant;
4. immutable idempotency key and canonical payload hash;
5. provider receipt and exact read-back;
6. terminal audit evidence.

Every write has one durable execution attempt, a fenced lease, and a dispatch marker written immediately before the first Provider POST. A stale lease may move only before that marker. After dispatch, a missing exact ID becomes `WRITE_RESULT_UNKNOWN_NO_ID`: automatic re-arm is forbidden and an operator resolution is required. If the original fenced callback later supplies the exact ID, the state may move only forward to exact-ID readback recovery; it never permits another POST. Current OAuth/delegation errors cannot overwrite that durable write truth in the Accounting Case.

## Local setup

Requirements: Node.js 22+, PostgreSQL 16+, and an Intuit development app.

```bash
npm ci
cp config/quickbooks.env.example .env.local
npm run migrate:dev
npm run dev
```

The Intuit callback is `${QUICKBOOKS_PUBLIC_BASE_URL}/oauth/quickbooks/callback`. The current shared-domain production target is `https://mcp.jiayuanwang.xyz/oauth/quickbooks/callback`; Agent2's MCP callback remains `https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback`. Work's callback must be copied exactly from the newly created Work MCP and registered as a different Host client; never infer it from Agent2.

The Broker currently proves an installation and its exact QuickBooks binding, not the Host's human/workspace identity. Broker principals therefore report `INSTALLATION_ONLY`. This does not bypass the write kill switch, scope, standing-delegation, capability, target-session, idempotency, receipt, or read-back gates. Local synthetic tests use an explicitly constructed `TRUSTED_HOST_CONTEXT`; production must not synthesize that assurance.

Do not commit `.env.local`, Intuit credentials, MCP client secrets, bearer tokens, encryption keys, OAuth tokens, or database passwords.

## Release verification

```bash
npm run verify:release
```

Set `TEST_DATABASE_URL` to make the PostgreSQL integration tests mandatory. Agent2 is a separate post-deployment acceptance step; local gates never label Agent2 UAT as passed.

See [release scope](docs/QUICKBOOKS-0.6.0-RELEASE.md), [test scenarios](docs/QUICKBOOKS-0.6.0-TEST-SCENARIOS.md), and [security policy](SECURITY.md).
