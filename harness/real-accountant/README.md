# QuickBooks 真实会计 UAT 场景包

这个目录把一位会计同事的真实对话习惯，转成可重复、可机器读取的 QuickBooks Sandbox 验收场景。它验证的是同一段长对话里的业务判断和 MCP 行为，不是把若干硬编码工具调用包装成“Agent 测试”。

## 文件

- `real-accountant-qbo-v1.scenario.json`：14 份材料、4 条业务链、16 轮对话、工具与回答 oracle、写入与 blocker、幂等和回读要求。
- `scenario.schema.json`：供 runner/编辑器使用的 JSON Schema。
- `validate-scenario.mjs`：无第三方依赖的结构与业务语义自检。

运行场景包自检：

```bash
node harness/real-accountant/validate-scenario.mjs
```

成功只会得到 `SCENARIO_SCHEMA_VALID`。这不等于 MCP、模型或 Work 在线验收已通过。

## 隐私和材料边界

仓库只保存逻辑 artifact ID、纯虚构测试事实、SHA-256 环境变量名和去标识化对话。以下内容不得提交：

- 原始 DOCX、Markdown 对话导出或 14 张图片；
- 内部 Agent、Workspace、tenant、conversation ID 或 Drive URL；
- 同事姓名、邮箱、文档 author metadata；
- OAuth token、cookie、QuickBooks 密钥或真实 Company 数据。

14 张图片必须来自纯虚构测试包，并由运行者在仓库外建立本地映射。例如 runner 可读取一个不提交的 `artifact-map.local.json`：

```json
{
  "qbo-ra-art-01-customer-master": {
    "path": "/private/path/to/test-image-01.png",
    "sha256": "<64 lowercase hex characters>"
  }
}
```

映射必须覆盖 `artifactManifest` 的全部 14 个 `artifactId`；实际 SHA-256 应同时注入对应的 `QBO_UAT_ARTIFACT_XX_SHA256`。场景 JSON 不保存原始路径和真实哈希。

## Runner 读取约定

入口是 `cases[].turns[]`：

- `operation=read`：允许读取、分类和解释；禁止任何 provider write。
- `operation=prepare`：允许 `quickbooks_prepare_accounting_case`，但不得 execute；`PREPARED`/planned 不能称为已入账。
- `operation=write`：只能执行当前 Accounting Case 已释放的动作，并必须收集 authorization receipt、provider receipt、provider ID 和 exact read-back。
- `attachments[]` 只包含逻辑 `artifactId`。runner 在发送该轮消息时从私有映射上传对应图片。
- `toolOracle.required/allowed/forbidden` 评估工具选择；重复出现的 required tool 表示该轮需要多阶段调用。
- `toolOracle.requiredSequence` 评估有先后关系的业务动作。
- `responseOracle.mustState/mustNotClaim` 应做语义评估，不要只做逐字字符串匹配。

所有 16 轮必须在同一会话按顺序执行。T04 上传 10 份后 Agent 必须等待；T05 再上传 4 份。不得把每一轮拆成独立 session，因为“上述”“文件A/文件B”和后续事实更正依赖长上下文。

## 业务金标准

14 份材料不等于 14 次写入：

- 可写并要求精确回读：Customer、Vendor、Invoice、Bill、CreditMemo、VendorCredit。
- 只作证据或控制支持：客户 PO、GRN、银行流水、remittance、meal receipt。
- 当前版本明确 blocker：Payment、BillPayment、customer prepayment、bank fee、opening balance、ExpenseClaim、FX settlement。
- USD Bill 虽属于 QuickBooks 官方实体，但当前 Case schema 无法安全携带用户确认的 `1.3500` invoice exchange rate；不得静默让 provider 选另一个汇率，因此本场景要求 block。

联系人和单据必须分阶段：

1. Case v1 创建并回读 Customer、Vendor；依赖新 contact provider ID 的单据先保留为 residual/review。
2. Case v2 在 exact contacts 已存在后创建并回读 Invoice、Bill、CreditMemo、VendorCredit。
3. 相同 execute request 重放时，provider create delta 必须为 `0`，原 provider IDs 不变。

未释放的六份材料不能只留在聊天总结里。它们必须在 T10 前写入一个独立的、零 operation 的 residual Case；该 Case 永不 execute，并在 T10、T12、T14、T16 与 supported Case 一起查询。这样最终“14 份都有去向”来自两个持久 Case 的工具证据，而不是模型记忆。

关键核对项：

- VendorCredit 是 net `80.00` + GST `7.20` = gross `87.20`；`800.00` 必须被确定性校验拦截。
- Customer prepayment `1090.00` 是独立事件，不能冲减较早的 invoice。
- 员工 claim `256.50` = meal `218.00` + transport `38.50`；transport 无收据，不支持 input GST。
- 8 月 1 日审批不能把 7 月 11/14 日的费用发生日移到 8 月。
- USD invoice `1000.00 × 1.3500 = 1350.00 SGD`；settlement `1000.00 × 1.3650 = 1365.00 SGD`，另有 fee `15.00` 和 realized loss `15.00`。
- 没有 USD bank statement，不能声称 FX 账户已 reconciled。
- Vendor 表上的 `PENDING CALLBACK` 是源证据状态。即使用户说已线下确认，也要保留 review item；附件不能授权付款。

## 真实本地 Agent runner

场景可作为一条持续的 Codex Agent 会话直接执行。runner 会拒绝非 loopback
endpoint，先确认 `/healthz` 是 write-enabled 的 stateful synthetic Provider，
再按照会计同事的 10+4 节奏上传 `1.png` 到 `14.png`。原始 Codex JSONL、
MCP 工具调用和每轮回复会保存到已忽略的
`output/quickbooks-local-agent-uat/`；执行完成后仍需按本场景的 tool/response
oracle 评审，不能只凭脚本退出码判行为通过。

runner 在进程级禁用 multi-Agent、apps、browser、computer-use 和 shell，并只为 18 个 Accounting Case runtime 工具设置 MCP `approve`。任何非 `quickbooks` 工具调用都会使本轮立即失败；提示词只是业务合同，不承担工具隔离边界。

```sh
npm run build:harness:synthetic-qbo
npm run start:harness:synthetic-qbo-http
npm run test:harness:real-accountant-local-agent -- \
  --artifact-dir /private/tmp/qbo-real-accountant-test-documents
```

可先用 `--max-turn T03` 做有界 preflight。默认模型是 `gpt-5.6-terra`
和 `ultra` reasoning，也可用 `--model` 与 `--reasoning-effort` 覆盖。该
runner 被硬限制为 synthetic loopback，不能指向 Intuit Sandbox 或 Work，
所以不会与最终线上验收混淆。

## 本地验收顺序

1. 使用 OAuth-bound 测试身份连接一个 QuickBooks Sandbox Company；QuickBooks MCP 与 Xero MCP 必须拆开。
2. 确认目标 Company、本位币和写权限；检查 fresh-data gate。若同名联系人或同 DocNumber 已存在，结果为 `BLOCKED_TEST_DATA_DIRTY`，不要自动删除。
3. 用真实模型在同一会话执行 T01–T16；本地模型只用于行为预验收，不替代 Work 的 DeepSeek V4 最终验收。
4. 保存完整 transcript、tool calls、Case status、receipts、provider IDs、readback 和重复请求前后 create count。
5. 分别评估 `LOCAL_MCP_CONTRACT_PASS` 和 `LOCAL_AGENT_BEHAVIOR_PASS`。脚本化工具序列只能算前者。

本地行为未通过时，不进入 Work。

## Work 最终验收

1. 使用隔离的 UAT Agent，在 Work 模型选择器中选择 `DeepSeek V4`，并现场记录实际 model ID。
2. 只挂载 QuickBooks MCP：`https://mcp.jiayuanwang.xyz/quickbooks/mcp`。
3. 由当前交互用户 OAuth 授权自己的 QuickBooks Sandbox；不得复用另一用户的固定 Company 连接。
4. 在一个 Work 会话里按 T01–T16 发送消息和两批附件。
5. 私下保存 Work conversation/trace 与 provider 证据，并按同一 oracle 评估。

只有以下四项都成立，才可称这套场景通过：

1. `SCENARIO_SCHEMA_VALID`
2. `LOCAL_MCP_CONTRACT_PASS`
3. `LOCAL_AGENT_BEHAVIOR_PASS`
4. `WORK_DEEPSEEK_V4_ONLINE_UAT_PASS`

即使全部通过，也只证明一个 QuickBooks Sandbox Demo/UAT journey；不能外推为生产 posting、bank reconciliation、month-end close、tax filing 或“QuickBooks 官方所有写入均已实现”。
