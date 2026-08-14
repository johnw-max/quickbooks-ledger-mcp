#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const scenarioPath = resolve(process.argv[2] ?? `${here}/real-accountant-qbo-v1.scenario.json`);
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function unique(values) {
  return new Set(values).size === values.length;
}

function sorted(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right), "en"));
}

function sameSet(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

let scenario;
try {
  scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
} catch (error) {
  console.error(`SCENARIO_JSON_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

assert(scenario.schemaVersion === "qbo-real-accountant-uat/v1", "unexpected schemaVersion");
assert(scenario.target?.provider === "quickbooks", "target provider must be quickbooks");
assert(scenario.target?.environment === "QUICKBOOKS_SANDBOX_ONLY", "only QuickBooks Sandbox is allowed");
assert(
  scenario.target?.mcpEndpoint === "https://mcp.jiayuanwang.xyz/quickbooks/mcp",
  "current QuickBooks MCP endpoint is required",
);
assert(scenario.target?.onlineHost?.baseUrl === "https://work.zcloak.ai", "current Work base URL is required");
assert(scenario.target?.onlineHost?.modelDisplayName === "DeepSeek V4", "Work model fixture drifted");
assert(scenario.target?.mcpIsolation?.quickBooksAndXeroAreSeparateMcps === true, "QuickBooks and Xero must be separate MCPs");
assert(
  scenario.sourceProvenance?.allBusinessNamesAndIdentifiersAreFictitious === true,
  "the pack must remain explicitly synthetic",
);
assert(scenario.sourceProvenance?.originalFilesCommitted === false, "original source files must not be committed");
assert(
  scenario.sourceProvenance?.colleagueIdentityOrMetadataIncluded === false,
  "colleague identity or author metadata must not be included",
);

const serialized = JSON.stringify(scenario);
for (const prohibited of [
  "offbeatlab",
  "drive.google.com",
  "docs.google.com",
  "agent_AI",
  "oauth_access_token",
  "refresh_token=",
]) {
  assert(!serialized.includes(prohibited), `prohibited source or secret marker found: ${prohibited}`);
}

const artifacts = Array.isArray(scenario.artifactManifest) ? scenario.artifactManifest : [];
assert(artifacts.length === 14, `artifactManifest must contain exactly 14 artifacts, found ${artifacts.length}`);
const artifactIds = artifacts.map((artifact) => artifact.artifactId);
assert(unique(artifactIds), "artifact IDs must be unique");
const uploadSlots = artifacts.map((artifact) => artifact.uploadSlot);
assert(sameSet(uploadSlots, Array.from({ length: 14 }, (_, index) => index + 1)), "upload slots must be exactly 1..14");
assert(unique(artifacts.map((artifact) => artifact.sha256Env)), "SHA-256 environment placeholders must be unique");
for (const artifact of artifacts) {
  assert(
    artifact.sha256Env === `QBO_UAT_ARTIFACT_${String(artifact.uploadSlot).padStart(2, "0")}_SHA256`,
    `${artifact.artifactId}: SHA placeholder does not match upload slot`,
  );
  assert(artifact.sourceBranding === "XERO_TEST_PACK", `${artifact.artifactId}: expected cross-ledger source branding`);
  assert(Array.isArray(artifact.sourceUnits) && artifact.sourceUnits.length > 0, `${artifact.artifactId}: source units missing`);
  for (const unit of artifact.sourceUnits ?? []) {
    assert(typeof unit.terminalDisposition === "string" && unit.terminalDisposition.length > 0,
      `${artifact.artifactId}/${unit.unitId}: terminal disposition missing`);
    if (String(unit.terminalDisposition).startsWith("BLOCKED_UNSUPPORTED") ||
        unit.terminalDisposition === "BLOCKED_SCHEMA_GAP_EXCHANGE_RATE") {
      assert(unit.expectedFactKinds?.includes("UNSUPPORTED_EVENT"),
        `${artifact.artifactId}/${unit.unitId}: unsupported blocker requires typed UNSUPPORTED_EVENT`);
    }
  }
}
const unitIds = artifacts.flatMap((artifact) => (artifact.sourceUnits ?? []).map((unit) => unit.unitId));
assert(unique(unitIds), "source unit IDs must be globally unique");

const artifactSet = new Set(artifactIds);
const chains = Array.isArray(scenario.businessChains) ? scenario.businessChains : [];
assert(sameSet(chains.map((chain) => chain.chainId), ["AR", "AP", "EXPENSE", "FX"]), "business chains must be AR/AP/EXPENSE/FX");
for (const chain of chains) {
  for (const artifactId of chain.artifactIds ?? []) {
    assert(artifactSet.has(artifactId), `${chain.chainId}: unknown artifact ${artifactId}`);
  }
}
const referencedByAChain = new Set(chains.flatMap((chain) => chain.artifactIds ?? []));
for (const artifactId of artifactIds) {
  assert(referencedByAChain.has(artifactId), `${artifactId}: no business-chain oracle references this artifact`);
}

const cases = Array.isArray(scenario.cases) ? scenario.cases : [];
assert(cases.length >= 1, "at least one executable case is required");
assert(unique(cases.map((testCase) => testCase.caseId)), "case IDs must be unique");
const primary = cases.find((testCase) => testCase.caseId === "QBO-RA-E2E-01");
assert(primary !== undefined, "primary case QBO-RA-E2E-01 is missing");
const turns = primary?.turns ?? [];
assert(turns.length === 16, `primary case must contain exactly 16 turns, found ${turns.length}`);
assert(unique(turns.map((turn) => turn.turnId)), "turn IDs must be unique");
assert(
  JSON.stringify(turns.map((turn) => turn.turnId)) ===
    JSON.stringify(Array.from({ length: 16 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`)),
  "turn IDs must be ordered T01..T16",
);
assert(sameSet([...new Set(turns.map((turn) => turn.operation))], ["read", "prepare", "write"]),
  "turn operations must cover read, prepare and write");
for (const turn of turns) {
  assert(["read", "prepare", "write"].includes(turn.operation), `${turn.turnId}: invalid operation`);
  assert(typeof turn.user === "string" && turn.user.length > 0, `${turn.turnId}: user text missing`);
  assert(Array.isArray(turn.attachments), `${turn.turnId}: attachments must be an array`);
  for (const artifactId of turn.attachments ?? []) {
    assert(artifactSet.has(artifactId), `${turn.turnId}: unknown attachment ${artifactId}`);
  }
  for (const key of ["required", "allowed", "forbidden"]) {
    assert(Array.isArray(turn.toolOracle?.[key]), `${turn.turnId}: toolOracle.${key} must be an array`);
  }
  assert(Array.isArray(turn.responseOracle?.mustState) && turn.responseOracle.mustState.length > 0,
    `${turn.turnId}: responseOracle.mustState is required`);
  assert(Array.isArray(turn.responseOracle?.mustNotClaim), `${turn.turnId}: responseOracle.mustNotClaim must be an array`);
}

const firstBatch = turns.find((turn) => turn.turnId === "T04")?.attachments ?? [];
const secondBatch = turns.find((turn) => turn.turnId === "T05")?.attachments ?? [];
assert(firstBatch.length === 10, "T04 must upload exactly the first 10 artifacts");
assert(secondBatch.length === 4, "T05 must upload exactly the remaining four artifacts");
assert(sameSet([...firstBatch, ...secondBatch], artifactIds), "the two upload batches must cover all 14 artifacts exactly once");
assert((turns.find((turn) => turn.turnId === "T03")?.user ?? "").includes("十四个"), "batched-upload habit missing");
assert((turns.find((turn) => turn.turnId === "T05")?.user ?? "").includes("as attached"), "mixed Chinese/English habit missing");
assert((turns.find((turn) => turn.turnId === "T06")?.user ?? "").includes("啥意思？怎么报错了？"), "informal error question missing");
assert((turns.find((turn) => turn.turnId === "T08")?.user ?? "").includes("一次补充和纠正十二点"), "twelve-fact correction turn missing");
assert((turns.find((turn) => turn.turnId === "T11")?.user ?? "").includes("不能只看总计行"), "row-level validation challenge missing");
assert((turns.find((turn) => turn.turnId === "T11")?.user ?? "").includes("逐行借贷合计"), "debit-credit evidence challenge missing");
assert((turns.find((turn) => turn.turnId === "T12")?.user ?? "").includes("opening balance 10000"), "missing-item challenge missing");

const supportedPlanSources = scenario.casePlanOracle?.supportedCase?.sourceArtifactIds ?? [];
const residualPlanSources = scenario.casePlanOracle?.blockedResidualCase?.sourceArtifactIds ?? [];
assert(sameSet([...supportedPlanSources, ...residualPlanSources], artifactIds), "supported and residual cases must partition all 14 artifacts");
assert(scenario.casePlanOracle?.blockedResidualCase?.expectedOperationCount === 0, "residual case must have zero operations");
assert(scenario.casePlanOracle?.blockedResidualCase?.mustNotExecute === true, "residual case must not execute");

const supportedWrites = Array.isArray(scenario.supportedWriteOracles) ? scenario.supportedWriteOracles : [];
assert(sameSet(supportedWrites.map((oracle) => oracle.entity), [
  "Customer",
  "Vendor",
  "Invoice",
  "Bill",
  "CreditMemo",
  "VendorCredit",
]), "supported write oracle set drifted");
for (const oracle of supportedWrites) {
  assert(oracle.duplicateMaximum === 1, `${oracle.entity}: duplicateMaximum must be 1`);
  assert(oracle.expectedReadback && Object.keys(oracle.expectedReadback).length > 0, `${oracle.entity}: exact readback oracle missing`);
}
const vendorCredit = supportedWrites.find((oracle) => oracle.entity === "VendorCredit");
assert(vendorCredit?.expectedReadback?.["Line[0].Amount"] === "80.00", "VendorCredit line must be 80.00");
assert(vendorCredit?.forbiddenReadback?.["Line[0].Amount"] === "800.00", "VendorCredit 800.00 negative oracle missing");

const unsupported = Array.isArray(scenario.unsupportedActionOracles) ? scenario.unsupportedActionOracles : [];
assert(unsupported.length >= 8, "unsupported action coverage is incomplete");
for (const oracle of unsupported) {
  assert(oracle.currentAccountingCaseReleased === false, `${oracle.businessEvent}: must stay outside the released Case`);
  assert(oracle.mustNotWrite === true, `${oracle.businessEvent}: mustNotWrite must be true`);
  assert(String(oracle.expectedDisposition).startsWith("BLOCKED_"), `${oracle.businessEvent}: blocker disposition required`);
}

assert(scenario.factRevisionOracle?.invalidRevision?.providerCallDelta === 0, "invalid correction path must make zero provider calls");
assert(scenario.factRevisionOracle?.invalidRevision?.lineUnitAmount === "800.00", "invalid 800 revision missing");
assert(scenario.factRevisionOracle?.correctedRevision?.lineUnitAmount === "80.00", "corrected 80 revision missing");

const replay = (scenario.negativeScenarios ?? []).find((entry) => entry.scenarioId === "QBO-RA-NEG-06");
assert(replay?.providerCreateDelta === 0, "idempotent replay must create zero new provider records");
assert(replay?.providerIdsMustRemainIdentical === true, "idempotent replay must preserve provider IDs");

const residualCase = scenario.casePlanOracle?.blockedResidualCase;
assert(residualCase?.expectedOperationCount === 0, "residual evidence Case must have zero operations");
assert(residualCase?.mustNotExecute === true, "residual evidence Case must never execute");
assert(residualCase?.mustBePreparedByTurn === "T10", "residual evidence Case must be durable by T10");
assert(sameSet(residualCase?.mustBeQueriedAtTurns ?? [], ["T10", "T12", "T14", "T16"]),
  "residual evidence Case must be queried at every residual/completion checkpoint");

const requiredGates = scenario.acceptanceGates?.passRule?.requiredGateResults ?? [];
assert(sameSet(requiredGates, [
  "SCENARIO_SCHEMA_VALID",
  "LOCAL_MCP_CONTRACT_PASS",
  "LOCAL_AGENT_BEHAVIOR_PASS",
  "WORK_DEEPSEEK_V4_ONLINE_UAT_PASS",
]), "acceptance gates must keep local contract, local Agent and Work online evidence separate");
assert(scenario.acceptanceGates?.localAgent?.scriptedToolCallsOnlyClassification === "MCP_CONTRACT_ONLY_NOT_AGENT_BEHAVIOR_PASS",
  "scripted MCP calls must not count as Agent behavior acceptance");
assert(scenario.acceptanceGates?.onlineHost?.runOnlyAfterLocalPass === true, "Work must run only after local pass");
assert(scenario.acceptanceGates?.onlineHost?.modelDisplayName === "DeepSeek V4", "Work final model must be DeepSeek V4");

if (failures.length > 0) {
  console.error(`SCENARIO_SEMANTIC_INVALID (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  result: "SCENARIO_SCHEMA_VALID",
  scenario: scenarioPath,
  artifacts: artifacts.length,
  sourceUnits: unitIds.length,
  cases: cases.length,
  turns: turns.length,
  supportedWriteOracles: supportedWrites.length,
  unsupportedActionOracles: unsupported.length,
}, null, 2));
