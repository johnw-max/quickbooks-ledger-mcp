# Deployment connector profiles

There is no universal MCP-name allowlist for these Accounting Skills. Skills are business-layer packages and must not require a named connector.

At deployment time:

1. choose one or more connector profiles for the Agent;
2. mount only the tools required by those profiles;
3. map each tool to the semantic IDs in [capability-contract.md](capability-contract.md);
4. require the normalized target/provenance envelope for every read used as business evidence;
5. calculate effective capability for the current actor, entity, connection, binding revision, and action;
6. run the target-conflict and missing-provenance regressions before enabling ledger-scoped joins or writes;
7. preserve the maximum-state boundary declared by each profile.

Current profiles:

- [connector-profiles/accountingv2-drive-demo.md](connector-profiles/accountingv2-drive-demo.md): source/work-store Demo profile; no formal-ledger posting.
- [connector-profiles/xero.md](connector-profiles/xero.md): Xero ledger adapter profile and current evidence boundary.
- [connector-profiles/quickbooks.md](connector-profiles/quickbooks.md): QuickBooks ledger adapter profile and current evidence boundary.

An Agent may compose profiles. For example, it may read source evidence through the Drive profile and execute an approved supplier bill through a QuickBooks or Xero ledger profile. Receipts retain their own destination role; they are never merged into a generic `completed` result.

Tool names, URLs, OAuth setup, tenant bindings, and environment-specific UAT evidence belong in the chosen profile or deployment configuration, not in the business Skills or generic Agent instructions.

A profile table is a deployment specification, not proof that the runtime adapter is mounted or compliant. Do not call a deployment portable or live-ready until the actual tool-to-capability registry, target binding, normalized receipts, failure behavior, and read-back have passed UAT for that environment.
