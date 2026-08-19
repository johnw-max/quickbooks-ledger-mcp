# QuickBooks Ledger MCP — 发布判定与遗留事项（2026-08-19）

判定对象：分支 `codex/qbo-real-accountant-uat` 的当前工作树（含本轮未提交改动），
版本 0.6.0，迁移头 `035_quickbooks_mcp_scope_predispatch_rearm.sql`。

对照物是 Xero MCP 的同名判定（`xero-mcp-repo/docs/XERO-MCP-RELEASE-VERDICT-2026-08-19.md`）。
两者是同一套 ledger-control 契约的两个 provider 实现，验收链路刻意保持一致。

## 结论

**本地已收尾，构建已部署；线上 agent 验收仍未跑，不能声称通过。**

本地这一层已经端到端跑通并有真实证据：完整 release gate 通过、角色分离验收
五个会话行为通过、四个写入生命周期崩溃窗口有真实 SIGKILL 证据。

2026-08-19 已把本分支部署到 `mcp.jiayuanwang.xyz/quickbooks/mcp`，线上迁移头
现为 `035`，`ready: true`。剩下的缺口是 Work/DeepSeek-V4 的 16 轮线上会话本身
（T01 已过，T02–T16 待跑），服务自己也仍报 `ONLINE_AGENT_UAT_REQUIRED`。

### 一处先前的误判，已更正

本文最初写的是"线上跑的是修复前的构建，Bill 创建必然撞 `FORBIDDEN / MCP_SCOPE`，
UAT 因此跑不动"。**这是错的**，依据是 readiness 报的迁移头仍是 `034` 就推断整个
构建是旧的。实际登上主机核对编译产物后：2026-08-15 部署的那个镜像
（`0.6.0-case-scope-fix-20260815`）**已经包含** scope 修复与 provider 回读容差，
缺的只是迁移 035 的重挂载逻辑与错误分层。

所以线上 UAT 停在 T01 与该缺陷无关，真实原因不明——本文不再对此给出解释。
教训是：迁移头只能证明 schema 版本，不能用来推断整个构建的内容。

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
| Work / DeepSeek V4 线上 UAT | T01 通过，T02–T16 待跑 | Work agent 需重新授权 OAuth 后按 16 轮剧本执行 |
| 旧容器仍在运行 | 保留作回滚 | 线上稳定后再 `docker stop quickbooks-accounting-mcp-0.6-candidate` |
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

## 部署记录（2026-08-19）

线上现为本分支构建，容器 `qbo-78e02bd-quickbooks-mcp-1`（`172.19.0.25:3000`），
nginx upstream 已指向它；旧容器 `quickbooks-accounting-mcp-0.6-candidate`
（`172.19.0.2`）仍在运行以备回滚。nginx 备份在
`/var/backups/quickbooks-mcp-nginx/`。

外部复核：迁移头 `035`、`ready: true`、`missing/unexpected` 均为 0、18 工具、
6 条已释放能力、写闸开、常驻委托 `ACTIVE` rev 1、`/quickbooks/readyz` 200。

这次部署是照着仓库自己声明并被 `verify-static.sh` 校验的 compose 规格起的，
比原先在跑的那个容器更严：原容器是 `docker run` 起的，没有 healthcheck，也没有
`read_only` / `no-new-privileges` / `cap_drop ALL` / tmpfs / 资源限制。

### 实跑部署才暴露的三件事

1. **promote 脚本只能跑一次**。它把 upstream 里的 `server 127.0.0.1:18003;` 换成
   候选容器地址，第二次跑时那个模式已不存在，抛 `found 0`。候选容器名也写死，
   而该名字正被现役容器占用。已改为匹配任意单个地址、候选名走参数，并拒绝
   "已指向该地址"的空转。

2. **promote 脚本的备份会弄坏它备份的那份配置**。备份写在 `sites-enabled/` 里，
   而 nginx 会加载该目录下每一个文件，于是备份被当成第二份完整 server 配置，
   `nginx -t` 因 `duplicate log_format` 失败——发生在新 upstream 被验证之前。
   两次提升因此自我回滚，回滚路径里的 reload 也同样失败，留下一份要手工搬走
   才能通过校验的配置。流量始终没被切走，但那是因为闸在 reload 之前就拦住了，
   不是因为备份本身安全。已改到 `/var/backups/quickbooks-mcp-nginx/`。

3. **向前迁移会让共库的旧构建变成 `NOT_READY`**。候选启动时应用了 035，而
   readiness 把"不在本构建预期集合里的 quickbooks 迁移"计入 `unexpectedCount`，
   于是仍在服务流量的 034 容器立刻变成 `ready: false`、`/readyz` 503。MCP 流量
   本身不受影响（nginx 按 IP:3000 转发，不看 readyz），提升完成后即恢复。
   但这意味着**灰度窗口内必然有一段旧构建自报未就绪**：要么接受，要么让候选
   先不跑迁移。这条在只读部署演练里看不出来，只有真的起候选才会遇到。

## 线上 agent 验收尝试（2026-08-19，未完成）

在部署后用 Work / DeepSeek-V4 尝试续写 8 月 15 日卡住的 case v2。**没有完成**：
四条操作仍是 `READBACK_VERIFIED x2 / PROVIDER_REJECTED x1 / PENDING x1`，
case 仍是 `RECOVERY_REQUIRED`，`provider write count` 未增加。

### 8 月 15 日那次会话证明了什么（服务端审计，非推测）

`quickbooks_tool_audit_logs` 与 case 表显示，当天对**真实 QuickBooks**：

- Customer、Vendor、CreditMemo、VendorCredit 四条 `POSTED_READBACK_VERIFIED`；
- 一条 `FAILED / READBACK_MISMATCH` —— 即 QBO 派生小计行与 `DueDate` 形状缺陷；
- 一条 `REJECTED / FORBIDDEN`，case 侧记为 `MCP_SCOPE / TRANSPORT_SCOPE_MISSING`
  —— 即 Bill 的双 scope 缺陷；
- Invoice 从未尝试。

**本轮修复的两个缺陷都不是推测出来的，它们在真实线上会话里各现形一次。**

### 本次尝试暴露的新缺陷

**1. Case 归属冲突不可据以纠正（已修并已部署）。**
处于 `EXECUTING` / `RECOVERY_REQUIRED` 的 case 只能用**发起时那个
`execution_request_id`** 续写，而拒绝信息只说"被另一个请求占用"，不说是谁。
线上 agent 把它读成锁竞争，连续十几次换新请求号重试——那条路永远走不通，
case 行自始至终没被碰过。修复后错误会带上 `owningRequestId`、`caseState` 与
`recoveryAction`；重新部署后同一个 agent 立刻改用 owning request id，
说明这条修复确实起了作用。

**2. 常驻委托身份钉死在 OAuth installation 上（未修，当前阻塞项）。**
用对 request id 之后，执行止于 `APPROVAL_INVALID`（授权因果校验）。
记录在案的授权回执里，`delegationId` 是
`qbo-default-<installationId>` —— 委托身份内嵌了 OAuth token id。

这与 Xero 已经修过的是同一个缺陷：*"常驻委托钉死在 OAuth installation 上，
用户每次重连即失效"*，Xero 的解法是改成按 workspace + agent + 租户这个稳定
身份匹配，并把 installation 降级为可选钉子（见 `AUTHORITY-PIN-OPERATIONS.md`）。
QuickBooks 尚未采纳。

同一根因还解释了另外两个现象：线上累积了 6 条同 realm 的 ACTIVE 连接，
以及每次授权都新建 principal（`subjectId = randomUUID()`），使既有 Case 被孤立。

### 下一步

先按 Xero 的做法把委托身份与 OAuth installation 解耦，再重跑线上续写。
在那之前，线上 Bill 与 Invoice 仍未对真实 QuickBooks 验证过——这是本判定
唯一实质性的剩余缺口，且它不是"没人去跑"，是当前构建下跑不通。
