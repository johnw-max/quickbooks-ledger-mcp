import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

/**
 * Server-side evidence for the agent-under-test acceptance loop (see
 * harness/agent-under-test/README.md). The oracle that decides pass/fail is
 * this audit, not the agent's transcript, so every tool call the wrapped
 * transport observes must leave a durable, redacted record here.
 *
 * provider_write_count is read from the synthetic provider double itself
 * (SyntheticQuickBooksProvider#mutationCount) on every response, never
 * derived from counting quickbooks_execute_accounting_case calls. The Case
 * service short-circuits an already-terminal operation before it ever
 * reaches the provider, so a replay of the same request_id must not move
 * this number -- counting tool calls instead of provider creates would miss
 * that distinction entirely.
 */

export interface LocalAgentServerAuditToolCall {
  server_call_id: string;
  jsonrpc_id: string | number;
  tool: string;
  arguments: Record<string, unknown>;
  started_at: string;
  finished_at: string;
  status: "PASS" | "FAIL";
  error_code: string | number | null;
  error_message: string | null;
  failure_layer: string | null;
  provider_mutation_possible: boolean | null;
  recovery_action: string | null;
  reason_codes: string[] | null;
  provider_write_count_after: number;
}

export interface LocalAgentServerAudit {
  schema_version: "1.0";
  evidence_boundary: "LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY";
  release_version: string;
  server_pid: number;
  write_enabled: boolean;
  started_at: string;
  updated_at: string;
  tool_calls: LocalAgentServerAuditToolCall[];
  provider_write_count: number;
  provider_mutation_request_count: number;
}

/** The slice of SyntheticQuickBooksProvider this tap actually depends on. */
export interface LocalAgentAuditedProvider {
  readonly mutationCount: number;
  mutationRequestCount(): number;
}

export interface LocalAgentServerAuditOptions {
  auditPath: string;
  provider: LocalAgentAuditedProvider;
  releaseVersion: string;
  writeEnabled: boolean;
}

const TARGET_SESSION_REF_PATTERN = /qbts_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu;
const SENSITIVE_KEY_PATTERN = /^(?:access_token|refresh_token|token|authorization|secret|password|api_key|client_secret)$/iu;

/** Redacts opaque target-session capabilities and anything shaped like a credential. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (typeof value === "string") {
    return value.replace(TARGET_SESSION_REF_PATTERN, "<redacted-target-session-ref>");
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([field, child]) => [
      field,
      SENSITIVE_KEY_PATTERN.test(field) ? "<redacted>" : redact(child),
    ]),
  );
}

function redactedArguments(value: unknown): Record<string, unknown> {
  const redacted = redact(value ?? {});
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
}

interface ToolErrorPayload {
  code?: unknown;
  message?: unknown;
  failure_layer?: unknown;
  provider_mutation_possible?: unknown;
  recovery_action?: unknown;
  details?: unknown;
}

/**
 * `isError: true` is the only reliable failure signal on a CallToolResult.
 *
 * Two shapes carry it. This project's own `failure()` helper (src/quickbooks/mcp.ts)
 * attaches a structured error envelope. The MCP SDK's *input* validation runs before
 * the handler and never reaches that helper, so it returns `isError: true` with a bare
 * text content and no `structuredContent`. Treating a missing envelope as success made
 * every schema rejection audit as PASS — the single failure an agent learning a strict
 * schema hits most often, and the one an oracle must never record as clean.
 */
function isToolErrorResult(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && !Array.isArray(result) &&
    (result as Record<string, unknown>).isError === true);
}

function toolErrorFromResult(result: unknown): ToolErrorPayload | undefined {
  if (!isToolErrorResult(result)) return undefined;
  const structured = (result as Record<string, unknown>).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const error = (structured as Record<string, unknown>).error;
  return error && typeof error === "object" && !Array.isArray(error) ? error as ToolErrorPayload : undefined;
}

/** Text of an unenveloped tool failure, so the audit still records what was refused. */
function unenvelopedToolErrorText(result: unknown): string | undefined {
  if (!isToolErrorResult(result)) return undefined;
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).text : undefined)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return text;
}

function reasonCodesFrom(error: ToolErrorPayload | undefined): string[] | null {
  const details = error?.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const codes = (details as Record<string, unknown>).reasonCodes;
  return Array.isArray(codes) && codes.every((code) => typeof code === "string") ? codes as string[] : null;
}

interface PendingToolCall {
  jsonrpc_id: string | number;
  tool: string;
  arguments: Record<string, unknown>;
  started_at: string;
}

interface LocalAgentProtocolObserver {
  receive(message: JSONRPCMessage): void;
  send(message: JSONRPCMessage): Promise<void>;
}

/**
 * Harness-only transport tap; production MCP behavior is unchanged.
 *
 * Deliberately not `implements Transport`: the SDK's `sessionId?: string`
 * combined with this repo's `exactOptionalPropertyTypes` rejects a getter
 * typed `string | undefined` passing through a possibly-undefined inner
 * value (an optional property may be absent, but exactOptionalPropertyTypes
 * forbids a present key whose value is literally undefined). The existing
 * harness works around the same SDK-shape issue with a cast at the
 * `server.connect()` boundary (see serve-synthetic-quickbooks-http.ts and
 * tests/quickbooks-synthetic-agent-harness.test.ts); withLocalAgentServerAudit
 * below follows that precedent instead of inventing a new one.
 */
class AuditedLocalAgentTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: Transport,
    private readonly observer: LocalAgentProtocolObserver,
  ) {
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message, extra) => {
      this.observer.receive(message);
      this.onmessage?.(message, extra);
    };
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.observer.send(message);
    await this.inner.send(message, options);
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
}

/**
 * Wraps a transport with a JSON-RPC tap that records every tools/call
 * request/response pair to LOCAL_AGENT_SERVER_AUDIT_PATH. Generic over any
 * MCP transport (stdio here, but also HTTP or in-memory) because it observes
 * only wire messages, never service internals -- the same approach the Xero
 * acceptance harness uses, so both ledger MCPs produce audits under the same
 * evidence model.
 */
export function withLocalAgentServerAudit(inner: Transport, options: LocalAgentServerAuditOptions): Transport {
  const audit: LocalAgentServerAudit = {
    schema_version: "1.0",
    evidence_boundary: "LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY",
    release_version: options.releaseVersion,
    server_pid: process.pid,
    write_enabled: options.writeEnabled,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tool_calls: [],
    provider_write_count: options.provider.mutationCount,
    provider_mutation_request_count: options.provider.mutationRequestCount(),
  };

  async function persistAudit(): Promise<void> {
    audit.provider_write_count = options.provider.mutationCount;
    audit.provider_mutation_request_count = options.provider.mutationRequestCount();
    audit.updated_at = new Date().toISOString();
    await mkdir(dirname(options.auditPath), { recursive: true });
    await writeFile(options.auditPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  const pending = new Map<string, PendingToolCall>();
  const callKey = (id: string | number) => `${typeof id}:${String(id)}`;
  let callSequence = 0;

  const observer: LocalAgentProtocolObserver = {
    receive(message) {
      const request = message as unknown as {
        id?: string | number;
        method?: string;
        params?: { name?: unknown; arguments?: unknown };
      };
      if (request.method !== "tools/call" ||
          (typeof request.id !== "string" && typeof request.id !== "number") ||
          typeof request.params?.name !== "string") {
        return;
      }
      pending.set(callKey(request.id), {
        jsonrpc_id: request.id,
        tool: request.params.name,
        arguments: redactedArguments(request.params.arguments),
        started_at: new Date().toISOString(),
      });
    },
    async send(message) {
      const response = message as unknown as { id?: string | number; result?: unknown; error?: unknown };
      if (typeof response.id !== "string" && typeof response.id !== "number") return;
      const call = pending.get(callKey(response.id));
      if (!call) return;
      pending.delete(callKey(response.id));

      const protocolError = response.error && typeof response.error === "object" && !Array.isArray(response.error)
        ? response.error as { code?: unknown; message?: unknown }
        : undefined;
      const toolError = protocolError ? undefined : toolErrorFromResult(response.result);
      const unenvelopedToolError = protocolError || toolError
        ? undefined
        : unenvelopedToolErrorText(response.result);
      const failed = protocolError !== undefined ||
        (!protocolError && isToolErrorResult(response.result));
      callSequence += 1;

      audit.tool_calls.push({
        server_call_id: `local_mcp_${String(callSequence).padStart(5, "0")}`,
        jsonrpc_id: call.jsonrpc_id,
        tool: call.tool,
        arguments: call.arguments,
        started_at: call.started_at,
        finished_at: new Date().toISOString(),
        status: failed ? "FAIL" : "PASS",
        error_code: typeof protocolError?.code === "number" || typeof protocolError?.code === "string"
          ? protocolError.code
          : typeof toolError?.code === "string" ? toolError.code
            : unenvelopedToolError !== undefined ? "TOOL_ERROR_WITHOUT_ENVELOPE" : null,
        error_message: typeof protocolError?.message === "string"
          ? protocolError.message
          : typeof toolError?.message === "string" ? toolError.message
            : unenvelopedToolError ?? null,
        failure_layer: typeof toolError?.failure_layer === "string" ? toolError.failure_layer : null,
        provider_mutation_possible: typeof toolError?.provider_mutation_possible === "boolean"
          ? toolError.provider_mutation_possible
          : null,
        recovery_action: typeof toolError?.recovery_action === "string" ? toolError.recovery_action : null,
        reason_codes: reasonCodesFrom(toolError),
        provider_write_count_after: options.provider.mutationCount,
      });
      await persistAudit();
    },
  };

  void persistAudit();
  return new AuditedLocalAgentTransport(inner, observer) as unknown as Transport;
}
