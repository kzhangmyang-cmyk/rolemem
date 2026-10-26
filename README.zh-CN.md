# rolemem

一份记忆，换模型也不丢。Claude、Cursor、ChatGPT 通过 MCP 读写同一份存档，也可以用一个 JSON 文件导入导出。

[English](README.md)

这是单用户服务。没有注册。一把管理员 token 打开全部记忆，连接密钥只给 MCP 客户端。旧的多用户版本（角色 Agent、拷贝/租借、签名存档）在分支 `legacy-full` 和标签 `v0.2-full`，当前代码里没有 `ROLEMEM_MODE` 开关。

## 运行

优先用 Docker。需要 Node.js 22.18+ 时也可以直接跑源码。

```bash
docker build -t rolemem .
docker run -p 8787:8787 -v rolemem-data:/data \
  -e NODE_ENV=production \
  -e ROLEMEM_ADMIN_TOKEN="$(openssl rand -hex 24)" \
  -e ROLEMEM_PUBLIC_URL=https://memory.example.com \
  -e ROLEMEM_TRUST_PROXY=1 \
  rolemem
```

Compose：在含有本文件的目录放一份 `.env`，写上 `ROLEMEM_ADMIN_TOKEN`，然后 `docker compose up -d`。

```bash
npm install
cp .env.example .env    # 填写 ROLEMEM_ADMIN_TOKEN
npm start               # http://127.0.0.1:8787
```

生产环境的 token 至少 16 个字符，否则进程拒绝启动。非生产环境如果没设 token，会写入 `data/admin.token` 并在日志里打印一次。网页只做查看、编辑、导入、导出和连接密钥，不连接大模型对话。

`GET /healthz` 是健康检查。0.2 的数据库文件不能给这个版本用，留在 `legacy-full` 的检出里。

## 接入客户端

在网页里生成密钥，或：

```bash
npm run connect -- cursor     # 也可以 codex、claude-code、url
```

密钥以 `Authorization: Bearer rmk_…` 发送。服务器只存哈希。

**Cursor**（`~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "rolemem": {
      "url": "https://memory.example.com/mcp",
      "headers": { "Authorization": "Bearer rmk_…" }
    }
  }
}
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.rolemem]
url = "https://memory.example.com/mcp"

[mcp_servers.rolemem.http_headers]
Authorization = "Bearer rmk_…"
```

**Claude Code**：

```bash
claude mcp add --transport http rolemem https://memory.example.com/mcp --header "Authorization: Bearer rmk_…"
```

不能加请求头的客户端用 `https://memory.example.com/mcp/rmk_…`。这个地址就是密码，可能出现在代理日志里。能用请求头就用请求头。

macOS 上 `npm run service -- install` 会在登录时拉起源码进程。Linux 用 Docker。

### 会话一开始模型看到什么

每次 MCP 初始化都会带上**记忆摘要**和写记忆的规矩：什么时候记、写成什么样、什么时候改、什么时候删。同一段文字也是名为 `memory` 的 prompt，以及资源 `rolemem://digest`。模型即使从不调用 `recall`，摘要也已经在上下文里。

记忆不多（大约几百条以内，并且不超过字符上限）时，摘要就是全部。超过上限时保留更重要、更新的条目（偏好和做法优先）。prompt 里如果带了问题，则按字面重合度挑选。摘要里写明被省略的部分，再用 `recall` 查。

工具：`remember`、`recall`、`update`、`list_memories`、`forget`，以及工作连续性的 `start_work`、`update_work`、`get_work`、`list_work`、`resume_work`、`complete_work`。

长期记忆和工作连续性是两套数据。记忆是偏好、事实、项目或做法。工作项是当前目标、状态、已完成、失败尝试、未验证假设和下一步。`resume_work` 一次拿回这些内容；没有进行中的任务时返回相关记忆和最近标题，不编造任务。假设不会被写成事实。

接上 MCP **不会**自动记下每一条聊天、终端输出或密钥。客户端必须自己调用工具。Codex、Claude Code、Cursor 的配置和未实测项见 [docs/clients.md](docs/clients.md)。管理页有 Work 标签。拷贝 SQLite 文件会同时带走记忆和工作项。JSON 导出仍是 version 1，只含记忆，旧文件可以继续导入。

## 可携带的导出

完整例子在 `examples/sample-export.json`。`id` 是规范化正文的 SHA-256（去掉首尾空白，内部连续空白并成一个空格）。同一句话再次导入不会变成第二条。

字段：`version`、`memories[]` 的 `id`、`content`、`type`、`space`、`source_model`、`updated_at`、`deleted`，以及整体 `sha256`。`type` 是 `preference`、`fact`、`project`、`procedure`。`space` 例如 `work`、`life`。

同一条 id 的合并规则：

1. `updated_at` 更新的那份赢，包括它是不是删除。
2. 时间相同，删除赢。
3. 所以旧导出不能把已经删除的记忆复活。你现在重新记住同一句话，时间是新的，可以有意地写回来。

Markdown（`GET /api/export?format=markdown`）含同样字段，可以导回去。粘贴格式（`format=paste`，或 ChatGPT / Claude / Gemini 的记忆导出）是一行一条，可以带 `[日期] -`。粘贴不是无损的：没有删除标记，像指令的句子会进隔离区。JSON 导入不筛查，因此自己的存档来回是原样的。`maskPii=1` 默认关闭，打开后会改写电话、邮箱和证件号样式的数字，id 也会变，只适合把副本交给别人，不适合当备份。

`npm run demo` 在内存数据库里演示一次往返。

## HTTPS

不要把 8787 直接暴露到公网。

**Caddy**（见 `Caddyfile.example`）：

```
memory.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

同时设置 `ROLEMEM_TRUST_PROXY=1` 和 `ROLEMEM_PUBLIC_URL=https://memory.example.com`。

**Cloudflare Tunnel**：

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

长期使用请用命名隧道和自己的域名。上面这条命令给出的是临时地址。

## HTTP API

`/api/*` 使用 `Authorization: Bearer <管理员 token>`。`/mcp` 使用连接密钥。没有 `/api/users`。

| 路径 | |
|---|---|
| `GET /api/memories` | 活跃和隔离中的记忆。可用 `space`、`type`、`status`、`q` |
| `POST /api/memories` | `{ content, type, space, source_model }` |
| `PATCH /api/memories/:id` | 修改。正文变了会换成新 id，旧 id 留下删除标记 |
| `DELETE /api/memories/:id` | 忘记。行还在，导出里 `deleted: true` |
| `POST /api/memories/:id/approve` | 放行一条隔离记忆 |
| `POST /api/quarantine` | `{ "action": "approve" 或 "delete" }` |
| `GET /api/digest` | 会话开始时注入的摘要 |
| `GET /api/export?format=json\|markdown\|paste&maskPii=1` | 下载 |
| `POST /api/import` | `{ document }` 或 `{ source, text, space, type }` |
| `POST /api/connections` | `{ label }`，密钥只返回一次，并带上客户端配置 |
| `GET /api/connections` · `DELETE /api/connections/:id` | 列出和吊销 |

默认限流大约是每分钟 240 次 HTTP、120 次 MCP，只在本进程内存里，重启即清，多副本不共享。放在代理后面时设置 `ROLEMEM_TRUST_PROXY=1`，否则所有客户端算同一个桶。

## 召回质量

`npm test` 覆盖无损往返、重复导入不产生副本、删除不会被旧导出复活，以及 MCP 冒烟。`npm run eval` 用 `eval/fixtures.json` 教一批事实，检查摘要里都有，并检查字面重合的问题能否被 `recall` 命中。

`npm run eval:recall` 用固定的 `eval/recall-bench.json` 比较 0.3 的字面排序和现在的排序。本仓库这一版在 FTS5 可用时跑出 Recall@5 从 0.700 到 1.000、MRR 从 0.650 到 1.000（10 道计分题，0 次退步）。新增命中里有精确记忆 id、项目名和工作项 id，旧排序看不到这些字段。没有共同词的改写（「家在哪个城市」）两边都漏，不算提升。换机器后以脚本输出为准。

这还不是「换任何模型都能几乎全部答对」的验收线。没有共同词的改写问法会漏；还没有让 Claude、Cursor、ChatGPT 同时走 MCP 再打分的测试。FTS5 只在当前 Node 的 SQLite 带这个模块时启用，没有就退回字面重合。服务器不会为了工作摘要去调用模型。

## 0.2 在哪里

角色剧本、跨用户拷贝和租借、能力授权、收件箱、批量回滚、哈希链审计、Ed25519 存档都已从这棵树删除。需要它们时：

```bash
git checkout legacy-full
# 或
git checkout v0.2-full
```

## 开发

```bash
npm test
npm run check
npm run dev
```

安全说明见 [SECURITY.md](SECURITY.md)。架构约定见 [AGENTS.md](AGENTS.md)。MIT 许可。
