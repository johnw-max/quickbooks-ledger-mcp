# QuickBooks 真实会计 Agent UAT 机制

## 当前结论

去标识化的 14 材料、16 轮连续对话场景已经固化为机器可读 fixture；它可以被本地 Agent runner 和 Work 在线 UAT runner 共用。2026-08-14 的最终本地连续会话已通过：16/16 轮完成、6 次预期写入、0 次工具失败、0 次禁用工具调用；Customer、Vendor、Invoice、Bill、CreditMemo、VendorCredit 均取得精确 Provider ID 与 read-back，最终 mutation count 为 6。

证据状态必须分开：

| 层 | 当前含义 |
|---|---|
| Scenario fixture | 场景、金标准、工具与回答 oracle 已定义 |
| Local MCP contract | `PASS`：完整 release gate 与全新 PostgreSQL migration/integration gate 通过 |
| Local Agent behavior | `PASS`：真实模型在同一 16 轮长会话中完成 10+4 附件、修订、分阶段写入与幂等复核 |
| Work online UAT | `BLOCKED_DEPLOYMENT`：Work Agent/MCP/callback/DeepSeek V4 已配置；公网仍是旧 0.4.0，需先发布 0.6.0 |

任何前一层通过都不能替代后一层。当前可以称本地 MCP 合同与本地 Agent 行为通过，不能称 Work online UAT 或生产通过。

## 场景覆盖

主流程模拟会计师的真实使用方式：

1. 先读取当前 QuickBooks Company 和历史账套；
2. 10 + 4 分批上传 14 份虚构材料，并要求 Agent 等全部材料到齐；
3. 用中英混合、口语和“上述/文件A/文件B”等上下文引用沟通；
4. 一次纠正 10 个事实，要求 Agent 全局更新而不是只修最后一句；
5. 先逐来源分类，再 prepare，再分阶段写入；
6. 对 `80`/`800`、漏项、发生日/审批日、预收款和 FX 做反向质疑；
7. 要求每一笔 eligible write 返回 authorization receipt、provider receipt、provider ID 和 exact readback；
8. 重放同一请求，证明没有重复创建；
9. 最终对所有来源给出“已写、仅证据、blocker、review”终态。

## 业务边界

当前已释放的 Case 写入是 Customer、Vendor、Invoice、Bill、CreditMemo、VendorCredit。Payment、BillPayment、customer prepayment、bank fee、opening balance、ExpenseClaim 和 FX settlement 必须明确 block，不能被 Agent 临时改写成 journal 绕过。

USD Bill 需要额外注意：QuickBooks 官方实体本身支持 Bill，但当前 Case schema 没有安全表达用户确认 exchange rate 的字段。本场景将它定义为 schema gap；在字段、校验和 readback 全部补齐前不得写。

QuickBooks 是正式账本。PO、GRN、bank statement、remittance 和 receipt 可以是事实或控制证据，但“材料已存储”不能被称为“已入账”。

## 可执行入口

- 场景：`harness/real-accountant/real-accountant-qbo-v1.scenario.json`
- Schema：`harness/real-accountant/scenario.schema.json`
- 自检：`node harness/real-accountant/validate-scenario.mjs`
- 运行说明：`harness/real-accountant/README.md`

Work 只使用 `https://mcp.jiayuanwang.xyz/quickbooks/mcp`，并保持 Xero 与 QuickBooks 为两个独立 MCP。2026-08-14 现场记录：模型 `deepseek/deepseek-v4-pro`、MCP identifier `quickbooks-accounting-mcp`、callback `https://work.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback`。公网线上验收必须等 0.6.0 发布后重新连接并执行，不能用当前旧 0.4.0 代替。
