# Codex、Claude Code、Cursor

rolemem 是一个你自己运行的 MCP 服务。三个客户端共用同一把连接方式：HTTP MCP，`Authorization: Bearer rmk_…`。记忆工具和工作连续性工具是同一套，没有三套业务逻辑。

接上 MCP **不会**自动保存每一条聊天、终端输出、环境变量或密钥。模型只有在调用 `remember` 或 `update_work` 时才会写入。下面的「本仓库验证」列只统计这个仓库里真实跑过的测试。没有在 Codex、Claude Code 或 Cursor 的产品界面里点过的项，标成待实际验证。

## 能力

| 能力 | Codex | Claude Code | Cursor | 本仓库 |
|---|---|---|---|---|
| HTTP MCP + Bearer 头 | 配置格式见下 | 配置格式见下 | 配置格式见下 | 已实现并通过测试（协议和鉴权，不是产品 UI） |
| `remember` / `recall` / `update` / `list_memories` / `forget` | 模型可调用 | 同左 | 同左 | 已实现并通过测试 |
| `start_work` / `update_work` / `get_work` / `list_work` / `resume_work` / `complete_work` | 模型可调用 | 同左 | 同左 | 已实现并通过测试。两个不同的连接密钥可以接力 |
| 会话开始自动 `resume_work` | 没有内建。需要模型遵守说明，或你自己写 hook | 同左。Claude Code 有 SessionStart 一类 hook，本环境未安装 CLI，未实测 | 同左。Cursor 的 hook 是本地命令，本环境未实测 | 仅设计。服务器不安装 hook |
| 连上后自动记下每条消息 | 不支持 | 不支持 | 不支持 | 故意不做 |
| 无模型的工作摘要 | `get_work` / `complete_work` 的 `summary` | 同左 | 同左 | 已实现并通过测试。`used_model` 恒为 false |
| 诊断 | `npm run connect -- codex` | `npm run connect -- claude-code` | `npm run connect -- cursor` | 配置字符串有单元测试。命令要连正在跑的服务器，本环境未对官方 CLI 执行 |

## 连接

先启动服务器，在管理页生成密钥，或：

```bash
npm run connect -- cursor     # codex、claude-code、url
```

`connect` 会吊销同名旧密钥，并写入带 Bearer 头的配置。服务器只保存哈希。

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

不能加请求头的客户端才能用 `https://memory.example.com/mcp/rmk_…`。这个 URL 等于密码，可能进代理日志。

## 接力时模型该做什么

会话开始时调用 `resume_work`。有进行中的任务就按返回的事实、已完成、失败、未验证假设、阻塞和下一步继续，并用 `update_work` 把新的步骤写回去。另一个客户端再 `get_work` 或 `resume_work`，读到的是服务器上的同一行。

没有进行中的任务时，`resume_work` 返回相关长期记忆和最近标题，`found` 为 false。不要把假设写成事实，不要编造测试结果或文件路径。只有真的跑过、并且写进 `append_test_result` / `append_file` 的内容才会出现在摘要里。

长期偏好用 `remember`。进行中的任务用 work 工具。两边不要混成一条聊天记录。

## 建议写进客户端说明的一段话

可以放进 `AGENTS.md`、`CLAUDE.md` 或 Cursor rule。这只是给模型的文字，不是自动采集。

```text
At the start of a task, call rolemem resume_work before asking for background.
Record durable facts with remember. Record progress with update_work.
Do not assume the server saw this chat. It only stores tool calls.
```

## 排错

| 现象 | 先看 |
|---|---|
| 401 | 密钥是否被吊销，或误把管理员 token 当成 MCP 密钥 |
| 工具列表里没有 `resume_work` | 服务器是否还是 0.3.0。0.4.0 才有工作工具 |
| `resume_work` 说没有任务 | 另一个客户端没有调用 `start_work`，或任务已完成。完成的任务要 `get_work` 按 id 读 |
| 摘要里没有测试结果 | 没人记录过。服务器不跑测试，也不调用模型 |
| 密钥出现在日志 | 用了 `/mcp/<key>`。改成 Authorization 头 |
| 管理页打不开数据 | `ROLEMEM_ADMIN_TOKEN`，以及 `GET /healthz` |

健康检查：`GET /healthz` 返回 `{ "ok": true, "version": "0.4.0" }`。
