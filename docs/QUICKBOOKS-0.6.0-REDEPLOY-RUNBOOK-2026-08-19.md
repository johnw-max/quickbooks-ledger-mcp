# QuickBooks 0.6.0 重新部署 runbook（2026-08-19）

## 为什么要重新部署

线上 `https://mcp.jiayuanwang.xyz/quickbooks/mcp` 当前跑的是修复前的构建。
`GET /quickbooks/healthz` 自报迁移头仍是 `034`。在那个构建上，Accounting Case
路由的 Bill 创建必然撞 `FORBIDDEN / MCP_SCOPE` —— 那是 16 轮线上 UAT 的 T13。
UAT 停在 T01 不是没人跑，是跑不动。

本次要上的是分支 `codex/qbo-real-accountant-uat`，提交 `8d0300b`（含可重复运行的 promote 脚本），
迁移头 `035_quickbooks_mcp_scope_predispatch_rearm.sql`。

## 前置事实（已在本地验证）

- 完整 release gate 8 项通过，含真实 SIGKILL 的崩溃恢复证据。
- `deploy/Dockerfile` 用当前代码本地构建通过，产出镜像内含迁移 035，版本 0.6.0。
- `deploy/verify-static.sh` 通过。

## 部署前必须知道的两件事

### 1. 迁移 035 必须先于新代码生效，否则服务会 fail closed

`inspectQuickBooksRuntimeReadiness` 从镜像自带的 `migrations/` 目录推导期望集合。
新镜像带 035，数据库若还没应用，`missingCount > 0` → `/readyz` 不 ready →
compose healthcheck 不通过 → 候选容器永远不健康 → promote 脚本拒绝提升。

这是**正确**行为，不是故障。容器启动时会自行跑迁移（`npm run start` 前的
migrate 步骤见 `deploy/` 与 `src/quickbooks/migrate.ts`）。若候选容器迟迟不健康，
先看它的日志确认迁移是否成功，不要去动 nginx。

### 2. 旧构建重启不会自动回退到安全状态

与 Xero 的授权快照不同，本服务没有 revision 单调机制。回滚 = 用旧镜像起一个新候选
并 promote 回去。数据库里的 035 迁移不会被回滚，但 034 代码不依赖它，可以共存。

## 步骤

在部署主机上执行。`<REPO>` 是主机上的仓库路径。

### 1. 取到本次要部署的代码

```bash
cd <REPO> && git fetch origin && git checkout codex/qbo-real-accountant-uat && git reset --hard 8d0300b
```

确认拿到的是对的东西：

```bash
git log --oneline -1 && ls migrations/ | tail -1
```

应当看到 `8d0300b` 与 `035_quickbooks_mcp_scope_predispatch_rearm.sql`。

### 2. 构建候选镜像

```bash
docker build -f deploy/Dockerfile -t quickbooks-ledger-mcp:0.6.0-8d0300b .
```

### 3. 起候选容器（**不要**用现役容器的名字）

现役容器仍在服务生产流量，名字被占。候选必须另起一个名字，且必须同时挂
egress 与 data 两张网 —— promote 脚本会检查这一点，并且会在容器内部真打一次
Intuit token 端点，拿不到 4xx 就拒绝提升。

```bash
COMPOSE_PROJECT_NAME=qbo-0-6-8d0300b QUICKBOOKS_APP_IMAGE=quickbooks-ledger-mcp:0.6.0-8d0300b QUICKBOOKS_LOOPBACK_PORT=18004 docker compose -f deploy/compose.yaml --env-file deploy/.env.deploy up -d
```

`deploy/.env.deploy` 需提供 `QUICKBOOKS_EGRESS_NETWORK` 与
`QUICKBOOKS_DATA_NETWORK`；`.env.quickbooks` 是容器内的应用环境变量，沿用现役那份。

### 4. 等健康并自查

```bash
docker ps --filter name=qbo-0-6-8d0300b --format '{{.Names}}\t{{.Status}}'
```

等到 `healthy`。然后直接问候选自己的 readiness，确认迁移头已经是 035：

```bash
docker exec <候选容器名> node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>r.json()).then(d=>console.log(d.version, d.toolCount, d.readiness.migrations.latestExpected, d.readiness.ready))"
```

期望输出包含 `0.6.0`、`18`、`035_quickbooks_mcp_scope_predispatch_rearm.sql`、`true`。
**任何一项对不上就停在这里**，不要 promote。

### 5. 提升

```bash
sudo node deploy/promote-qbo-candidate.mjs <候选容器名>
```

脚本会依次校验：运行中且健康、至少两张网、主网有 IPv4、容器内 Intuit egress
可达（4xx 即通过），然后备份 nginx 配置、改写 upstream、`nginx -t`、reload。
任一步失败自动回滚配置并重载。

成功输出形如：

```json
{"status":"QBO_CANDIDATE_PROMOTED","candidateName":"...","candidateAddress":"...","previousUpstream":"server ...;","backup":"/etc/nginx/sites-enabled/....pre-qbo-0.6-..."}
```

**记下 `backup` 路径和 `previousUpstream`**，回滚要用。

### 6. 从外部确认

```bash
curl -s https://mcp.jiayuanwang.xyz/quickbooks/healthz | python3 -m json.tool | head -20
```

`readiness.migrations.latestExpected` 必须是 `035_...`。这是判断"新构建真的在服务
流量"的唯一可信信号 —— `version` 仍是 `0.6.0`，看不出区别。

### 7. 收尾

确认线上稳定后再停旧容器，不要提前停：

```bash
docker stop <旧容器名>
```

## 回滚

promote 脚本已备份 nginx 配置。回滚就是把备份放回去并 reload：

```bash
sudo cp <backup 路径> /etc/nginx/sites-enabled/mcp.jiayuanwang.xyz && sudo nginx -t && sudo systemctl reload nginx
```

旧容器若已停，需先重新起来再改回 upstream。数据库里的 035 迁移保留即可，
034 代码不依赖它。

## 部署后：恢复线上 UAT

部署确认后，线上 UAT 从 T02 继续（T01 已于 2026-08-15 通过）。执行细节见
`docs/QUICKBOOKS-REAL-ACCOUNTANT-UAT.md` 与
`harness/real-accountant/real-accountant-qbo-v1.scenario.json`。

关键前置：Work 侧 Agent 必须**重新授权 OAuth**，因为它此前绑定的是旧构建的
installation。测试矩阵与证据写入
`evidence/online-uat/quickbooks-work-deepseek-v4-2026-08-15/`。

`promotionAssertion.onlineAgentUatRequired` 会一直是 `true`，直到那 16 轮真的跑完 ——
服务自己不会因为部署成功就认为验收通过。
