# QuickBooks 0.6.0 acceptance scenarios

## P0 release gates

| ID | Scenario | Required result | Automated evidence |
|---|---|---|---|
| QBO-OAUTH-01 | Agent2 and Work consents | Separate Host clients, installation actors, redirect/origin allowlists, token families and QBO connections | OAuth service + config + HTTP edge tests |
| QBO-OAUTH-02 | Refresh replay/concurrency | One coalesced response in grace; family revoked after replay | MCP OAuth concurrency tests |
| QBO-TARGET-01 | Company changes after preparation | Execution denied; never rerouted | target session + mutation tests |
| QBO-CASE-01 | Existing Customer invoice | Typed Case creates one invoice and exact read-back | Case service test |
| QBO-CASE-02 | New Customer plus invoice | v1 contact only; v2 invoice only; no duplicate contact | staged Case service test |
| QBO-CASE-03 | Missing source unit/fact | Case blocked before provider write | compiler tests |
| QBO-CASE-04 | 800 + 7.20 declared as 87.20 | Deterministic validation rejects | compiler tests |
| QBO-CASE-05 | Foreign currency with multi-currency disabled | Case blocked with explicit reason | Case service test |
| QBO-AUTH-01 | Delegation lacks exact action | Provider never called | kernel + Case service tests |
| QBO-IDEM-01 | Same request replay | Same preparation/terminal result; one provider call | mutation + Case tests |
| QBO-RECOVERY-01 | Provider outcome unknown | Recovery required; no blind retry | mutation/Case recovery tests |
| QBO-RECOVERY-02 | Crash after claim but before POST | Stale pre-dispatch lease is reclaimable; old worker is fenced | execution fencing tests |
| QBO-RECOVERY-03 | Crash after POST but before exact-ID callback | Stale attempt becomes no-ID operator recovery; never a second POST | execution fencing + PostgreSQL tests |
| QBO-RECOVERY-04 | Exact-ID callback arrives after stale reconciliation | Same attempt/token may move forward to exact-ID GET recovery; old token is rejected | execution fencing + PostgreSQL tests |
| QBO-RECOVERY-05 | Current delegation fails after a possible/durable write | Case preserves durable no-ID or exact-ID recovery truth; never terminalizes it as Provider rejection | Case service tests |
| QBO-DB-01 | Concurrent/invalid state transition | PostgreSQL CAS/trigger rejects it | required PostgreSQL integration tests |
| QBO-HTTP-01 | Missing bearer, wrong origin, OAuth identity propagation | 401/403; trusted actor reaches tool service | required HTTP edge test |
| QBO-BOUNDARY-01 | Public/external role | Ledger tools denied | composition boundary tests |
| QBO-SECRET-01 | Git candidate scan | No credential file or token assignment committed | pre-push secret scan |

## Business dialogue acceptance

Use a continuous accountant conversation, not unrelated one-line probes:

1. connect a Sandbox Company through OAuth;
2. ask which Company and target are active;
3. review customer/vendor history, accounts, items, tax codes, bills, transactions, and trial balance;
4. submit an invoice or bill fact set with source coverage;
5. inspect Case events, exceptions, totals, and proposed operations;
6. execute only with the configured standing delegation;
7. ask for Case status and verify provider ID, authorization receipt, provider receipt, and read-back;
8. repeat the request and confirm no duplicate;
9. repeat with a missing contact and confirm the two-version staging behavior;
10. attempt a blocked cash/journal/delete action and confirm it is catalog-only, not Case-released.

Local automation is the development gate. `agent2.zcloak.ai` is used once after deployment as final acceptance and must use the current endpoint `https://mcp.jiayuanwang.xyz/quickbooks/mcp`.
