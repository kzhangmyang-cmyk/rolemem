# Security

rolemem stores personal memory in a SQLite file on a machine you run. The operator, not the software, decides who can reach that machine. This is not end-to-end encryption, and it is not a multi-tenant product.

## What the server actually does

- One admin token (`ROLEMEM_ADMIN_TOKEN`) authorizes every HTTP call. There is no registration and no password database. The token is compared by hashing both sides first, so the check does not leak the length.
- MCP connection keys are separate. Only a SHA-256 is stored. Revoking a key cuts that client off on the next request. A key can read and write the whole archive, including memories other models saved.
- Deleted memories stay as markers. An older export cannot recreate them. That is a merge rule, not a guarantee against someone who holds the admin token and a newer file.
- Memories from MCP clients and from pasted ChatGPT, Claude, or Gemini text are matched against a short list of injection phrases. Hits sit in quarantine and are left out of the digest until you approve them. Native JSON import is not screened, because a round-trip of your own archive has to be exact. The list misses rephrased attacks.
- Optional PII masking exists only on export, and only when `maskPii=1`. It is off by default. It is a regex, not a redaction policy.
- A per-process rate limit slows loops. It resets on restart, it is not shared across copies of the server, and without `ROLEMEM_TRUST_PROXY=1` every caller shares one bucket.

## What you have to do

- Choose a token of at least 16 random characters. Production refuses to start with a shorter one. Anyone with the token can read, edit, export, and delete the archive.
- Terminate HTTPS on Caddy or a Cloudflare Tunnel. See the README. Do not put port 8787 on the public internet.
- Prefer `Authorization: Bearer` for MCP. A key placed in `/mcp/<key>` can be stored in proxy and browser logs. Treat that URL as a password.
- Back up the SQLite file and the admin token separately from any machine you do not control. The file is the memory. There is no second key that protects it at rest.
- If you run more than one replica, do not point them at one SQLite file and expect the rate limit to mean anything. This build is one process.
- Set `ROLEMEM_TRUST_PROXY=1` only when the proxy in front overwrites `X-Forwarded-For`. Clients can spoof that header otherwise.

## Reporting

Open an issue with the impact and how to reproduce it. Do not include a real admin token, connection key, database, or memory text.

## 安全（中文摘要）

记忆是你自己机器上的一个 SQLite 文件。软件不替你做端到端加密，也不是多租户服务。管理员 token 能读写全部记忆；MCP 密钥同样能读写全部记忆，服务器只保存它的哈希。删除标记用来阻止旧导出把记忆复活，挡不住持有 token 的人。隔离区只匹配明显的注入句式，改写一下就会漏。导出打码默认关闭，而且是正则。限流只在单个进程里。请自己用足够长的 token，用 Caddy 或 Cloudflare Tunnel 提供 HTTPS，能放请求头就不要把密钥写进 URL，并单独备份数据库和 token。
