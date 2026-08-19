import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QUICKBOOKS_RELEASE_VERSION } from "../../src/quickbooks/mcp.js";
import { withLocalAgentServerAudit } from "./localAgentServerAudit.js";
import { createSyntheticQuickBooksHarnessRuntime } from "./syntheticQuickBooksRuntime.js";

const writeEnabled = process.env.QUICKBOOKS_SYNTHETIC_CASE_WRITE_ENABLED !== "false";
const runtime = createSyntheticQuickBooksHarnessRuntime({ writeEnabled });
const server = runtime.createServer();

// LOCAL_AGENT_SERVER_AUDIT_PATH is opt-in. This entrypoint is also the
// documented local-Agent STDIO MCP command (see harness/local-agents/README.md)
// and the esbuild target for build:harness:synthetic-qbo, neither of which set
// an audit path -- only the agent-under-test driver does. Both must keep
// working exactly as before when the variable is absent.
const auditPath = process.env.LOCAL_AGENT_SERVER_AUDIT_PATH;
if (auditPath) {
  await server.connect(withLocalAgentServerAudit(new StdioServerTransport(), {
    auditPath: resolve(auditPath),
    provider: runtime.provider,
    releaseVersion: QUICKBOOKS_RELEASE_VERSION,
    writeEnabled,
  }));
} else {
  await server.connect(new StdioServerTransport());
}
