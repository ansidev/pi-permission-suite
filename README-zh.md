<p align="right">
  <a href="README.md">🇬🇧 English</a>
</p>

# Pi Permission Suite

> 四种审批模式 + 指令级安全限制的 Pi 扩展。

为 Pi coding agent 提供 **Act / Auto / Ask / Plan** 四种权限模式、命令和路径规则引擎、以及 subagent 自动审批。基于 [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system) 增强改造。

> **Fork 来源：** `@gotgenes/pi-permission-system` → [`Eddie0521/pi-permission-suite`](https://github.com/Eddie0521/pi-permission-suite) → 本 fork（[`ansidev/pi-permission-suite`](https://github.com/ansidev/pi-permission-suite)）。本 fork 新增可插拔的 Decision API（subagent / Jev / HTTP provider、审计日志、`decision.modes`）、`tools` 通配符与参数条件 allow/deny 规则，以及 `/pi-permission-suite debug on|off`。

## 安装

```bash
pi install git:github.com/ansidev/pi-permission-suite
```

> 请勿使用 `npm:pi-permission-suite`：该 npm 包由上游项目发布，不包含本 fork 的改动。可用 `@<tag-或-commit>` 固定版本，或用 `pi -e git:github.com/ansidev/pi-permission-suite` 临时试用。本地克隆：`npm install && pi install ./`。

安装后重启 pi，你会获得：
- `/approval-mode` 命令切换四种模式
- `set_approval_mode` 工具（agent 可调用）
- `Ctrl+Q` 快捷键循环切换模式
- 规则引擎自动拦截危险命令
- Subagent 自动审批复杂工具调用

## 模式

| 模式 | 图标 | 快捷键 | 说明 |
|------|------|--------|------|
| Act | ⚡ | Ctrl+Q | 完全权限（默认） |
| Auto | 🤖 | Ctrl+Q | subagent 审批不确定的调用 |
| Ask | ❓ | Ctrl+Q | 只读问答，写工具禁用 |
| Plan | 📋 | Ctrl+Q | 只读计划，写工具禁用 |

**Ask/Plan 可用工具：** `read`, `grep`, `find`, `ls`, `question`, `questionnaire`, `web_search`, `fetch_content`, `get_search_content`, `get_subagent_result`, `goal_complete`, `steer_subagent`, `Agent`, `set_approval_mode`

## 命令

```bash
/approval-mode [ask|auto|act|plan]  # 切换模式
/pi-permission-suite debug on|off    # 打印 Decision API 调用/响应消息（默认关闭）
```

## 工具（agent 可调用）

```typescript
// agent 可以通过调用此工具自动切换模式
set_approval_mode({ mode: "plan" })  // 切换到只读计划模式
set_approval_mode({ mode: "act" })   // 切换到完全权限模式
```

## 规则引擎

### 评估优先级

```
deny 规则（硬阻断，任何模式不可覆盖）
  ↓ 未命中
allow 规则（自动放行，跳过模式检查）
  ↓ 未命中
session always rules（交互式临时规则）
  ↓ 未命中
模式层决策（ask/plan 阻断写操作，act 放行，auto 走 AI 审查）
```

### Deny 规则（所有模式生效）

**bash 命令：**
- tree-sitter 解析链式命令（`&&`、`||`、`;`、`|`）
- 识别命令替换 `$(...)` 和子 shell
- 通配符匹配：`"sudo *": "禁止 sudo"`
- 硬编码灾难命令兜底：`rm -rf /`、`fork bomb`、`curl|bash`

**文件路径（跨工具）：**
- `read`/`write`/`edit`/`bash` 都受 path 规则约束
- symlink 解析防绕过
- 通配符匹配：`"*.env": "禁止访问环境变量文件"`

### Allow 规则

| 类别 | 命令 |
|------|------|
| 文件查看 | `cat`, `head`, `tail`, `less`, `more`, `wc`, `file`, `stat` |
| 目录/搜索 | `ls`, `tree`, `find`, `grep`, `rg` |
| Git | `status`, `log`, `diff`, `show`, `branch`, `tag`, `remote`, `describe`, `blame`, `reflog` |
| 系统状态 | `ps`, `top`, `df`, `du`, `free`, `uptime`, `uname`, `id`, `whoami` |
| 包管理 | `npm list/info/view`, `pip list/show`, `cargo tree`, `go list` |
| Docker | `docker ps/images/logs/inspect/version` |
| 压缩文件 | `zcat`, `zgrep`, `unzip -l`, `tar -t` |
| 文本处理 | `awk`, `sed`, `jq`, `sort`, `uniq`, `cut`, `tr`, `diff` |
| 网络 | `curl`, `wget`, `ping`, `dig`, `traceroute`, `whois`, `netstat` |

## 配置

默认规则在 `config.default.json` 中。

用户自定义配置在 `~/.pi/agent/extensions/pi-permission-suite/config.json`。首次加载时自动从默认文件创建。

```jsonc
{
  // bash 命令规则
  "bash": {
    "deny": {
      "rm -rf /": "禁止删除根目录",
      "sudo *": "禁止 sudo",
      "curl * | bash": "禁止远程代码执行"
    },
    "allow": {
      "bun test": true,
      "bun run *": true,
      "git status": true,
      "git diff": true,
      "cat *": true
    }
  },
  // 工具名规则（通配符 `*` / `?`），例如 MCP 工具
  "tools": {
    "deny": {
      "dangerous_*": "禁止危险工具"
    },
    "allow": {
      "list_*": true,
      // 按参数匹配：放行 `mcp({describe})` / `mcp({search})`，不放行 `mcp({tool, args})`
      "mcp": [
        { "args": { "describe": true, "tool": false } },
        { "args": { "search": true, "tool": false } }
      ]
    }
  },
  // 跨工具文件路径规则
  "path": {
    "deny": {
      "*.env": "禁止访问环境变量文件",
      "~/.ssh/*": "禁止访问 SSH 密钥"
    },
    "allow": {
      "*.env.example": true
    }
  },
  // CWD 外路径策略："mode" | "deny" | "allow"
  "external_directory": "mode"
}
```

### 配置语义

- `deny` 下的规则 → 硬阻断，任何 Mode 都不能覆盖（包括 `act`）
- `allow` 下的规则 → 自动放行，不经过 Mode 层
- 都不命中 → 交给 Mode 层决策
- `tools.deny` / `tools.allow` 按工具名匹配（`*`、`?` 通配符，最后一条命中者生效），`bash` 的命令规则除外。`tools.deny` 在所有模式下都会阻断，且优先于 `tools.allow`；`tools.allow` 条目的值需为 `true`。缺少 `tools` 段不影响现有行为。路径 deny 规则仍然优先于 `tools.allow`。
- `external_directory`: `"mode"` = 未命中规则时走 Mode 层；`"deny"` = 硬阻断；`"allow"` = 放行

### 基于参数的工具规则

`tools` 规则还可以匹配调用的输入字段，从而按调用方式区分同一个工具。原有写法（`true`、`"原因"`）保持不变。

- allow 值：`true` / `false` / `{ "args": {...} }` / `{ "args": {...} }` 数组
- deny 值：`"原因"` / `{ "reason": "...", "args": {...} }` / 上述形式的数组
- `args` 把输入字段映射到条件，**所有**字段都必须满足：
  - `true` = 字段存在（非 null/undefined/空字符串）
  - `false` = 字段不存在
  - `"pattern"` 或 `["p1", "p2"]` = 字段的字符串值匹配通配符（`*`、`?`）；非标量值永不匹配
- 数组各项之间为「或」关系。`args` 不满足的条件项会继续向前匹配更早的规则；没有 `args` 的条目始终命中。
- deny 先评估，在任何模式下都优先于 allow。

示例：放行 `mcp` 代理的 `describe` / `search` 查询，但不放行 `mcp({ tool, args })` 调用：

```json
"tools": {
  "allow": {
    "mcp": [
      { "args": { "describe": true, "tool": false } },
      { "args": { "search": true, "tool": false } }
    ]
  },
  "deny": {
    "mcp": { "reason": "危险的 MCP 调用", "args": { "tool": "*_delete_*" } }
  }
}
```

### Decision provider 配置

Auto 模式会把规则未决的调用交给 Decision provider。配置在 `decision` 下（均可选，无效值回退默认值）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `provider` | `"subagent"` | `subagent`、`jev` 或 `http` |
| `endpoint` | — | `http` provider 的 URL（`decision.http.url` 优先） |
| `apiKeyEnv` | — | 存放 API key 的环境变量名，以 `Authorization: Bearer <key>` 发送。key 本身不写入配置。 |
| `confidenceThreshold` | `0.7` | 低于该值结果为 `ask` |
| `timeoutMs` | `10000` | 单次调用超时，超时结果为 `ask` |
| `audit.enabled` | `true` | 是否写审计日志 |
| `audit.path` | `~/.pi/agent/extensions/pi-permission-suite/decision-audit.jsonl` | 审计日志文件 |

```json
{ "decision": { "provider": "http", "endpoint": "https://decision.example.com/v1/decide",
                "apiKeyEnv": "DECISION_API_KEY", "confidenceThreshold": 0.8, "timeoutMs": 5000 } }
```

### 审计日志

每次 provider 决策向审计文件追加一行 JSON：`time`、`tool`、`mode`、`call`（单行摘要，最长 200 字符）、`provider`、`verdict`、`confidence`、`reason`、`fallback`、`outcome`（`approved`/`denied`）、`decidedBy`（`provider`/`human`/`rules`）。不会写入 API key 或完整的工具输入。写入失败会被忽略，不影响工具调用。

## 项目结构

```
pi-permission-suite/
├── index.ts              # 主逻辑
├── types.ts              # 公共类型
├── rules.ts              # 规则引擎
├── tool-rules.ts         # 工具规则与参数条件
├── approver.ts           # 审批器
├── decision-provider.ts  # Decision API provider 接口
├── jev-provider.ts       # Jev (System One) decision provider
├── http-decision-provider.ts # 通用 HTTP decision provider
├── decision-audit.ts     # Decision 审计日志 (JSONL)
├── subprocess-runner.ts  # 子进程调用
├── bash-parser.ts        # tree-sitter bash 解析
├── wildcard-matcher.ts   # 通配符匹配
├── path-utils.ts         # 路径工具
├── config-loader.ts      # 配置加载
├── config.default.json   # 默认规则
├── README.md             # 英文版
└── README-zh.md          # 本文件（中文版）
```

## License

MIT — fork 自 [`Eddie0521/pi-permission-suite`](https://github.com/Eddie0521/pi-permission-suite)（MIT），其基于 [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system)（MIT）。
