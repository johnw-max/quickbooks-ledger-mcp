import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createSyntheticQuickBooksHarnessRuntime } from "./syntheticQuickBooksRuntime.js";

const rawPort = process.env.QUICKBOOKS_SYNTHETIC_HTTP_PORT ?? "3310";
const port = Number(rawPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("QUICKBOOKS_SYNTHETIC_HTTP_PORT must be an integer from 1 to 65535.");
}

const runtime = createSyntheticQuickBooksHarnessRuntime({
  writeEnabled: process.env.QUICKBOOKS_SYNTHETIC_CASE_WRITE_ENABLED !== "false",
});
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
app.use((request, response, next) => {
  if (!request.headers.host || !allowedHosts.has(request.headers.host) || request.headers.origin) {
    response.status(403).json({ error: "Synthetic MCP accepts non-browser loopback requests only." });
    return;
  }
  next();
});

interface Session {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof runtime.createServer>;
  lastSeenAt: number;
}
const sessions = new Map<string, Session>();
const sessionIdleTtlMs = 15 * 60_000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - sessionIdleTtlMs;
  for (const [sessionId, session] of sessions) {
    if (session.lastSeenAt >= cutoff) continue;
    sessions.delete(sessionId);
    void session.transport.close();
    void session.server.close();
  }
}, 60_000);
cleanupTimer.unref();

app.get("/healthz", (_, response) => {
  response.json({
    status: "ok",
    provider: "synthetic-quickbooks-online",
    transport: "streamable-http",
    writeEnabled: runtime.writeEnabled,
    mutationCount: runtime.provider.mutationCount,
    mutationRequestCount: runtime.provider.mutationRequestCount(),
    activeMcpSessions: sessions.size,
  });
});

app.all("/quickbooks/mcp", async (request, response) => {
  const sessionHeader = request.headers["mcp-session-id"];
  const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;
  let session = sessionId ? sessions.get(sessionId) : undefined;
  if (session) session.lastSeenAt = Date.now();
  if (!session && !sessionId && request.method === "POST" && isInitializeRequest(request.body)) {
    const server = runtime.createServer();
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (initializedId) => {
        sessions.set(initializedId, { transport, server, lastSeenAt: Date.now() });
      },
      onsessionclosed: (closedId) => {
        sessions.delete(closedId);
        void server.close();
      },
    });
    transport.onclose = () => {
      const initializedId = transport.sessionId;
      if (initializedId) sessions.delete(initializedId);
      void server.close();
    };
    await server.connect(transport as unknown as Transport);
    session = { transport, server, lastSeenAt: Date.now() };
  }
  if (!session) {
    response.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No valid MCP session. Initialize first or supply mcp-session-id." },
      id: null,
    });
    return;
  }
  try {
    await session.transport.handleRequest(request, response, request.body);
  } catch (error) {
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: error instanceof Error ? error.message : "Synthetic MCP failure" },
        id: null,
      });
    }
  }
});

const listener = app.listen(port, "127.0.0.1", () => {
  process.stderr.write(`Synthetic QuickBooks MCP listening on http://127.0.0.1:${port}/quickbooks/mcp\n`);
});

async function shutdown(): Promise<void> {
  clearInterval(cleanupTimer);
  await Promise.all([...sessions.values()].map(async ({ transport, server }) => {
    await transport.close();
    await server.close();
  }));
  listener.close(() => process.exit(0));
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
