# Agent-under-test acceptance loop

## Why this exists

Earlier local acceptance runs had one role playing both sides: the same context
wrote the accountant's turns and decided the agent's tool calls. That cannot
falsify the agent -- it can only confirm whatever the author already believed.
This harness is ported from the Xero MCP repo's agent-under-test loop, which
solved the same problem there; both ledger MCPs share the same control
architecture (governed Accounting Case writes, target-session pinning, a
provider double at the SDK boundary), so the acceptance loop ports across
almost mechanically.

This harness restores the separation without depending on any one vendor:

| Role | Who | Sees |
|---|---|---|
| Product agent | a subagent, cold context | mounted instructions + Skills + the MCP tool surface. **Never the repository.** |
| Accountant | the supervising session | the source documents and the business intent |
| Oracle | the server audit | tool calls, provider write count, redacted arguments, error/reason codes |

The agent under test is mounted under a temporary root, so "it did not read the
source" is checkable rather than promised: any repository path appearing in its
transcript is a protocol violation and invalidates the run.

## Running one conversation

```bash
node harness/agent-under-test/mount-agent-workspace.mjs
```

Prints a manifest with the ephemeral workspace, the mounted Skill paths, the
`step_dir` the agent drives the MCP through, and the `server_audit` path. One
server lives for one conversation so state is shared across turns, exactly as a
real session would be.

Spawn the product agent with the mounted paths and the driver protocol, give it
the accountant's first turn, then continue the same agent for each later turn so
its context persists. Stop the conversation by touching `STOP` in `step_dir`;
the audit is written after every tool call, so it is already current by the
time the server exits.

The driver protocol: write `NNN-request.json` into `step_dir` (`{ "params":
{ "name": "<tool>", "arguments": {...} } }`, `method` defaults to
`tools/call`), and the running server-under-drive answers with
`NNN-response.json` next to it. `000-initialize.json` is written once at
startup and lists the live tool surface.

## What the oracle checks

The audit, not the agent's prose, decides the outcome:

- `provider_write_count` against what the scenario expected -- this is the
  single most important number. It is read directly from the synthetic
  provider double (`SyntheticQuickBooksProvider#mutationCount`) after every
  tool call, never inferred from how many times the agent called
  `quickbooks_execute_accounting_case`. The production Case service
  short-circuits an already-terminal operation before it reaches the
  provider, so a same-`request_id` replay must leave this number unchanged;
  counting tool calls instead of provider creates would hide exactly that
  failure mode.
- every write in `quickbooks_execute_accounting_case`'s result carries a
  `provider_entity_id`, a receipt, and an exact same-ID readback whose
  economic fields match what was proposed;
- refusals carry the expected `error.code`, `failure_layer`, and
  `reasonCodes`, and `provider_mutation_possible: false` unless the failure
  happened after dispatch;
- the agent never claimed a state the audit does not support.

An agent that produces a correct-looking narrative while the audit shows no
write, a second write, or a missing readback has failed, regardless of how
convincing the narrative is.

## What is mounted

From `agent-skills/accounting-double-entry-skills-2026-08-10/`:

- Skills: `prepare-balanced-accounting-entry`, `execute-approved-accounting-entry`,
  `singapore-gst-ledger-mapping` -- the same provider-agnostic double-entry and
  GST-mapping knowledge the Xero build mounts, because that knowledge lives in
  Skills, not in the MCP (see ADR-002: the MCP verifies but never judges).
- agent-config: `accounting-agent-instructions.md`, `capability-contract.md`,
  and `connector-profiles/quickbooks.md` -- the connector profile is the only
  QuickBooks-specific piece; everything else is shared with Xero.

`mount-agent-workspace.mjs` fails before starting anything, with the exact
missing path named in the error, if that vendored package is not present. It
never falls back to mounting an empty or partial workspace.

## The loop

```
mount → converse → read audit → triage findings → fix → re-mount → converse
```

Each iteration's raw step files and the server audit live under the run's
ephemeral workspace. A finding is only closed when a later run reproduces the
same scenario and the audit shows the corrected behaviour -- never on the
strength of a code change alone.

Fix at the first failing layer: mounted Skill wording, agent instructions, tool
schema, or the runtime. Do not fix a runtime refusal by softening the Skill into
avoiding the case, and never relax a control to make a conversation succeed --
a refusal that surprised the agent is usually the control working.
