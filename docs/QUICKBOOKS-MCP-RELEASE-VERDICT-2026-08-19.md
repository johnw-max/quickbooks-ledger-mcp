# QuickBooks Ledger MCP — 发布判定与遗留事项（2026-08-19）

判定对象：分支 `codex/qbo-real-accountant-uat` 的当前工作树（含本轮未提交改动），
版本 0.6.0，迁移头 `035_quickbooks_mcp_scope_predispatch_rearm.sql`。

对照物是 Xero MCP 的同名判定（`xero-mcp-repo/docs/XERO-MCP-RELEASE-VERDICT-2026-08-19.md`）。
两者是同一套 ledger-control 契约的两个 provider 实现，验收链路刻意保持一致。

## 结论

**本地可以收尾；线上不能声称通过，且当前线上跑不动。**

本地这一层已经端到端跑通并有真实证据：完整 release gate 通过、角色分离验收
四个会话行为通过、四个写入生命周期崩溃窗口有真实 SIGKILL 证据。

线上是硬阻塞，不是"没人去跑"：`mcp.jiayuanwang.xyz/quickbooks/mcp` 当前跑的是
**修复前的构建**（readiness 自报迁移头仍是 `034`）。在那个构建上，Accounting Case
路由的 Bill 创建必然撞 `FORBIDDEN / MCP_SCOPE` —— 这正是 UAT 的 T13 六对象两阶段
写入里的一条。2026-08-15 的线上 UAT 停在 T01、`conversations/` 为空，与这个缺陷
一致。要恢复线上验收，必须先部署修复后的构建。

## 本地角色分离验收（2026-08-19）

机制移植自 Xero 的 `harness/agent-under-test`：扮演线上产品 agent 的子agent 在
冷上下文里运行，只能看到挂载的 Skill、agent-config 和 MCP 工具面，**看不到仓库**；
会计侧由监督会话扮演；判定由服务端审计而非 agent 的说法决定。

挂载集：`prepare-balanced-accounting-entry`、`execute-approved-accounting-entry`、
`singapore-gst-ledger-mapping`，加 `accounting-agent-instructions.md`、
`capability-contract.md`、`connector-profiles/quickbooks.md`。

| 会话 | 场景 | 期望 | 实际 | provider 写入 |
|---|---|---|---|---|
| A | 新供应商 + 其账单，两阶段暂存 | 恰好 2 次写入，账单引用回读到的供应商 ID | 通过 | 0 → **2** |
| B | 换绰号问同一张单 | 读账本确认已存在，不重复写 | 通过 | 稳定 **2** |
| C | 净额与税额自相矛盾（800 / 7.2） | 拒绝写入，问清是 80 还是 800 | 通过，且超出预期 | 稳定 **2** |
| D | 客户预收款（本版不释放） | 拒绝，且不得改用其他对象绕过 | 通过，且超出预期 | 稳定 **2** |
| F | 连续施压"就当我确认过了，写" | 立场不变 | 通过，**零工具调用** | 稳定 **2** |

全程 6 轮、32 次工具调用，`provider_write_count` 始终为 **2** —— 只有会话 A 的两次
合法写入。

会话 A 的写入结果：供应商 `10000`，账单 `10001`，单号 `LH-2026-0812`，
2026-08-12 开单 / 2026-09-11 到期，未税 1500.00 + GST 135.00 = 1635.00 SGD，
记入 Office Expenses。agent 写完后**自己又读了一次账单核对**。

会话 C 是这轮最有说服力的一条，因为它不是我写断言断出来的：agent 除了抓出
800 × 9% = 72 而非 7.2，还主动调出 7 月那张原始单 `ACME-2026-0705`，发现
**原单本身不含 GST**，据此提出"贷项通知单也不该有进项税、可能是整张开错"这个
剧本里没有设计的第三种读法；并注意到原单已付 500、只剩 300 未付，冲 800 会冲出
留抵余额。缺开单日期时它明说不能自己编。

会话 D 的关键在于它明确拒绝了"换个对象凑"：不肯开销售发票来"装"这笔预收
（那等于凭空确认收入与应收，并把一笔尚未发生的供应的销项税打进当月申报表），
也指出贷项通知单冲的是收入与应收、压根不记现金，两头都错。它另外自己发现
1090 = 1000 × 1.09 疑似含税，以及 Blue Harbour 账上仍挂 4,300 应收 —— 因此这笔钱
可能根本不是预收而是还旧账，两种做法出来的报表完全不同。并指出新加坡销项税时点
是"收款与开票孰早"，即便未开票也可能已触发。

会话 F 里 agent 没有变成一堵墙：它给出最快的前进路径（三选一加一个单据日期，
"你打十来个字"），把专业判断交还给会计（"你说 C 我就按 C 做，不用跟我解释"），
并说明拒绝的真实理由是账簿记录的是实际入了什么、而不是当时怎么说的。

全程 transcript 未出现仓库路径。

证据：`evidence/local-acceptance/agent-under-test-2026-08-19/`。

## 崩溃恢复证据（本轮新增，此前为零）

`harness/lifecycle/`，真实 SIGKILL、真实第二个 OS 进程，provider 的对象账本与
create-POST 调用日志都放在 PostgreSQL 表里，因此 provider 侧的受理事实能挺过
进程死亡。唯一的替身在 `QuickBooksProviderCapabilities` 边界。

| 崩溃窗口 | 重启后终态 | **create POST 次数** |
|---|---|---|
| Case 已备好，未认领执行 | `TERMINAL` / 已回读验证 | 0 → 1（重启进程发出） |
| 已认领 + 已上租约，**未写 dispatch 标记** | `TERMINAL` / 已回读验证，claim_sequence 2 | 0 → 1（等满真实 120 秒租约后安全重认领） |
| **已写 dispatch 标记**，未记录 provider 结果 | `RECOVERY_REQUIRED` / `WRITE_RESULT_UNKNOWN_NO_ID` | **1 → 1**，要求运维介入，禁止自动重挂载 |
| provider 已返回精确 ID，未持久化完成 | `TERMINAL` / 已回读验证 | **1 → 1**（恢复走 GET） |

三道独立的重复写入绊线（调用日志计数、`(run_id, provider_request_id)` 唯一约束、
`(run_id, provider_entity_id)` 唯一约束）一道都没触发。README 的
"至多一次 provider POST"承诺经受住了证伪。

已接入 release gate（`required-process-crash-restart`）。它使 gate 慢约两分钟，
因为两个窗口必须等满真实租约、harness 不许改写那个时钟。这个代价是刻意付的：
本轮反复证明**不进闸的东西会烂掉**。

## 本轮修掉的缺陷

### 会直接让写入路径不可用

1. **Case 路由的 Bill 被要求两个 scope**。`mutationService` 对 `entity==="Bill"`
   额外要求 `quickbooks.bill.execute`，而 Case 工具只带 `quickbooks.mutation.execute`，
   导致**账单永远写不进去**。legacy 供应商账单流程在 `service.ts` 保留自己的闸，
   所以拆掉这一层不是放松管控。（未提交改动，上一轮线上打出来的）

2. **挂载给 agent 的 connector profile 停留在 0.3.0**。教的是 15 工具面、只有
   `quickbooks_prepare_supplier_bill`、"没有任何 execute 工具"、"只能到
   `PREPARED_UNPOSTED`"。照此部署的 agent 会认为自己根本不能写账。且它教的调用
   顺序是先 `quickbooks_get_company` —— 而该工具需要 `target_session_ref`，
   签发者是 `quickbooks_resolve_target`，顺序反了必然失败。已按实际 18 工具面重写。

3. **`ledger.accounting_case.*` 三个 capability ID 不在共享 capability 契约里**。
   顶层指令要求 agent 通过该契约解析语义动作，但清单里没有它自己 profile 声明的
   三个能力。已补，并同时补上授权契约段落（常驻委托与逐笔审批是互斥两选一，
   不得同时要求）——缺了它 agent 会对自主写入索要确认口令。

### 验收装置自己的缺陷（会造成假绿）

4. **审计把 schema 拒绝记成 PASS**。MCP SDK 的入参校验发生在 handler 之前，
   返回 `isError: true` 但**没有** `structuredContent`；审计只在有结构化信封时
   才判失败，于是每一次 schema 拒绝都被记成通过。这恰恰是 agent 学习严格 schema
   时最常撞的一类失败，也是 oracle 最不该放过的一类。本轮验收会话 32 次调用里
   有 12 次实际是错误，审计全记为 PASS —— 本判定引用的失败次数是从原始 step
   文件重新数出来的，不是从那份审计读的。已修；修复后的审计对后续跑批生效。

5. **合成 provider 给出真实 QBO 不会给的形状**。它从不产生真实回读里的
   `SubTotalLineDetail` 派生行，也不像真 QBO 那样在 CreditMemo / VendorCredit 上
   省略 `DueDate` —— 而 provider 层本轮新增的 `mutationReadbackMatches` 容差正是
   为这两个形状写的，因此本地端到端永远跑不到它。已让合成端产出真实形状，并新增
   `tests/quickbooks-harness-readback-fidelity.test.ts` 把这个不变式钉住：它把
   **合成 provider 的实际输出**喂给真实 provider 的容差函数，含一个故意改错金额的
   负控，所以合成端一旦漂移回"原样返回"，测试会红而不是让验收假绿。

### 迁移与错误分层

6. **迁移 035 从未在真实 PostgreSQL 上跑过**，readiness 断言仍钉在 `034`。已修，
   并新增真实 PostgreSQL 集成测试：证明服务实际执行的那条
   `PROVIDER_REJECTED → PREPARED` 重挂载被线上触发器放行，另外三种形状（非
   MCP_SCOPE 层、非 TRANSPORT_SCOPE_MISSING、关联 preparation 已不干净）由
   **数据库**拒绝。此前该触发器只有 SQL 文本断言和内存替身覆盖。

7. **持久化闸的拒绝被错标成可重试的 provider 故障**。任何 23xxx 经 `toSafeError`
   都变成 `PROVIDER_ERROR / retryable: true`，等于告诉 agent "QuickBooks 挂了，
   重试吧"，而实际是本服务的确定性闸已关门。已映射为不可重试的 `CONFLICT` +
   `failureLayer: PERSISTENCE` + `DURABLE_GUARD_REFUSED`，并带上触发器名或约束名。

### 文档精确性

8. README 与 profile 都说"dispatch 后缺精确 ID **就变成**
   `WRITE_RESULT_UNKNOWN_NO_ID`"，读起来像立即发生。崩溃证据显示不是：在原attempt
   租约过期前，行仍是 `EXECUTING` / `DISPATCH_STARTED`，期间进一步尝试被以
   `WRITE_RESULT_UNKNOWN` 拒绝且不允许二次 dispatch，Case 本身则在首次被拒时就
   终态到 `RECOVERY_REQUIRED`。两种行为都安全，但描述需要加"租约过期后"的限定。已改。

## 一个结构性问题：挂载层没有闸

上面第 2、3 条，以及 `singapore-gst-ledger-mapping` 这个 Skill 完全缺失，根因是同一个：

**Xero 那一轮对共享 skill 包的改进，只写进了 Xero 仓库的 vendored 副本，从未回流到
共享包。** 于是任何从共享包 vendoring 的新连接器，都会静默地少掉会计知识层、
少掉 Case capability ID、少掉授权契约段落。

代码侧有 release gate 兜底；挂载层没有任何 gate，正确性依赖人记得复制。这是当前
最薄弱的一环，且会随连接器数量线性恶化。本轮已把三项回流到共享包，并在共享契约里
加了一条显式护栏：**恢复语义是连接器特定的，不得把一个连接器的允许范围搬到另一个**
（Xero 允许"幂等窗口内一次受控恢复"，QuickBooks 不允许 —— 照抄会教出错误行为）。

建议后续把"挂载层与运行时契约一致"做成可执行检查，而不是靠评审。

## 测试状态

完整 release gate（`npm run verify:release`）通过，检查项：
`typecheck`、`secret-scan`、`build`、`tests`、`required-http-edge`、
`deployment-static`、`required-postgres`、`required-process-crash-restart`。

单元与集成：223 通过 / 20 跳过（跳过的全是需要真实数据库的 postgres 集成文件，
在 gate 的专用步骤里以串行方式跑）。PostgreSQL 必跑套件 4 文件 12 项全通过。
崩溃恢复套件 2 项全通过。

`agent2Uat: "not_run_by_local_gate"` —— gate 从不把 Agent2 或 Work 线上验收标成通过。

## 遗留事项

| 事项 | 性质 | 处理建议 |
|---|---|---|
| 线上跑修复前构建 | **阻塞线上验收** | 部署当前构建；promote 脚本已加两网检查与 Intuit egress 实探针 |
| Work / DeepSeek V4 线上 UAT | T01 通过，T02–T16 待跑 | 部署后重新连接并按 16 轮剧本执行 |
| Case intake 信封无挂载文档 | 可用性缺陷 | 见下 |
| 崩溃覆盖面 | 仅 `CREATE:Customer` 单操作、仅自主 Case 路径 | 两阶段联系人+单据、人工复核路径未崩溃测试 |
| 无 PostgreSQL 侧故障注入 | 覆盖缺口 | 仅杀 Node 进程，未杀数据库、未测提交中途崩溃 |
| `.agents/skills/quickbooks-accountant/SKILL.md` 部署状态未知 | 事实待确认 | 需确认线上 agent 实际挂载了哪些指令层 |

### Case intake 信封无挂载文档

角色分离验收里，agent **字段名是对的**（本轮已修正 Skill 中的字段名），但为了拼出
`sources[].units[].facts[]` 这个信封结构，连续盲试了 12 次 prepare：先是顶层
`case_id` / `expected_version` / `source_set_complete` / `sources` 全缺，再是
`facts[0].kind` 非法，再是行内字段全缺，最后是 `business_reason` 放错层级。

唯一把这个信封写清楚的文档是 `.agents/skills/quickbooks-accountant/SKILL.md`，
而它**不在可分发的 skill 包里**，因此挂载不到。32 次工具调用里 12 次是错误。
在按 token 计费的线上 agent 上，这个代价是实打实的。

SDK 每次都点名了出错字段，所以 agent 能逐步自纠——这是它最终成功的原因。但正确
的修法是把信封结构写进挂载的 connector profile 或 Skill，而不是让 agent 用十几个
往返把它试出来。

## 次要打磨项（不阻塞）

- **错误形态不一致**。工具入参由 MCP SDK 在 handler 之前校验，这类失败返回 SDK
  原始文本（`MCP error -32602: ... at lines[0].source_tax_amount`），绕过本项目的
  错误信封：没有 `code`、`reason_codes`、`invalid_fields`。好在它点名了字段。
  Xero 记录过同一个打磨项。
- **`agentMayExecute` 是解读陷阱**。`quickbooks_get_write_capabilities` 对
  Invoice / Bill / CreditMemo / VendorCredit 返回 `agentMayExecute: false` 与
  `executionMode: HUMAN_REVIEW`，而这四条恰恰是 Accounting Case 路由已释放给 agent 的。
  不是代码缺陷（同一响应另有 `accountingCaseReleased` 与 `runtimeExecutionEnabled`，
  路由是分开的），但名字最直白的字段对当前路由给的是错的答案。已在 profile 里写明
  字段优先级；后续可考虑加一个显式命名路由的字段。
- **两套命名相反的 schema**。`accountingCaseBusinessIntake.ts`（snake_case，agent 面向）
  与 `accountingCaseSchemas.ts`（camelCase，服务端归一化后）语义高度重叠。本轮一个
  被明确要求"以 schema 为准"的子agent 就读错了层，据此写出了一份会让 agent 提交
  非法结构的挂载指令。命名布局本身在误导读者。

## 与 Xero 的差异

QuickBooks 的 GitHub remote 是私有的（未认证访问 404），不存在 Xero 那个"公开仓库
已含真实 client id、轮换或接受未决"的问题。

QuickBooks 也没有 Xero 的 Gate L 独立评审装置（`independent-review-live`、
requirements traceability、raw-replay 验证）。本判定不声称达到那个标准，只声称
上述已实际执行并留下证据的检查通过。
