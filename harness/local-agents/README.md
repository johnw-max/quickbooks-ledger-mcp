# Local QuickBooks Accounting Case Agent harness

This STDIO runtime lets a real local Agent exercise the production 0.6
QuickBooks Accounting Case tools against a deterministic, stateful in-memory
Company. It is an Agent-orchestration test surface, not an Intuit Sandbox or
production acceptance result.

Safety boundary:

- The Provider has no HTTP client and cannot reach Intuit or any external
  network service.
- The request context is OAuth-bound to one synthetic workspace, installation,
  connection and Company. Tool arguments cannot select another tenant.
- Only the six released Accounting Case `CREATE` capabilities are enabled:
  Customer, Vendor, Invoice, Bill, CreditMemo and VendorCredit.
- Every successful synthetic write returns a provider-style receipt and exact
  ID read-back. Reusing a provider request ID is idempotent; substituting a
  different payload under the same ID fails closed.
- Repositories and ledger state exist only for the lifetime of the process.
- The legacy supplier-Bill prepare/approve path is not used by this harness.

Build the runtime:

```sh
npm run build:harness:synthetic-qbo
```

Configure the local Agent's STDIO MCP with:

- command: `node`
- args: `tmp/quickbooks-local-agent-runtime/quickbooks-synthetic-mcp-0.6.0.mjs`
- cwd: this repository root
- env: `QUICKBOOKS_SYNTHETIC_CASE_WRITE_ENABLED=true`

The write flag defaults to `true` because the target is an in-memory Provider
with no network code. Set it to `false` to verify the Case write kill switch;
prepare and read calls remain available, while execute fails closed.

Use a fresh process per persona. Preserve multi-turn user messages, Agent tool
calls, MCP results and the final answer as separate evidence. Passing this
harness proves local Agent behavior plus MCP/service contracts only; it does
not prove Intuit OAuth, QuickBooks Sandbox writes, the public HTTPS deployment,
or Agent2 behavior.

## Persistent HTTP mode

For separate Agent/Codex commands that must share one synthetic Case repository
and ledger state, build once and start the long-lived loopback server:

```sh
npm run build:harness:synthetic-qbo
npm run start:harness:synthetic-qbo-http
```

With that server still running, a second terminal can run the reproducible
two-session persistence smoke:

```sh
npm run test:harness:synthetic-qbo-http
```

The first MCP session prepares a Case and terminates. A separately initialized
second session executes that same Case and requires a provider ID plus exact
read-back evidence.

Connect clients to `http://127.0.0.1:3310/quickbooks/mcp`. Override only the
port with `QUICKBOOKS_SYNTHETIC_HTTP_PORT`; the server always binds to loopback
and cannot be exposed on a LAN interface. `/healthz` reports mutation and active
session counts without returning ledger content.

The Provider, mutation repository and Accounting Case repository are shared by
all MCP sessions in that one server process. A later command may therefore
initialize a new MCP session and read or execute a Case prepared by an earlier
command. State still disappears when the HTTP server process exits; this is
deliberate and prevents synthetic evidence from being confused with durable
production persistence.
