# Work 配置 QuickBooks Ledger MCP

## 结论

Work 与 Agent2 使用同一个 MCP resource：

`https://mcp.jiayuanwang.xyz/quickbooks/mcp`

但它们必须是两个独立的 Host OAuth client。不得共用 `client_id`、`client_secret`、redirect URI、浏览器 origin 或 token family。QuickBooks 与 Xero 也继续保持两个独立 MCP。

2026-08-14 已在 Work 现场创建独立配置，实际值为：

- MCP 显示名：`QuickBooks Accounting MCP`
- Unique Server Identifier：`quickbooks-accounting-mcp`
- Work OAuth callback：`https://work.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback`
- Work origin：`https://work.zcloak.ai`
- 验收 Agent：`QuickBooks 会计助手 UAT`（`agent_PDFaOu-_2bd-vRDVHmDYY`）
- 验收模型：`deepseek/deepseek-v4-pro`

Client ID 和 secret 不写入仓库。首次创建期间出现在调试证据中的临时 secret 已作废；部署只能使用随后在 Work 编辑页轮换后的 secret。

## 首次配置

1. 在 Work 新建 QuickBooks MCP，填写上面的 resource URL。
2. 从 Work 页面复制它实际生成的 OAuth callback。当前实例的实测值见上文；重建 MCP 时仍须重新复制，不能沿用旧 identifier 猜测。
3. 记录 Work 页面实际使用的 HTTPS origin。
4. 生成一组只属于 Work 的随机 `client_id` 和至少 32 字符的随机 secret；secret 只进入部署 secret store 和 Work 的受保护配置，不写入仓库、文档或聊天证据。
5. 在 `QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON` 中增加 Work 条目：

```json
{
  "name": "Work",
  "client_id": "<distinct-work-client-id>",
  "client_secret": "<distinct-work-secret>",
  "redirect_uris": ["<exact-callback-copied-from-work>"],
  "allowed_origins": ["<exact-work-https-origin>"]
}
```

   切换到 registry 时必须移除旧的 `QUICKBOOKS_MCP_OAUTH_CLIENT_ID`、`QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET` 和 `QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS`；两套配置同时存在会启动失败。
6. 同一 Work origin 也必须出现在全局 `QUICKBOOKS_MCP_ALLOWED_ORIGINS`。启动时若缺失会直接失败，避免 registry 与 HTTP 边界配置漂移。
7. 部署后先检查 OAuth discovery，再在 Work 发起连接。Intuit 侧 callback 仍然只有：

`https://mcp.jiayuanwang.xyz/oauth/quickbooks/callback`

8. 连接完成后，用 Work 实际要求的模型执行真实长对话 UAT，并保存 tool receipt、provider ID 和 exact read-back 证据。

## 安全与产品边界

- redirect URI 是逐字精确匹配；禁止 wildcard、fragment、userinfo 或跨 client 复用。
- MCP access/refresh token、authorization code 和 revoke 都绑定签发它们的 Host `client_id`；另一个 Host 的 secret 不能兑换、刷新或撤销。
- 浏览器带 `Origin` 时，必须同时通过全局 edge allowlist 和 token 所属 Host client 的 origin allowlist。
- 当前 Broker 能证明“这是一次隔离的安装及其 QuickBooks Company 绑定”，但不能证明 Work 中真实的用户、Workspace 或角色。因此身份保证等级为 `INSTALLATION_ONLY`。
- `INSTALLATION_ONLY` 不会自动扩大写权限。任何写入仍须同时通过 scope、写入总开关、released capability、exact Company target、standing delegation、幂等、provider receipt 和 exact read-back。
- 只有未来接入可验证的 Work identity assertion，才允许标记 `TRUSTED_HOST_CONTEXT`。不能用请求 header、模型参数或 Broker 自造字段冒充。
- 对外 Client Intake Agent 不应挂载账本凭据；QuickBooks MCP 面向内部会计 Agent。

## Agent2 兼容

Agent2 callback 保持：

`https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback`

旧的单 client 环境变量仍可读取，作为迁移兼容；新部署必须使用多 client registry，避免继续形成 Agent2 专用结构。
