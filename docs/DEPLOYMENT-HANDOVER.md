# QuickBooks Ledger MCP — 部署交接

给接手部署到公司服务器的工程师。这份文档把两件事分开写：

- **服务需要什么** —— 必须满足的前置条件和配置，不满足就跑不起来或不安全。
- **我们碰巧怎么跑它** —— 一种可行的部署方式，不是唯一方式。你完全可以换成公司的
  Kubernetes、CI 或别的反向代理。

## 服务本身没有主机绑定

`src/` 与 `migrations/` 里没有任何硬编码的主机名、IP 或路径。对外身份只有一个来源：
`QUICKBOOKS_PUBLIC_BASE_URL`。所有回调地址、OAuth 元数据文档、撤销端点都由它派生，
换域名只改这一个变量。

`deploy/` 下的脚本原本写死了我们的域名和 nginx 站点文件，已改为环境变量加默认值。
发布门禁（`deploy/verify-static.sh`）原本断言 `env.example` 里必须出现我们的域名——
也就是说你换成公司域名后门禁会失败——现在改为校验**形状**（必须是绝对 https URL），
换任何域名都能通过，而 `http://` 或空值仍然会被拦下。

## 前置条件

| | 要求 | 说明 |
| --- | --- | --- |
| 运行时 | Node 22（见 `deploy/Dockerfile`） | 容器以非 root `10001:10001` 运行，只读根文件系统 |
| 数据库 | PostgreSQL 14 及以上 | 迁移在启动时自动执行；需要建表权限 |
| 网络 | 两个 Docker 外部网络 | `compose.yaml` 期望 `quickbooks-egress` 与 `quickbooks-data` 已存在。<br>数据面不出网、出网面不碰库，是刻意的隔离，换编排方式时请保留这个性质 |
| 反向代理 | 终止 TLS，转发到容器 3000 端口 | 容器只监听 `127.0.0.1`，不直接对外 |
| 出站白名单 | `appcenter.intuit.com`、`oauth.platform.intuit.com`、`developer.api.intuit.com`、`quickbooks.api.intuit.com`（沙盒为 `sandbox-quickbooks.api.intuit.com`） | 授权、令牌、discovery/撤销、业务 API |

## 必填配置

无默认值，缺一个服务就拒绝启动（这是刻意的，不要加默认值绕过）：

```
QUICKBOOKS_PUBLIC_BASE_URL           对外根地址，https，无尾斜杠
DATABASE_URL                         PostgreSQL 连接串
QUICKBOOKS_CLIENT_ID                 Intuit 应用凭据
QUICKBOOKS_CLIENT_SECRET
QUICKBOOKS_TOKEN_ENCRYPTION_KEY_B64  32 字节，base64；令牌落库前用它加密
QUICKBOOKS_MCP_BEARER_TOKEN          MCP 传输层令牌
QUICKBOOKS_MCP_OAUTH_CLIENT_ID       MCP OAuth
QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET
QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON   宿主客户端及其回调地址
```

完整清单见 `deploy/env.example`（30 项）。几个需要你决策的：

- **`QUICKBOOKS_ENVIRONMENT`** —— `sandbox` 或 `production`。生产密钥连不了沙盒，
  开发密钥连不了真实账套，两者不通用。
- **`QUICKBOOKS_WRITE_TARGET_MODE`** —— `exact_allowlist` 把写入钉死在
  `QUICKBOOKS_ALLOWED_REALM_ID` 指定的一个账套（试用期建议）；`oauth_bound` 则写入
  每个用户各自授权的账套（多租户生产用这个，此时不需要填 realm）。
- **`QUICKBOOKS_WRITE_ENABLED`** —— `env.example` 里默认 `false`。**首次部署请保持
  false**，确认健康检查和连接流程都正常后再开。
- **`QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES`** 与 **`QUICKBOOKS_STANDING_DELEGATION_ACTIONS`**
  —— 白名单。不在名单里的动作即使代码支持也会 fail closed。当前已释放 12 个动作，
  值照抄 `env.example`。

`QUICKBOOKS_TOKEN_ENCRYPTION_KEY_B64` 一旦投产就不能更换：已加密的刷新令牌解不出来，
所有连接都要重新授权。生成方式 `openssl rand -base64 32`。

## 部署与验证

镜像构建与启动见 `deploy/compose.yaml`；`deploy/redeploy-0.6.0.sh` 是我们用的蓝绿脚本
（起候选容器 → 校验它确实是目标构建 → 才改反向代理指向），可以参考也可以不用。
如果沿用，注意两个环境变量：`QUICKBOOKS_NGINX_SITE_FILE` 指向站点文件，
`QUICKBOOKS_CANDIDATE_PORT` 指定候选容器端口。

**验证只看一个地方**，`GET ${QUICKBOOKS_PUBLIC_BASE_URL}/quickbooks/healthz`，无需鉴权：

```json
{
  "version": "0.6.0",
  "toolCount": 19,
  "compilerVersion": "0.4.0",
  "readiness": { "ready": true, "migrations": { "latestExpected": "038_..." } },
  "writeControl": { "enabled": true, "targetMode": "..." },
  "releasedActions": { "count": 12 }
}
```

`ready: false` 时 `readiness` 里会写明原因（数据库不通、迁移缺失、校验和不符）。

两个已知的运维现象，不是故障：

- **同库多版本时，旧容器会自报 NOT_READY。** 就绪检查会数超出自己预期集合的迁移，
  所以任何前滚迁移都会让仍在服务的旧构建变成未就绪。蓝绿切换期间出现属正常。
- **反向代理重载是异步的。** promote 之后立刻查健康检查可能读到旧上游，脚本里已经
  改成轮询等待，不要据此判定发布失败。

## 交接时仍然悬空的三件事

1. **生产密钥尚未申请。** 现在跑的是沙盒环境和开发密钥。流程与逐题准备好的问卷答案
   见另一份材料；需要公司提供 EULA、隐私政策 URL、法律实体信息、托管地区与支持邮箱。
2. **更正与作废未实现。** 已释放的 12 个动作全是 CREATE。记错的凭证目前只能在
   QuickBooks 界面手工改删，产品内改不了。这一条对试用范围影响很大，务必先讲清楚。
3. **`replaceActive` 换绑时不通知 Intuit。** 同账套重新授权会在本地把旧连接标记为
   REVOKED，但不调用撤销端点。这是刻意的——同 realm 重连时 Intuit 会撤销整条授权链，
   贸然撤旧令牌可能把刚签发的一并作废。需要单独定方案，不要顺手加。

## 安全上不要动的几件事

这些不是风格偏好，都是有事故背景的：

- 容器非 root、只读根文件系统、`no-new-privileges`、只监听回环——发布门禁会检查。
- 数据面与出网面分离的两个网络。
- 日志走 `safeContextKeys` 白名单，未列入的键一律脱敏。有测试扫描全部
  logger 调用并在发现未白名单的键时**指名文件和行号**失败——这个坑咬过四次，
  每次都是「测试全绿、生产日志全是 [REDACTED]」，因为测试注入的是不脱敏的 mock。
- 写入生命周期的持久化不变量（执行围栏、dispatch 标记不可变、写入三态、精确回读）
  由数据库触发器与约束保证。绕过它们就等于放弃「不重复入账」这个保证。

## 跑测试

```
npm test                     # 单元，346 项
npm run verify:release       # 完整发布门禁
```

Postgres 集成测试需要 `TEST_DATABASE_URL`，且**每个测试文件用一个全新数据库**——
多个文件对同一个库并发跑迁移会互相竞争而失败。
