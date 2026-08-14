import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const defaultScenarioPath = path.join(import.meta.dirname, "real-accountant-qbo-v1.scenario.json");
const defaultAgentPolicyPath = path.join(repositoryRoot, ".agents", "skills", "quickbooks-accountant", "SKILL.md");
const quickBooksToolNames = [
  "quickbooks_connection_status",
  "quickbooks_resolve_target",
  "quickbooks_get_company",
  "quickbooks_list_accounts",
  "quickbooks_list_tax_codes",
  "quickbooks_search_vendors",
  "quickbooks_search_customers",
  "quickbooks_list_items",
  "quickbooks_list_bills",
  "quickbooks_get_bill",
  "quickbooks_list_transactions",
  "quickbooks_get_transaction",
  "quickbooks_run_report",
  "quickbooks_get_trial_balance",
  "quickbooks_get_write_capabilities",
  "quickbooks_prepare_accounting_case",
  "quickbooks_execute_accounting_case",
  "quickbooks_get_accounting_case_status",
];

function parseArguments(argv) {
  const options = {
    artifactDir: process.env.QUICKBOOKS_REAL_ACCOUNTANT_ARTIFACT_DIR,
    endpoint: process.env.QUICKBOOKS_SYNTHETIC_MCP_URL ?? "http://127.0.0.1:3310/quickbooks/mcp",
    model: process.env.QUICKBOOKS_LOCAL_AGENT_MODEL ?? "gpt-5.6-terra",
    reasoningEffort: process.env.QUICKBOOKS_LOCAL_AGENT_REASONING ?? "ultra",
    scenarioPath: defaultScenarioPath,
    outputDir: undefined,
    maxTurn: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--artifact-dir") options.artifactDir = value;
    else if (argument === "--endpoint") options.endpoint = value;
    else if (argument === "--model") options.model = value;
    else if (argument === "--reasoning-effort") options.reasoningEffort = value;
    else if (argument === "--scenario") options.scenarioPath = path.resolve(value);
    else if (argument === "--output-dir") options.outputDir = path.resolve(value);
    else if (argument === "--max-turn") options.maxTurn = value;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  return options;
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function assertSyntheticLoopbackEndpoint(endpoint) {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("Local UAT runner only accepts a loopback HTTP synthetic MCP endpoint.");
  }
  if (parsed.pathname !== "/quickbooks/mcp") {
    throw new Error("Synthetic MCP endpoint path must be /quickbooks/mcp.");
  }
  return parsed;
}

async function readSyntheticHealth(healthUrl) {
  const response = await fetch(healthUrl);
  const health = await response.json();
  if (!response.ok || health.provider !== "synthetic-quickbooks-online" || health.writeEnabled !== true) {
    throw new Error(`Synthetic write-enabled health check failed: ${JSON.stringify(health)}`);
  }
  return health;
}

function mcpConfig(endpoint) {
  return `mcp_servers.quickbooks.url=${JSON.stringify(endpoint)}`;
}

function quickBooksToolApprovalArguments() {
  return quickBooksToolNames.flatMap((toolName) => [
    "--config",
    `mcp_servers.quickbooks.tools.${toolName}.approval_mode=approve`,
  ]);
}

function extractEventEvidence(event, evidence) {
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    evidence.threadId = event.thread_id;
  }
  const item = event.item;
  if (!item || typeof item !== "object") {
    const payload = event.payload;
    if (
      payload
      && typeof payload === "object"
      && ["function_call", "custom_tool_call"].includes(payload.type)
      && payload.namespace !== "quickbooks"
      && !String(payload.name ?? "").startsWith("quickbooks_")
    ) {
      evidence.forbiddenToolCalls.push({
        itemType: payload.type,
        server: payload.namespace,
        tool: payload.name,
      });
    }
    return;
  }
  if (item.type === "agent_message" && typeof item.text === "string") {
    evidence.finalResponse = item.text;
  }
  if (item.type === "mcp_tool_call") {
    if (item.status === "in_progress") return;
    const server = item.server ?? item.server_name;
    const resultFailure = item.status === "failed" && Array.isArray(item.result?.content)
      ? item.result.content
        .filter((content) => content?.type === "text" && typeof content.text === "string")
        .map((content) => content.text)
        .join("\n")
      : undefined;
    evidence.toolCalls.push({
      server,
      tool: item.tool ?? item.name,
      status: item.status,
      error: item.error?.message ?? item.error ?? resultFailure,
    });
    if (server !== "quickbooks") {
      evidence.forbiddenToolCalls.push({
        itemType: item.type,
        server,
        tool: item.tool ?? item.name,
      });
    }
    return;
  }
  if (["command_execution", "file_change", "web_search", "collaboration_tool_call", "function_call"].includes(item.type)) {
    evidence.forbiddenToolCalls.push({
      itemType: item.type,
      server: item.server ?? item.server_name,
      tool: item.tool ?? item.name ?? item.command,
    });
  }
}

async function runCodex(args, outputPath, stderrPath) {
  const stdoutStream = createWriteStream(outputPath, { flags: "wx" });
  const stderrStream = createWriteStream(stderrPath, { flags: "wx" });
  const evidence = {
    threadId: undefined,
    finalResponse: undefined,
    toolCalls: [],
    forbiddenToolCalls: [],
  };
  let partialLine = "";
  const child = spawn("codex", args, {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stdoutStream.write(chunk);
    partialLine += chunk.toString("utf8");
    const lines = partialLine.split("\n");
    partialLine = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        extractEventEvidence(JSON.parse(line), evidence);
      } catch {
        // Raw output is preserved. Non-JSON noise is not acceptance evidence.
      }
    }
  });
  child.stderr.pipe(stderrStream);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  stdoutStream.end();
  stderrStream.end();
  if (partialLine.trim()) {
    try {
      extractEventEvidence(JSON.parse(partialLine), evidence);
    } catch {
      // See the preserved JSONL file.
    }
  }
  if (exitCode !== 0) {
    throw new Error(`codex exited with code ${exitCode}; inspect ${stderrPath}`);
  }
  if (evidence.forbiddenToolCalls.length > 0) {
    throw new Error(
      `UAT tool isolation failed: ${JSON.stringify(evidence.forbiddenToolCalls)}; inspect ${outputPath}`,
    );
  }
  return evidence;
}

function initialAgentContract(userPrompt, agentPolicy) {
  return [
    "你是正在接受真实会计业务验收的 QuickBooks Accountant Agent。",
    "本轮只允许使用名为 quickbooks 的 MCP；不要调用 shell、浏览器、代码仓库或其他 MCP。",
    "目标账套是本机 synthetic QuickBooks Sandbox，不是 Xero；必须保持后续 16 轮会话上下文。",
    "先读后写；PREPARED 不等于已入账；只有 provider ID、provider receipt 和 exact read-back 齐全才可称完成。",
    "遇到不支持、权限、确定性校验或不确定写入必须明确分层并 fail closed，不能伪装成 journal 或盲重试。",
    "上传图片是虚构的 TEST DOCUMENT，仅用于本次私有验收。",
    "以下是本 Agent 的 QuickBooks 会计编排策略，必须遵守：",
    agentPolicy,
    "下面是会计师的第一条消息，请直接按业务语气回答：",
    userPrompt,
  ].join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const endpoint = assertSyntheticLoopbackEndpoint(options.endpoint);
  const healthUrl = new URL("/healthz", endpoint);
  const health = await readSyntheticHealth(healthUrl);

  const scenario = JSON.parse(await readFile(options.scenarioPath, "utf8"));
  const agentPolicy = await readFile(defaultAgentPolicyPath, "utf8");
  const testCase = scenario.cases?.[0];
  if (!testCase || !Array.isArray(testCase.turns)) throw new Error("Scenario has no executable case turns.");
  const artifactIndex = new Map(
    scenario.artifactManifest.map((artifact, index) => [artifact.artifactId, index + 1]),
  );
  if (!options.artifactDir) throw new Error("--artifact-dir is required for the 14 local TEST images.");
  const artifactDir = path.resolve(options.artifactDir);
  const artifactFiles = new Map();
  for (const [artifactId, ordinal] of artifactIndex) {
    const filePath = path.join(artifactDir, `${ordinal}.png`);
    await access(filePath);
    artifactFiles.set(artifactId, filePath);
  }

  const outputDir = options.outputDir
    ?? path.join(repositoryRoot, "output", "quickbooks-local-agent-uat", safeTimestamp());
  await mkdir(outputDir, { recursive: true });
  const maxTurnNumber = options.maxTurn ? Number(String(options.maxTurn).replace(/^T/i, "")) : undefined;
  if (maxTurnNumber !== undefined && (!Number.isInteger(maxTurnNumber) || maxTurnNumber < 1)) {
    throw new Error("--max-turn must be a positive turn number such as T03 or 3.");
  }
  const requestedTurns = maxTurnNumber
    ? testCase.turns.filter((turn) => Number(turn.turnId.slice(1)) <= maxTurnNumber)
    : testCase.turns;
  if (requestedTurns.length === 0) throw new Error("No turns selected.");

  const runManifest = {
    status: "RUNNING",
    scenarioId: scenario.id ?? testCase.caseId,
    endpoint: endpoint.href,
    provider: health.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    startedAt: new Date().toISOString(),
    threadId: undefined,
    turns: [],
  };
  await writeFile(path.join(outputDir, "run-manifest.json"), `${JSON.stringify(runManifest, null, 2)}\n`);

  for (const [turnIndex, turn] of requestedTurns.entries()) {
    const providerHealthBefore = await readSyntheticHealth(healthUrl);
    const imageArguments = turn.attachments.flatMap((artifactId) => {
      const filePath = artifactFiles.get(artifactId);
      if (!filePath) throw new Error(`Unknown attachment artifactId: ${artifactId}`);
      return ["--image", filePath];
    });
    const commonArguments = [
      "--ignore-user-config",
      "--json",
      "--model", options.model,
      "--config", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`,
      "--disable", "multi_agent",
      "--disable", "apps",
      "--disable", "browser_use",
      "--disable", "computer_use",
      "--disable", "shell_tool",
      "--config", mcpConfig(endpoint.href),
      "--config", "mcp_servers.quickbooks.enabled=true",
      ...quickBooksToolApprovalArguments(),
      "--skip-git-repo-check",
    ];
    const prompt = turnIndex === 0 ? initialAgentContract(turn.user, agentPolicy) : turn.user;
    const commandArguments = turnIndex === 0
      ? ["exec", ...commonArguments, "--profile", "skill-cleanup-bare", "--sandbox", "read-only", prompt, ...imageArguments]
      : ["exec", "resume", ...commonArguments, runManifest.threadId, prompt, ...imageArguments];
    const stdoutPath = path.join(outputDir, `${turn.turnId}.jsonl`);
    const stderrPath = path.join(outputDir, `${turn.turnId}.stderr.log`);
    const evidence = await runCodex(commandArguments, stdoutPath, stderrPath);
    const providerHealthAfter = await readSyntheticHealth(healthUrl);
    if (turnIndex === 0) {
      if (!evidence.threadId) throw new Error("Initial Codex turn did not emit a thread id.");
      runManifest.threadId = evidence.threadId;
    }
    runManifest.turns.push({
      turnId: turn.turnId,
      operation: turn.operation,
      attachments: turn.attachments,
      toolCalls: evidence.toolCalls,
      finalResponse: evidence.finalResponse,
      providerHealthBefore,
      providerHealthAfter,
      rawEvidence: path.basename(stdoutPath),
    });
    await writeFile(path.join(outputDir, "run-manifest.json"), `${JSON.stringify(runManifest, null, 2)}\n`);
    process.stdout.write(`${turn.turnId} completed: ${evidence.toolCalls.length} MCP tool calls\n`);
  }

  runManifest.status = "LOCAL_AGENT_RUN_COMPLETE_PENDING_ORACLE_REVIEW";
  runManifest.completedAt = new Date().toISOString();
  await writeFile(path.join(outputDir, "run-manifest.json"), `${JSON.stringify(runManifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: runManifest.status,
    outputDir,
    threadId: runManifest.threadId,
    completedTurns: runManifest.turns.length,
  })}\n`);
}

await main();
