from __future__ import annotations

import json
import re
import sys
import zipfile
from decimal import Decimal, InvalidOperation
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = ROOT / "accounting-agent" / "skills"
PREPARE_SKILL = SKILLS_ROOT / "prepare-balanced-accounting-entry"
EXECUTE_SKILL = SKILLS_ROOT / "execute-approved-accounting-entry"
CASES_FILE = ROOT / "tests" / "double-entry-cases.json"
CAPABILITY_CASES_FILE = ROOT / "tests" / "connector-capability-cases.json"
PROVENANCE_CASES_FILE = ROOT / "tests" / "provenance-cases.json"
ORCHESTRATION_CASES_FILE = ROOT / "tests" / "agent-orchestration-cases.json"
DEPLOY_ROOT = ROOT / "deploy"


def fail(errors: list[str]) -> None:
    print(f"Validation failed ({len(errors)} errors):")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)


def require_text(errors: list[str], path: Path, phrases: list[str]) -> None:
    if not path.exists():
        errors.append(f"missing file: {path.relative_to(ROOT)}")
        return
    text = path.read_text(encoding="utf-8")
    for phrase in phrases:
        if phrase not in text:
            errors.append(f"{path.relative_to(ROOT)}: missing {phrase!r}")


def reject_text(errors: list[str], path: Path, phrases: list[str]) -> None:
    if not path.exists():
        errors.append(f"missing file: {path.relative_to(ROOT)}")
        return
    text = path.read_text(encoding="utf-8")
    for phrase in phrases:
        if phrase in text:
            errors.append(f"{path.relative_to(ROOT)}: forbidden {phrase!r}")


def validate_skill_frontmatter(
    errors: list[str], skill_dir: Path, expected_name: str
) -> None:
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.exists():
        errors.append(f"{expected_name}: missing SKILL.md")
        return
    lines = skill_file.read_text(encoding="utf-8").splitlines()
    if len(lines) >= 500:
        errors.append(f"{expected_name}: has {len(lines)} lines; expected under 500")
    if not lines or lines[0] != "---":
        errors.append(f"{expected_name}: frontmatter does not start with ---")
        return
    try:
        end = lines.index("---", 1)
    except ValueError:
        errors.append(f"{expected_name}: frontmatter is not closed")
        return
    keys = [line.split(":", 1)[0] for line in lines[1:end] if ":" in line]
    if keys != ["name", "description"]:
        errors.append(
            f"{expected_name}: frontmatter keys are {keys}, expected name and description"
        )
    if lines[1] != f"name: {expected_name}":
        errors.append(f"{expected_name}: Skill name does not match folder")


def validate_frontmatter(errors: list[str]) -> None:
    validate_skill_frontmatter(errors, PREPARE_SKILL, "prepare-balanced-accounting-entry")
    validate_skill_frontmatter(errors, EXECUTE_SKILL, "execute-approved-accounting-entry")


def amount(value: str, label: str, errors: list[str]) -> Decimal:
    try:
        result = Decimal(value)
    except (InvalidOperation, TypeError):
        errors.append(f"{label}: invalid amount {value!r}")
        return Decimal("0")
    if result < 0:
        errors.append(f"{label}: amounts must be non-negative")
    return result


def validate_cases(errors: list[str]) -> int:
    try:
        cases = json.loads(CASES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"cannot load test cases: {exc}")
        return 0

    seen: set[str] = set()
    for case in cases:
        case_id = case.get("case_id", "<missing>")
        if case_id in seen:
            errors.append(f"duplicate case_id: {case_id}")
        seen.add(case_id)
        status = case.get("expected_status")
        entries = case.get("entries", [])
        if status == "blocked":
            if entries:
                errors.append(f"{case_id}: blocked case must not contain proposed entries")
            if not case.get("blockers"):
                errors.append(f"{case_id}: blocked case needs explicit blockers")
            continue
        if status != "balanced_proposal":
            errors.append(f"{case_id}: unknown expected_status {status!r}")
            continue
        for field in (
            "entity",
            "accounting_file",
            "period",
            "period_status",
            "currency",
            "reporting_currency",
            "account_mapping_status",
        ):
            if not case.get(field):
                errors.append(f"{case_id}: {field} is required for a balanced proposal")
        if not entries:
            errors.append(f"{case_id}: balanced case has no entries")
            continue

        batch_debit = Decimal("0")
        batch_credit = Decimal("0")
        for entry in entries:
            entry_id = entry.get("entry_id", "<missing>")
            lines = entry.get("lines", [])
            source_refs = entry.get("source_refs", [])
            if len(lines) < 2:
                errors.append(f"{case_id}/{entry_id}: expected at least two lines")
            if not source_refs:
                errors.append(f"{case_id}/{entry_id}: source_refs are required")
            if not entry.get("proposed_route"):
                errors.append(f"{case_id}/{entry_id}: proposed_route is required")
            if not entry.get("transaction_date"):
                errors.append(f"{case_id}/{entry_id}: transaction_date is required")

            debit_total = Decimal("0")
            credit_total = Decimal("0")
            for index, line in enumerate(lines, start=1):
                label = f"{case_id}/{entry_id}/line{index}"
                debit = amount(line.get("debit"), f"{label}/debit", errors)
                credit = amount(line.get("credit"), f"{label}/credit", errors)
                if (debit > 0) == (credit > 0):
                    errors.append(f"{label}: exactly one of debit or credit must be positive")
                if not line.get("account_family"):
                    errors.append(f"{label}: account_family is required")
                if not line.get("description"):
                    errors.append(f"{label}: description is required")
                source_ref = line.get("source_ref")
                if not source_ref:
                    errors.append(f"{label}: source_ref is required")
                elif source_ref not in source_refs:
                    errors.append(f"{label}: source_ref must appear in entry source_refs")
                if not line.get("tax_treatment") and not line.get("unresolved_tax_flag"):
                    errors.append(
                        f"{label}: tax_treatment or unresolved_tax_flag is required"
                    )
                debit_total += debit
                credit_total += credit
            if debit_total != credit_total:
                errors.append(
                    f"{case_id}/{entry_id}: debits {debit_total} != credits {credit_total}"
                )
            batch_debit += debit_total
            batch_credit += credit_total
        if batch_debit != batch_credit:
            errors.append(f"{case_id}: batch debits {batch_debit} != credits {batch_credit}")
    return len(cases)


def validate_capability_cases(
    errors: list[str], known_capabilities: set[str]
) -> int:
    try:
        cases = json.loads(CAPABILITY_CASES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"cannot load connector capability cases: {exc}")
        return 0

    seen: set[str] = set()
    supplier_fingerprints: set[str] = set()
    for case in cases:
        case_id = case.get("case_id", "<missing>")
        if case_id in seen:
            errors.append(f"duplicate connector case_id: {case_id}")
        seen.add(case_id)
        for field in (
            "scenario_scope",
            "connector_labels",
            "destination_roles",
            "available_capabilities",
            "business_intent_id",
            "proposal_fingerprint",
            "user_requested_write",
            "approval_verified",
            "target_binding_verified",
            "action_attempted",
            "write_attempted",
            "expected_state",
            "forbidden_claims",
        ):
            if field not in case or case.get(field) in (None, ""):
                errors.append(f"{case_id}: missing connector-case field {field}")

        capabilities = set(case.get("available_capabilities", []))
        roles = set(case.get("destination_roles", []))
        state = case.get("expected_state")
        execution_capabilities = {
            "ledger.transaction.native.execute",
            "ledger.transaction.journal.execute",
        }
        has_execution = bool(execution_capabilities & capabilities)
        action_attempted = case.get("action_attempted") is True
        write_attempted = case.get("write_attempted") is True
        user_requested_write = case.get("user_requested_write") is True
        approval_verified = case.get("approval_verified") is True
        target_binding_verified = case.get("target_binding_verified") is True
        ledger_effective = case.get("ledger_effective_readback")
        readback_verified = case.get("readback_verified") is True

        if case.get("scenario_scope") not in {"contract_simulation", "current_deployment"}:
            errors.append(f"{case_id}: invalid scenario_scope")
        if not capabilities.issubset(known_capabilities):
            errors.append(
                f"{case_id}: unknown capabilities {sorted(capabilities - known_capabilities)}"
            )
        if not roles.issubset({"source_store", "work_store", "ledger_sor"}):
            errors.append(f"{case_id}: unknown destination role")
        if not user_requested_write:
            errors.append(f"{case_id}: execution/degradation case needs explicit user request")
        if write_attempted and not action_attempted:
            errors.append(f"{case_id}: ledger write implies an external action attempt")

        if action_attempted:
            for field in (
                "result_class",
                "attempt_id",
                "idempotency_result",
                "bound_target_ref_safe",
                "capability_revision",
                "receipt_ref_or_hash",
            ):
                if not case.get(field):
                    errors.append(f"{case_id}: action receipt missing {field}")
        if readback_verified:
            for field in (
                "provider_object_ref_safe",
                "readback_digest",
                "verified_fields",
            ):
                if not case.get(field):
                    errors.append(f"{case_id}: verified read-back missing {field}")
            if case.get("result_class") != "succeeded":
                errors.append(f"{case_id}: verified read-back requires succeeded result")

        if case.get("business_intent_id") == "record_supplier_bill":
            supplier_fingerprints.add(case.get("proposal_fingerprint", ""))

        if state == "BALANCED_PROPOSAL_IN_CHAT":
            if capabilities or roles or action_attempted or approval_verified:
                errors.append(f"{case_id}: chat-only case must have no external capability")
        elif state == "READY_FOR_MANUAL_POSTING":
            if capabilities or roles or action_attempted:
                errors.append(f"{case_id}: manual-posting package must have no external action")
            if not approval_verified:
                errors.append(f"{case_id}: manual-posting package requires verified approval")
        elif state == "PROPOSAL_SAVED_OUTSIDE_LEDGER":
            if "work.proposal.persist" not in capabilities:
                errors.append(f"{case_id}: proposal persistence capability is required")
            if case.get("action_capability_used") != "work.proposal.persist":
                errors.append(f"{case_id}: outside-ledger save must use work.proposal.persist")
            if write_attempted:
                errors.append(f"{case_id}: outside-ledger save cannot attempt a ledger write")
            if not action_attempted or not readback_verified:
                errors.append(f"{case_id}: saved proposal needs persistence receipt and read-back")
        elif state == "PREPARED_UNPOSTED":
            if "ledger_sor" not in roles or "ledger.reference.accounts.read" not in capabilities:
                errors.append(f"{case_id}: read-only ledger context is required")
            if has_execution or write_attempted:
                errors.append(f"{case_id}: read-only case cannot execute a write")
        elif state == "PROVIDER_DRAFT_UNPOSTED":
            required = {
                "ledger.object.read_exact",
                "control.approval.verify",
            }
            if (
                "ledger_sor" not in roles
                or not required.issubset(capabilities)
                or not has_execution
            ):
                errors.append(f"{case_id}: draft execution/read-back capabilities are required")
            if (
                not write_attempted
                or not approval_verified
                or not target_binding_verified
                or not readback_verified
                or ledger_effective is not False
            ):
                errors.append(f"{case_id}: draft must be approved, attempted, and non-effective")
        elif state == "POSTED_READBACK_VERIFIED":
            required = {
                "ledger.object.read_exact",
                "control.approval.verify",
            }
            if (
                "ledger_sor" not in roles
                or not required.issubset(capabilities)
                or not has_execution
            ):
                errors.append(f"{case_id}: ledger write/read-back capabilities are required")
            if (
                not write_attempted
                or not approval_verified
                or not target_binding_verified
                or not readback_verified
                or ledger_effective is not True
            ):
                errors.append(f"{case_id}: posted state requires approved effective exact read-back")
        elif state == "WRITE_RESULT_UNVERIFIED":
            if not has_execution or not write_attempted:
                errors.append(f"{case_id}: unverified result must follow a write attempt")
            if case.get("result_class") != "succeeded" or readback_verified:
                errors.append(f"{case_id}: unverified state needs a definitive write receipt only")
            if ledger_effective is True:
                errors.append(f"{case_id}: unverified result cannot have effective read-back")
            if not case.get("provider_object_ref_safe"):
                errors.append(f"{case_id}: successful unverified write needs provider object ref")
            readback_attempted = case.get("readback_attempted") is True
            readback_result_class = case.get("readback_result_class")
            if "ledger.object.read_exact" in capabilities:
                if not readback_attempted or readback_result_class not in {
                    "failed",
                    "partial",
                    "timeout",
                }:
                    errors.append(
                        f"{case_id}: available exact read-back must have a failed, partial, or timeout attempt"
                    )
            elif readback_attempted:
                errors.append(f"{case_id}: cannot attempt exact read-back without the capability")
        elif state == "OUTCOME_UNKNOWN":
            if not has_execution or not write_attempted:
                errors.append(f"{case_id}: unknown outcome must follow a write attempt")
            if case.get("result_class") != "outcome_unknown":
                errors.append(f"{case_id}: OUTCOME_UNKNOWN needs outcome_unknown result class")
            if case.get("idempotency_result") != "outcome_unknown":
                errors.append(f"{case_id}: unknown outcome needs recoverable idempotency state")
            if readback_verified:
                errors.append(f"{case_id}: unknown outcome cannot have success read-back")
            next_gate = case.get("next_gate")
            if "control.outcome.reconcile" in capabilities:
                if next_gate != "query_original_attempt":
                    errors.append(f"{case_id}: unknown outcome must query the original attempt")
            elif next_gate != "manual_investigation_no_resubmit":
                errors.append(
                    f"{case_id}: unknown outcome without query capability needs manual investigation"
                )
        elif state == "WRITE_RESULT_MISMATCH":
            if not has_execution or not write_attempted:
                errors.append(f"{case_id}: mismatch must follow a write attempt")
            if case.get("result_class") != "succeeded" or readback_verified:
                errors.append(f"{case_id}: mismatch requires succeeded write and failed comparison")
            if not case.get("provider_object_ref_safe") or not case.get("mismatch_fields"):
                errors.append(f"{case_id}: mismatch needs object ref and mismatch_fields")
            if ledger_effective is True:
                errors.append(f"{case_id}: mismatched read-back cannot be called effective verified")
        elif state == "EXECUTION_BLOCKED":
            if write_attempted:
                errors.append(f"{case_id}: blocked execution cannot write the ledger")
            if not case.get("blockers"):
                errors.append(f"{case_id}: blocked execution needs explicit blockers")
            if approval_verified and target_binding_verified and case.get("idempotency_result") != "conflict":
                errors.append(f"{case_id}: blocked case needs approval, target, or idempotency failure")
        elif state == "CLOSED_VERIFIED":
            required = {
                "ledger.report.trial_balance.read",
                "ledger.reconciliation.verify",
                "ledger.period.status.read",
                "ledger.period.lock",
                "control.approval.verify",
            }
            if "ledger_sor" not in roles or not required.issubset(capabilities):
                errors.append(f"{case_id}: complete close capability set is required")
            if (
                not case.get("close_controls_complete")
                or not approval_verified
                or not target_binding_verified
                or not readback_verified
                or ledger_effective is not True
            ):
                errors.append(f"{case_id}: closed state requires completed controls and read-back")
            if (
                case.get("period_status_readback") != "locked"
                or "lock_state" not in set(case.get("verified_fields", []))
            ):
                errors.append(f"{case_id}: closed state requires explicit locked-period read-back")
        else:
            errors.append(f"{case_id}: unknown connector expected_state {state!r}")

        if not case.get("forbidden_claims"):
            errors.append(f"{case_id}: forbidden_claims are required")

    if supplier_fingerprints != {"orchid-bill-1090-v1"}:
        errors.append(
            "connector cases must preserve one supplier-bill accounting judgment across providers"
        )
    return len(cases)


READ_EVIDENCE_FIELDS = (
    "fact_origin",
    "source_system",
    "destination_role",
    "capability_id",
    "tool_call_or_audit_ref",
    "bound_target_ref_safe",
    "organisation_display_name",
    "binding_revision",
    "capability_revision",
    "observed_at",
    "query_bounds",
    "completeness",
    "output_hash",
    "fact_paths",
)


def missing_read_evidence(read: dict, *, target_read: bool = False) -> list[str]:
    missing = [field for field in READ_EVIDENCE_FIELDS if not read.get(field)]
    if read.get("fact_origin") not in {"HOST_BOUND", "MCP_READ"}:
        missing.append("fact_origin:HOST_BOUND|MCP_READ")
    if read.get("destination_role") != "ledger_sor":
        missing.append("destination_role:ledger_sor")
    if not isinstance(read.get("fact_paths"), list) or not read.get("fact_paths"):
        missing.append("fact_paths:list")
    if target_read:
        if read.get("capability_id") != "ledger.target.resolve":
            missing.append("capability_id:ledger.target.resolve")
        if not read.get("base_currency"):
            missing.append("base_currency")
        paths = set(read.get("fact_paths", []))
        if not any("name" in path.lower() or "organisation" in path.lower() for path in paths):
            missing.append("fact_paths:organisation")
        if not any("currency" in path.lower() for path in paths):
            missing.append("fact_paths:base_currency")
    return sorted(set(missing))


def validate_provenance_cases(errors: list[str]) -> int:
    try:
        cases = json.loads(PROVENANCE_CASES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"cannot load provenance cases: {exc}")
        return 0

    seen: set[str] = set()
    for case in cases:
        case_id = case.get("case_id", "<missing>")
        if case_id in seen:
            errors.append(f"duplicate provenance case_id: {case_id}")
        seen.add(case_id)
        for field in (
            "scenario_scope",
            "requested_entity_label",
            "prior_context_entity",
            "host_bound_target_ref_safe",
            "host_binding_revision",
            "target_read",
            "ledger_reads",
            "expected_target_state",
            "ledger_scoped_use_allowed",
            "must_report",
            "forbidden_claims",
        ):
            if field not in case:
                errors.append(f"{case_id}: missing provenance-case field {field}")

        if case.get("scenario_scope") not in {
            "contract_simulation",
            "live_read_only_regression",
        }:
            errors.append(f"{case_id}: invalid provenance scenario_scope")
        if not case.get("must_report") or not case.get("forbidden_claims"):
            errors.append(f"{case_id}: must_report and forbidden_claims are required")
        if not isinstance(case.get("ledger_reads"), list):
            errors.append(f"{case_id}: ledger_reads must be a list")
            ledger_reads = []
        else:
            ledger_reads = case.get("ledger_reads", [])

        target_read = case.get("target_read")
        host_target = case.get("host_bound_target_ref_safe")
        host_revision = case.get("host_binding_revision")
        derived_state = "TARGET_UNVERIFIED"

        if (
            isinstance(target_read, dict)
            and "result" in target_read
            and missing_read_evidence(target_read, target_read=True)
        ):
            derived_state = "READ_EVIDENCE_REJECTED"
        elif isinstance(target_read, dict) and target_read.get("result_class") == "succeeded":
            target_missing = missing_read_evidence(target_read, target_read=True)
            if case.get("stale_after_binding_change") is True:
                derived_state = "TARGET_UNVERIFIED"
            elif target_missing:
                derived_state = "TARGET_UNVERIFIED"
            elif (
                not host_target
                or not host_revision
                or target_read.get("bound_target_ref_safe") != host_target
                or target_read.get("binding_revision") != host_revision
            ):
                derived_state = "TARGET_CONFLICT"
            else:
                derived_state = "TARGET_VERIFIED"
                for index, read in enumerate(ledger_reads, start=1):
                    if not isinstance(read, dict):
                        errors.append(f"{case_id}/ledger_read{index}: expected object")
                        derived_state = "READ_EVIDENCE_REJECTED"
                        continue
                    if read.get("result_class") != "succeeded":
                        continue
                    if (
                        read.get("bound_target_ref_safe")
                        and read.get("bound_target_ref_safe") != host_target
                    ) or (
                        read.get("binding_revision")
                        and read.get("binding_revision") != host_revision
                    ):
                        derived_state = "TARGET_CONFLICT"
                        break
                    if missing_read_evidence(read):
                        derived_state = "READ_EVIDENCE_REJECTED"
                        break

        expected_state = case.get("expected_target_state")
        if expected_state not in {
            "TARGET_UNVERIFIED",
            "TARGET_VERIFIED",
            "TARGET_CONFLICT",
            "READ_EVIDENCE_REJECTED",
        }:
            errors.append(f"{case_id}: unknown expected_target_state {expected_state!r}")
        elif expected_state != derived_state:
            errors.append(
                f"{case_id}: expected {expected_state}, derived {derived_state} from evidence"
            )

        allowed = case.get("ledger_scoped_use_allowed") is True
        if allowed != (derived_state == "TARGET_VERIFIED"):
            errors.append(
                f"{case_id}: ledger-scoped use must be allowed only for TARGET_VERIFIED"
            )

    required_cases = {
        "old_acme_context_without_target_read",
        "target_resolve_failed_or_empty",
        "target_resolve_succeeded_but_required_facts_empty",
        "current_target_overrides_old_conversation_label",
        "binding_switch_invalidates_old_target_result",
        "two_ledger_reads_have_different_targets",
        "ledger_read_missing_provenance_envelope",
        "bare_connector_result_cannot_be_promoted",
        "verified_target_and_matching_ledger_read",
    }
    missing_cases = required_cases - seen
    if missing_cases:
        errors.append(f"missing required provenance cases: {sorted(missing_cases)}")

    raw_cases = [case for case in cases if case.get("raw_connector_payload") is True]
    if not raw_cases:
        errors.append("missing raw connector payload provenance regression")
    for case in raw_cases:
        case_id = case.get("case_id", "<missing>")
        target_read = case.get("target_read")
        if not isinstance(target_read, dict) or set(target_read) != {"result"}:
            errors.append(f"{case_id}: raw connector fixture must be exactly a bare result payload")
            continue
        if not missing_read_evidence(target_read, target_read=True):
            errors.append(f"{case_id}: bare result unexpectedly satisfies normalized provenance")
        if case.get("fact_origin_upgrade_allowed") is not False:
            errors.append(f"{case_id}: bare result must forbid fact-origin promotion")
        if case.get("accepted_fact_origin") is not None:
            errors.append(f"{case_id}: bare result cannot be accepted as HOST_BOUND or MCP_READ")
        if case.get("expected_target_state") != "READ_EVIDENCE_REJECTED":
            errors.append(f"{case_id}: bare result must resolve to READ_EVIDENCE_REJECTED")
    return len(cases)


def validate_agent_orchestration_cases(errors: list[str]) -> int:
    try:
        suite = json.loads(ORCHESTRATION_CASES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"cannot load agent orchestration cases: {exc}")
        return 0

    routing_cases = suite.get("routing_cases", [])
    degradation_cases = suite.get("degradation_cases", [])
    if not isinstance(routing_cases, list) or not isinstance(degradation_cases, list):
        errors.append("agent orchestration suite must contain routing_cases and degradation_cases lists")
        return 0

    config_path = ROOT / "agent-config" / "accounting-agent-instructions.md"
    try:
        config = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"cannot load Accounting Agent instructions: {exc}")
        return 0

    mandatory_gate = "Treat Skill loading as a mandatory business-judgment gate."
    pre_tool_gate = (
        "Before answering an accounting request or calling a data/action capability, "
        "load the mounted Skill"
    )
    if mandatory_gate not in config:
        errors.append("Accounting Agent instructions: missing mandatory Skill-loading gate")
    if pre_tool_gate not in config:
        errors.append("Accounting Agent instructions: Skill loading must precede answers and connector use")

    prepare_route_lines = [
        line
        for line in config.splitlines()
        if "prepare-balanced-accounting-entry" in line
        and "load" in line.lower()
    ]
    seen: set[str] = set()
    for case in routing_cases:
        case_id = case.get("case_id", "<missing>")
        if case_id in seen:
            errors.append(f"duplicate agent routing case_id: {case_id}")
        seen.add(case_id)
        trigger = case.get("trigger_phrase")
        if not case.get("user_request") or not trigger:
            errors.append(f"{case_id}: user_request and trigger_phrase are required")
        elif trigger.lower() not in case.get("user_request", "").lower():
            errors.append(f"{case_id}: trigger_phrase is absent from user_request")
        if case.get("expected_skill") != "prepare-balanced-accounting-entry":
            errors.append(f"{case_id}: double-entry/journal intent must route to prepare Skill")
        if case.get("skill_load_required") is not True:
            errors.append(f"{case_id}: Skill loading must be mandatory")
        if case.get("connector_before_skill_allowed") is not False:
            errors.append(f"{case_id}: connector use cannot precede Skill loading")
        if trigger and not any(trigger.lower() in line.lower() for line in prepare_route_lines):
            errors.append(
                f"Accounting Agent instructions: trigger {trigger!r} is not routed to "
                "prepare-balanced-accounting-entry"
            )

    required_routing_cases = {
        "chinese_double_entry_routes_prepare",
        "chinese_journal_entry_routes_prepare",
        "english_journal_entry_routes_prepare",
    }
    missing_routing = required_routing_cases - seen
    if missing_routing:
        errors.append(f"missing required agent routing cases: {sorted(missing_routing)}")

    degradation_seen: set[str] = set()
    for case in degradation_cases:
        case_id = case.get("case_id", "<missing>")
        if case_id in degradation_seen:
            errors.append(f"duplicate agent degradation case_id: {case_id}")
        degradation_seen.add(case_id)
        labels = set(case.get("connector_labels", []))
        roles = set(case.get("destination_roles", []))
        capabilities = set(case.get("available_capabilities", []))
        if case.get("visible_fact_origin") != "USER_ASSERTED" or not case.get("visible_facts"):
            errors.append(f"{case_id}: user-visible USER_ASSERTED facts are required")
        if case.get("expected_skill") != "prepare-balanced-accounting-entry":
            errors.append(f"{case_id}: visible accounting facts must route to prepare Skill")
        if case.get("expected_state") != "BALANCED_PROPOSAL_IN_CHAT":
            errors.append(f"{case_id}: expected outcome must be an in-chat balanced proposal")
        if case.get("expected_persistence") != "unsaved":
            errors.append(f"{case_id}: regression requires an explicitly unsaved proposal")
        if case.get("proposal_allowed") is not True or case.get("blocked") is not False:
            errors.append(f"{case_id}: absence of a ledger connector must not block proposal preparation")
        if case.get("ledger_scoped_use_allowed") is not False:
            errors.append(f"{case_id}: unsaved proposal cannot use current-ledger facts")
        if "ledger_sor" in roles or any(capability.startswith("ledger.") for capability in capabilities):
            errors.append(f"{case_id}: no-ledger regression contains a ledger role or capability")
        if not case.get("forbidden_claims"):
            errors.append(f"{case_id}: forbidden_claims are required")
        if case_id.startswith("no_connector_") and (labels or roles or capabilities):
            errors.append(f"{case_id}: no-connector case must not expose a connector or capability")
        if case_id.startswith("drive_only_"):
            if labels != {"google_drive"}:
                errors.append(f"{case_id}: Drive-only case must expose only google_drive")
            if not roles or not roles.issubset({"source_store", "work_store"}):
                errors.append(f"{case_id}: Drive-only roles must remain source/work only")
            if "work.proposal.persist" in capabilities:
                errors.append(f"{case_id}: unsaved Drive-only regression cannot persist the proposal")

    required_degradation_cases = {
        "no_connector_visible_facts_allow_unsaved_proposal",
        "drive_only_visible_facts_allow_unsaved_proposal",
    }
    missing_degradation = required_degradation_cases - degradation_seen
    if missing_degradation:
        errors.append(
            f"missing required agent degradation cases: {sorted(missing_degradation)}"
        )

    for phrase in (
        "no connector: analyze visible facts and prepare an unsaved proposal",
        "source/work store only: read or preserve materials",
    ):
        if phrase not in config:
            errors.append(f"Accounting Agent instructions: missing graceful-degradation rule {phrase!r}")

    return len(routing_cases) + len(degradation_cases)


def validate_capability_registry(errors: list[str]) -> set[str]:
    contract_path = ROOT / "agent-config" / "capability-contract.md"
    try:
        contract = contract_path.read_text(encoding="utf-8")
        registry_section = contract.split("## Stable semantic capabilities", 1)[1].split(
            "## Effective capability manifest", 1
        )[0]
    except (OSError, IndexError) as exc:
        errors.append(f"cannot load capability registry: {exc}")
        return set()

    pattern = r"(?:connector|source|work|ledger|control)\.[a-z0-9_.]+"
    registry = set(re.findall(pattern, registry_section))
    if not registry:
        errors.append("capability registry is empty")
        return registry
    for phrase in (
        "connector_control_plane: connection_ref_safe, connection_state",
        "it is not an accounting destination and never proves a ledger target or ledger state",
    ):
        if phrase not in contract:
            errors.append(
                f"capability contract: missing connector-control-plane boundary {phrase!r}"
            )

    profile_root = ROOT / "agent-config" / "connector-profiles"
    required_profile_read_tools = {
        "xero.md": {
            "xero_connection_status",
            "xero_get_organisation",
            "xero_list_accounts",
            "xero_list_tax_rates",
            "xero_list_contacts",
            "xero_get_contact",
            "xero_search_contacts",
            "xero_list_invoices",
            "xero_list_credit_notes",
            "xero_list_payments",
            "xero_list_quotes",
            "xero_get_quote",
            "xero_list_purchase_orders",
            "xero_get_purchase_order",
            "xero_list_manual_journals",
            "xero_get_manual_journal",
            "xero_list_items",
            "xero_get_item",
            "xero_list_bank_transactions",
            "xero_get_bank_transaction",
            "xero_get_invoice",
            "xero_get_supplier_bill",
            "xero_get_trial_balance",
        },
        "quickbooks.md": {
            "quickbooks_connection_status",
            "quickbooks_get_company",
            "quickbooks_list_accounts",
            "quickbooks_list_tax_codes",
            "quickbooks_search_vendors",
            "quickbooks_search_customers",
            "quickbooks_list_items",
            "quickbooks_list_bills",
            "quickbooks_list_transactions",
            "quickbooks_get_bill",
            "quickbooks_get_transaction",
            "quickbooks_run_report",
            "quickbooks_get_trial_balance",
        },
    }
    for profile in sorted(profile_root.glob("*.md")):
        text = profile.read_text(encoding="utf-8")
        profile_capabilities = set(re.findall(pattern, text))
        unknown = profile_capabilities - registry
        if unknown:
            errors.append(
                f"{profile.relative_to(ROOT)}: unknown capability IDs {sorted(unknown)}"
            )
        if "| Tool | Capability ID | Supported object types | Control requirement" not in text:
            errors.append(f"{profile.relative_to(ROOT)}: missing executable mapping table")
        table_text = text.split("## Provider semantics", 1)[0]
        mapped_tools = set(re.findall(r"`((?:xero|quickbooks)_[a-z0-9_]+)`", table_text))
        missing_tools = required_profile_read_tools.get(profile.name, set()) - mapped_tools
        if missing_tools:
            errors.append(
                f"{profile.relative_to(ROOT)}: unmapped ordinary read tools {sorted(missing_tools)}"
            )
    return registry


def validate_skill_portability(errors: list[str]) -> None:
    forbidden = (
        "accountingV2",
        "zclock-ai-accounting-agency-demo",
        "xero_",
        "quickbooks_",
        "create_google_drive",
        "read_google_drive",
    )
    for skill_file in sorted(SKILLS_ROOT.glob("*/SKILL.md")):
        text = skill_file.read_text(encoding="utf-8")
        for phrase in forbidden:
            if phrase in text:
                errors.append(
                    f"{skill_file.relative_to(ROOT)}: provider/tool dependency leaked into Skill: {phrase}"
                )


def validate_skill_provenance(errors: list[str]) -> None:
    required = (
        "Treat any entity/company name from user text, remembered conversation, "
        "or an example as `USER_ASSERTED`"
    )
    for skill_file in sorted(SKILLS_ROOT.glob("*/SKILL.md")):
        text = skill_file.read_text(encoding="utf-8")
        if required not in text:
            errors.append(
                f"{skill_file.relative_to(ROOT)}: missing entity/ledger provenance gate"
            )

    policy_files = list(SKILLS_ROOT.rglob("*.md")) + list(
        (ROOT / "agent-config").rglob("*.md")
    )
    for path in sorted(policy_files):
        if re.search(r"\bacme\b", path.read_text(encoding="utf-8"), flags=re.IGNORECASE):
            errors.append(
                f"{path.relative_to(ROOT)}: synthetic ACME company leaked into runtime policy"
            )


def validate_packages(errors: list[str]) -> int:
    skill_dirs = sorted(path for path in SKILLS_ROOT.iterdir() if path.is_dir())
    for skill_dir in skill_dirs:
        zip_path = DEPLOY_ROOT / f"{skill_dir.name}.zip"
        if not zip_path.exists():
            errors.append(f"missing deploy package: deploy/{skill_dir.name}.zip")
            continue
        expected = {"SKILL.md", "agents/openai.yaml"}
        references = skill_dir / "references"
        if references.exists():
            expected.update(
                path.relative_to(skill_dir).as_posix()
                for path in references.rglob("*")
                if path.is_file()
            )
        with zipfile.ZipFile(zip_path) as zf:
            members = {name for name in zf.namelist() if not name.endswith("/")}
            if members != expected:
                errors.append(
                    f"{zip_path.relative_to(ROOT)}: members {sorted(members)} != {sorted(expected)}"
                )
                continue
            if zf.read("SKILL.md") != (skill_dir / "SKILL.md").read_bytes():
                errors.append(f"{zip_path.relative_to(ROOT)}: SKILL.md differs from source")
            if zf.read("agents/openai.yaml") != (
                skill_dir / "agents" / "openai.yaml"
            ).read_bytes():
                errors.append(
                    f"{zip_path.relative_to(ROOT)}: agents/openai.yaml differs from source"
                )
            for member in expected - {"SKILL.md", "agents/openai.yaml"}:
                if zf.read(member) != (skill_dir / member).read_bytes():
                    errors.append(f"{zip_path.relative_to(ROOT)}: {member} differs from source")
            agent_yaml = zf.read("agents/openai.yaml").decode("utf-8")
            if f"${skill_dir.name}" not in agent_yaml:
                errors.append(f"{zip_path.relative_to(ROOT)}: default prompt misses ${skill_dir.name}")
            if "\ndependencies:" in agent_yaml:
                errors.append(
                    f"{zip_path.relative_to(ROOT)}: business Skill must not hard-code an MCP dependency"
                )
    return len(skill_dirs)


def main() -> None:
    errors: list[str] = []
    validate_frontmatter(errors)
    validate_skill_portability(errors)
    validate_skill_provenance(errors)
    require_text(
        errors,
        PREPARE_SKILL / "SKILL.md",
        [
            "source record",
            "balanced proposal",
            "posted",
            "reconciled",
            "closed",
            "total debits to equal total credits",
            "bank statement's `debit/credit` label",
            "Do not double count",
            "Do not call a draft batch control a Trial Balance",
        ],
    )
    require_text(
        errors,
        SKILLS_ROOT / "accounting-workflow-coordinator" / "SKILL.md",
        [
            "prepare-balanced-accounting-entry",
            "execute-approved-accounting-entry",
            "## Capability-first execution",
            "review register, not a general ledger",
        ],
    )
    require_text(
        errors,
        EXECUTE_SKILL / "SKILL.md",
        [
            "Route by semantic capability",
            "PROPOSAL_SAVED_OUTSIDE_LEDGER",
            "POSTED_READBACK_VERIFIED",
            "ledger-effective state",
            "source/work-store receipt",
        ],
    )
    require_text(
        errors,
        SKILLS_ROOT / "cash-reconciliation" / "SKILL.md",
        ["Do not treat that label as the general-ledger side", "statement debit that reduces cash"],
    )
    require_text(
        errors,
        SKILLS_ROOT / "close-readiness-handoff" / "SKILL.md",
        ["## Double-entry and close controls", "balanced Trial Balance as insufficient"],
    )
    require_text(
        errors,
        ROOT / "agent-config" / "accounting-agent-instructions.md",
        [
            "prepare-balanced-accounting-entry",
            "execute-approved-accounting-entry",
            "source store, work/review store, or formal accounting ledger",
            "USER_ASSERTED",
            "ledger.target.resolve",
            "current ledger target is unverified",
            "posted and read back",
            "reconciled",
            "closed",
        ],
    )
    reject_text(
        errors,
        ROOT / "agent-config" / "accounting-agent-instructions.md",
        [
            "accountingV2",
            "zclock-ai-accounting-agency-demo",
            "xero_",
            "quickbooks_",
            "create_google_drive",
        ],
    )
    require_text(
        errors,
        ROOT / "agent-config" / "capability-contract.md",
        [
            "Skills contain provider-neutral business judgment",
            "source_store",
            "work_store",
            "ledger_sor",
            "TARGET_UNVERIFIED",
            "TARGET_CONFLICT",
            "READ_EVIDENCE_REJECTED",
            "tool_call_or_audit_ref",
            "binding_revision",
            "fact_paths[]",
            "ledger.transaction.native.execute",
            "control.approval.verify",
            "ledger_effective=true",
        ],
    )
    require_text(
        errors,
        ROOT / "agent-config" / "mcp-tool-allowlist.md",
        ["There is no universal MCP-name allowlist", "connector-profiles/xero.md"],
    )
    capability_registry = validate_capability_registry(errors)
    case_count = validate_cases(errors)
    connector_case_count = validate_capability_cases(errors, capability_registry)
    provenance_case_count = validate_provenance_cases(errors)
    orchestration_case_count = validate_agent_orchestration_cases(errors)
    skill_count = validate_packages(errors)
    if errors:
        fail(errors)
    print(
        f"Validation passed: {skill_count} Accounting Agent Skills, "
        f"{case_count} double-entry cases, {connector_case_count} connector cases, "
        f"{provenance_case_count} provenance cases, "
        f"{orchestration_case_count} agent orchestration cases, "
        "and matching deploy packages."
    )


if __name__ == "__main__":
    main()
