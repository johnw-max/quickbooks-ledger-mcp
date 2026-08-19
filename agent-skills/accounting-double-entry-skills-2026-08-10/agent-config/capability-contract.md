# Accounting connector capability contract

## Purpose

Accounting Skills contain provider-neutral business judgment. The Agent/runtime discovers authorized capabilities and routes a canonical accounting intent. MCP servers and adapters execute data access or actions and return normalized receipts.

MCP is a protocol boundary, not a promise that every server has the same accounting meaning. Portability requires the same semantic capability contract or an explicit adapter mapping.

```text
Accounting Skill
  -> provider-neutral AccountingIntent
  -> capability router / domain runtime
      -> SourceStore adapter -> file or document system
      -> WorkStore adapter   -> review/workflow store
      -> Ledger adapter      -> formal accounting system
```

## Layer ownership

### Skill

- interpret the economic event and evidence;
- propose the business route and balanced debit/credit treatment;
- define missing information, approval, and exception rules;
- state the highest truthful business outcome.

The Skill must not depend on `xero_*`, `quickbooks_*`, Google Drive tool names, OAuth fields, provider tenant IDs, folder IDs, workbook ranges, or raw API payloads.

### Capability router and domain runtime

- normalize `AccountingIntent` and lifecycle state;
- calculate effective capabilities for the current actor, connection, entity, and action;
- select an authorized adapter without changing the accounting meaning;
- enforce policy, approval, idempotency, audit, and outcome recovery;
- normalize receipts and preserve provider-specific state semantics.

### MCP and provider adapter

- map the canonical intent to provider operations;
- enforce tenant/entity binding, scopes, permission, write gate, and destination role;
- validate provider references and legal state transitions;
- perform the action and exact read-back;
- return structured success, partial, failed, or outcome-unknown receipts.

Deterministic controls such as balance, tenant binding, approval match, idempotency, valid period/account/tax, and duplicate prevention must not depend only on model compliance with a Skill.

## Fact provenance and ledger-target gate

Classify each business fact by origin and destination role:

- `USER_ASSERTED`: supplied in user text, remembered conversation, an example, a filename, or an attachment statement. It may be a requested entity label or source assertion, but never establishes the authorized ledger target.
- `HOST_BOUND`: supplied by the authenticated host/runtime for the active connection and binding revision.
- `MCP_READ`: returned by an authorized capability with a receipt bound to the active connection, destination role, target, and binding revision.

`MCP_READ` is not automatically a ledger fact: a source- or work-store read can support source/review facts but cannot establish the formal-ledger organisation. Before any current-ledger fact, join, or action, the runtime must obtain `TARGET_VERIFIED` from `ledger.target.resolve` or an equally authoritative `HOST_BOUND` manifest. Re-resolve for a new conversation and after any binding-revision change. A later ledger receipt is usable only when its safe target reference and binding revision match that verified target.

Every read result used as evidence must carry a normalized envelope. The minimum fields are role-specific rather than pretending every connector is a ledger:

```text
common: fact_origin, source_system, destination_role, capability_id,
        tool_call_or_audit_ref, observed_at, output_hash, fact_paths[]
bounded list/report reads: query_bounds, completeness
connector_control_plane: connection_ref_safe, connection_state
source_store: source_object_ref_safe
work_store: work_scope_or_record_ref_safe
ledger_sor: bound_target_ref_safe, organisation_display_name,
            binding_revision, capability_revision
```

`fact_paths[]` binds each asserted field to a response field or JSON pointer. For `ledger.target.resolve`, the envelope must bind the organisation display name and base currency when returned. A source/work-store receipt can support only the returned material, work scope, or review object; it cannot establish a ledger target or ledger state. Raw provider secrets and sensitive target locators remain server-side.

Keep the provenance gate separate from accounting lifecycle state:

- `TARGET_UNVERIFIED`: target resolution is absent, failed, empty, stale, or missing its evidence envelope. Do not state current ledger facts or perform ledger-scoped joins/actions.
- `TARGET_VERIFIED`: current host/MCP evidence resolves one target and later ledger reads match its binding revision.
- `TARGET_CONFLICT`: current receipts or host context identify different targets/revisions. Keep results separate and block ledger-scoped joins/actions.
- `READ_EVIDENCE_REJECTED`: a read value lacks the required target/provenance envelope or field binding. Do not promote it to a current-ledger fact.

The model may still analyze clearly labeled user/source assertions outside the ledger, but it must not silently upgrade them to `HOST_BOUND` or `MCP_READ`. The platform/runtime should enforce these gates deterministically; prompt compliance alone is not sufficient.

## Destination roles

- `connector_control_plane`: connection health and binding-resolution observations only; it is not an accounting destination and never proves a ledger target or ledger state.
- `source_store`: original documents and source metadata.
- `work_store`: cases/work scopes, extracted fields, review records, proposals, approvals, handoffs, and workflow audit.
- `ledger_sor`: authoritative accounting transactions, journals, subledgers, reports, reconciliations, and period state.

One connection may implement several roles. One workflow may compose several connections. A destination may be used only for its authorized role.

## AccountingIntent

```text
intent_id
business_action
entity_ref / period / transaction_date
transaction_currency / reporting_currency
source_refs[]
economic_event
preferred_route: native_transaction | manual_journal
balanced_lines[]
unresolved_items[]
proposal_version / proposal_digest
```

Examples of `business_action` include `record_supplier_bill`, `record_sales_invoice`, `record_payment`, `record_receipt`, `record_transfer`, `record_adjustment`, `reconcile_balance`, and `assess_close`.

Without live ledger reference data, use account-family and tax-treatment candidates. Do not invent provider account codes, tax IDs, contact IDs, or open-period status.

## Stable semantic capabilities

### Connector/runtime

```text
connector.connection.status.read
```

### Source and work

```text
source.metadata.read
source.content.read
source.original.preserve
source.original.readback
work.scope.resolve
work.material.persist
work.material.readback
work.review_record.persist
work.review_record.readback
work.review_record.search
work.proposal.persist
work.proposal.readback
work.open_item.persist
work.open_item.read
work.reconciliation_candidate.persist
work.reconciliation_candidate.read
work.approval.read
```

### Authorization contract

Every formal-ledger write must use exactly one authorization path for the same target, action, and scope:

1. an exact current per-transaction approval when the connection or action requires per-transaction approval; or
2. a platform-bound, currently valid standing delegation covering that same target, action, and scope.

These paths are alternatives; the runtime must not require both. A natural-language business execution request or chat consent expresses intent, but is not permission. Before provider execution, the runtime must revalidate the selected path, target, scope, write gate, deterministic validation, idempotency, one-shot permit, receipt, and exact read-back. A typed Accounting Case that is explicitly mounted under standing delegation must not ask for a confirmation phrase or per-item approval.

For a native document, accounting and tax semantics are line-scoped. A domain runtime may accept one explicit document default only when it is declared to apply to every line; mixed documents require a complete policy decision per line. The immutable plan and exact read-back contract must preserve a provider-neutral accounting-policy binding and provider-tax binding for every line. One bad or unresolved line blocks the whole native document before the adapter's mutation boundary; a valid multi-line document remains one provider object.

Recovery semantics after an unknown provider outcome are connector-specific and are stated in each deployment's connector profile. Do not carry one connector's recovery allowance across to another.

### Formal ledger

```text
ledger.target.resolve
ledger.reference.accounts.read
ledger.reference.tax.read
ledger.reference.counterparty.read
ledger.reference.item.read
ledger.period.status.read
ledger.transaction.search
ledger.transaction.native.prepare
ledger.transaction.native.execute
ledger.transaction.journal.prepare
ledger.transaction.journal.execute
ledger.accounting_case.prepare
ledger.accounting_case.execute
ledger.accounting_case.status.read
ledger.object.read_exact
ledger.report.read
ledger.report.trial_balance.read
ledger.reconciliation.verify
ledger.period.lock
```

### Controls

```text
control.approval.verify
control.outcome.reconcile
```

Tool names may differ by provider. A deployment profile maps each mounted tool to one or more capability IDs. The Skill checks effective capability, not server identity.

## Effective capability manifest

Calculate this for the current actor, entity, connection, and action:

```text
connection_ref_safe
destination_role: source_store | work_store | ledger_sor
bound_target_ref_safe
fact_origin: HOST_BOUND | MCP_READ
binding_revision
capability_id
available
supported_object_types[]
control_requirement
deny_reasons[]
adapter_version
capability_revision
last_verified_at
```

Effective capability is the intersection of release policy, connection health, bound target, OAuth scope, user permission, write gate, object/action support, and the selected authorization path. The appearance of one tool must not imply any other capability on that server.

## Execution and normalized receipt

```text
describeCapabilities(context)
resolveTarget(context)
readReferenceData(intent)
prepare(intent, mappedReferences)
execute(preparedRef, verifiedApproval)
prepareAccountingCase(submittedFacts, expectedVersion)
executeAccountingCase(caseRef, standingDelegationOrExactApproval)
getAccountingCaseStatus(caseRef)
readBack(providerObjectRef)
queryOutcome(attemptRef)
readReport(reportSpec)
```

Normalize every external result:

```text
result_class: succeeded | partial | failed | outcome_unknown
intent_id / attempt_id
idempotency_result
adapter_type / capability_revision
fact_origin / source_system / destination_role / capability_id
bound_target_ref_safe
organisation_display_name / binding_revision / observed_at
tool_call_or_audit_ref / query_bounds / completeness / output_hash
fact_paths[]
provider_object_ref_safe
provider_state
ledger_effective: true | false | unknown
receipt_ref_or_hash
readback_attempted / readback_result_class
readback_verified / readback_digest / readback_at
verified_fields[]
next_gate
```

Keep `source_state`, `proposal_state`, `ledger_state`, `reconciliation_state`, and `close_state` separate. Only `ledger_effective=true` plus exact read-back permits `POSTED_READBACK_VERIFIED`.

Capability availability and action outcome are separate facts. A mounted exact-read capability may still time out or fail for one attempt; retain `WRITE_RESULT_UNVERIFIED` until a later read-back succeeds. A write may also return `OUTCOME_UNKNOWN` when no outcome-query capability is available; retain the unknown state, prohibit blind resubmission, and route to manual investigation.

## Graceful degradation

| Effective capabilities | Maximum truthful outcome |
|---|---|
| Missing, stale, failed, or conflicting ledger-target evidence | `TARGET_UNVERIFIED` or `TARGET_CONFLICT`; no current-ledger fact, join, or action |
| Ledger read without the required target/provenance envelope | `READ_EVIDENCE_REJECTED`; value is not authoritative current-ledger evidence |
| No relevant connector | balanced proposal in chat; unsaved |
| A source/work-store persistence action | source or proposal saved outside the ledger, even if a ledger connector is also mounted but unused |
| Ledger reference reads | mapped and validated proposal; unposted |
| Ledger non-effective draft write + exact read-back | provider draft; unposted |
| Definitive successful ledger write without successful exact read-back | `WRITE_RESULT_UNVERIFIED`; no posted claim |
| Timeout or ambiguous execution result | `OUTCOME_UNKNOWN`; query the original attempt when supported, otherwise investigate manually, and never resubmit blindly |
| Exact read-back conflicts with the approved intent | `WRITE_RESULT_MISMATCH`; investigate without blind retry |
| Ledger-effective write + exact read-back | posted and read-back verified |
| Trial Balance read | separate Trial Balance evidence only |
| Reconciliation verify | separate account-level reconciliation evidence only |
| Close controls + approval + period lock + independent locked-status read-back | `CLOSED_VERIFIED` for the exact entity and period |

Do not silently fall back to another company, connector, workbook, folder, database, or provider. A file/storage receipt never proves posting, Trial Balance, formal reconciliation, or close.
