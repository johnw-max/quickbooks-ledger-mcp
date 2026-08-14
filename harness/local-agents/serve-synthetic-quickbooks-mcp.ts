import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSyntheticQuickBooksHarnessRuntime } from "./syntheticQuickBooksRuntime.js";

const runtime = createSyntheticQuickBooksHarnessRuntime({
  writeEnabled: process.env.QUICKBOOKS_SYNTHETIC_CASE_WRITE_ENABLED !== "false",
});
await runtime.createServer().connect(new StdioServerTransport());
