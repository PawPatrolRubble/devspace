# DevSpace 软件实现文档

> 本文档详细描述 DevSpace 的系统架构、模块实现、数据流、安全模型与关键设计决策，供开发者深入理解与二次开发参考。

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构](#2-系统架构)
3. [技术栈](#3-技术栈)
4. [目录结构](#4-目录结构)
5. [核心模块详解](#5-核心模块详解)
6. [MCP 工具系统](#6-mcp-工具系统)
7. [OAuth 认证流程](#7-oauth-认证流程)
8. [工作区管理](#8-工作区管理)
9. [文件系统安全与路径校验](#9-文件系统安全与路径校验)
10. [Git Worktree 隔离机制](#10-git-worktree-隔离机制)
11. [Skills 技能系统](#11-skills-技能系统)
12. [Review Checkpoints 变更审查](#12-review-checkpoints-变更审查)
13. [UI / Widget 系统](#13-ui--widget-系统)
14. [配置系统](#14-配置系统)
15. [持久化层](#15-持久化层)
16. [日志系统](#16-日志系统)
17. [CLI 命令行接口](#17-cli-命令行接口)
18. [构建与部署](#18-构建与部署)
19. [测试策略](#19-测试策略)
20. [关键设计决策](#20-关键设计决策)

---

## 1. 项目概述

### 1.1 定位

DevSpace 是一个**自托管的 MCP (Model Context Protocol) 服务器**，将本地开发工作区安全地暴露给 ChatGPT、Claude 等 MCP 客户端。其核心目标是让 AI 模型能够直接在用户本机的真实项目目录中读取、编辑、搜索文件并执行 shell 命令——无需将任何文件上传到第三方。

### 1.2 核心理念

| 原则 | 说明 |
|------|------|
| 远程访问而非委托 | 不是将工作委托给本地编码代理，而是 MCP 客户端通过显式、可检视的工具调用直接操作本地文件 |
| 安全即核心设计 | 从第一版开始就将安全纳入核心设计，而非后续附加 |
| 窄白名单 | 文件系统访问从窄白名单起步，用户显式配置允许的根目录 |
| 显式工具调用 | 优先使用显式、可检视的工具调用，而非自主本地代理循环 |
| 小步验证 | 第一版足够小，以便在添加 UI 或工作流功能前用真实 MCP 客户端验证 |

### 1.3 典型使用场景

```
用户机器                    Tailscale Funnel           ChatGPT
┌─────────────────┐        ┌──────────────┐         ┌──────────┐
│  DevSpace       │◄──────│  HTTPS 隧道   │◄────────│  MCP     │
│  :7676/mcp      │        │  公网 URL    │         │  Client  │
│  ┌────────────┐ │        └──────────────┘         └──────────┘
│  │ 本地项目   │ │
│  │ ~/work/*  │ │
│  └────────────┘ │
└─────────────────┘
```

1. 用户启动隧道并运行 `devspace serve`
2. MCP 客户端连接公网 `/mcp` URL
3. DevSpace 弹出 Owner 密码审批页
4. 用户输入密码批准连接
5. AI 在允许的根目录下打开工作区进行编码

---

## 2. 系统架构

### 2.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP 客户端 (ChatGPT/Claude)               │
└───────────────────────────┬─────────────────────────────────┘
                            │ Streamable HTTP + OAuth Bearer
┌───────────────────────────▼─────────────────────────────────┐
│                      Express HTTP 层                         │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌────────────┐ │
│  │ 请求日志  │  │ OAuth     │  │ 静态资源  │  │ /mcp 端点  │ │
│  │ 中间件    │  │ Auth 路由  │  │ 托管      │  │ (会话管理) │ │
│  └──────────┘  └───────────┘  └──────────┘  └─────┬──────┘ │
└────────────────────────────────────────────────────┼────────┘
                                                     │
┌────────────────────────────────────────────────────▼────────┐
│                   MCP Server (McpServer)                     │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  工具注册层 (registerAppTool)                            ││
│  │  open_workspace / read / write / edit / grep / glob /   ││
│  │  ls / bash / show_changes                               ││
│  └───────────────────────┬─────────────────────────────────┘│
│                          │                                   │
│  ┌───────────┐  ┌───────▼────────┐  ┌──────────────────┐    │
│  │ Workspace │  │ Pi Tools 适配层 │  │ Review           │    │
│  │ Registry  │  │ (后端原语)      │  │ Checkpoints      │    │
│  └─────┬─────┘  └────────────────┘  └──────────────────┘    │
│        │                                                      │
│  ┌─────▼─────┐  ┌────────────┐  ┌────────────┐              │
│  │ Workspace │  │ Skills 加载 │  │ Git 操作    │              │
│  │ Store     │  │             │  │ (worktree) │              │
│  │ (SQLite)  │  └────────────┘  └────────────┘              │
│  └───────────┘                                                │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 请求生命周期

一次工具调用的完整链路：

1. **HTTP 请求** 进入 Express，经过请求日志中间件（生成 `requestId`）
2. **Bearer 认证** — `requireBearerAuth` 校验 OAuth access token
3. **资源校验** — `checkResourceAllowed` 确认请求的 OAuth resource 匹配
4. **会话路由** — 根据 `mcp-session-id` 头找到或创建 `StreamableHTTPServerTransport`
5. **工具分发** — `McpServer` 将 JSON-RPC 请求路由到注册的工具处理函数
6. **工作区校验** — 通过 `workspaceId` 从 `WorkspaceRegistry` 获取工作区
7. **路径安全** — `resolvePath` / `resolveAllowedPath` 校验路径在白名单内
8. **后端执行** — 调用 Pi SDK 的 `createReadTool` / `createEditTool` 等执行实际操作
9. **结果封装** — 生成 `content`、`_meta.card`、`structuredContent` 三层返回
10. **日志记录** — `logToolCall` 记录工具名、路径、耗时、成功/失败

---

## 3. 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| 运行时 | Node.js `>=20.12 <27`（推荐 22 LTS） | 服务端运行时 |
| 语言 | TypeScript 6（`ES2022` + `NodeNext`） | 类型安全 |
| MCP 协议 | `@modelcontextprotocol/sdk` 1.29 | MCP 服务器核心 |
| MCP 扩展应用 | `@modelcontextprotocol/ext-apps` 1.7 | ChatGPT Apps Widget 资源注册 |
| HTTP 框架 | Express 5 | HTTP 服务与中间件 |
| 编码原语后端 | `@earendil-works/pi-coding-agent` 0.79 | read/edit/write/grep/find/ls/bash 工具实现 |
| Diff 渲染 | `@pierre/diffs` 1.2 | 补丁解析与可视化 |
| 数据库 | `better-sqlite3` 12 + `drizzle-orm` 0.45 | 工作区会话持久化 |
| 校验 | `zod` 4 | 工具输入/输出 schema |
| CLI 交互 | `@clack/prompts` 1.5 | `init` 交互式引导 |
| 版本校验 | `semver` 7 | Node 版本范围检查 |
| UI | React 19 + Vite 8 | Widget 卡片渲染 |
| 构建 | Vite（UI）+ tsc（服务端） | 双产物构建 |

---

## 4. 目录结构

```
devspace/
├── src/
│   ├── cli.ts                    # CLI 入口（serve/init/doctor/config/help）
│   ├── server.ts                 # MCP 服务器创建、工具注册、HTTP 路由
│   ├── config.ts                 # 配置加载（env + 文件 → ServerConfig）
│   ├── user-config.ts            # ~/.devspace/ 配置文件读写
│   ├── oauth-provider.ts         # 单用户 OAuth Provider 实现
│   ├── workspaces.ts             # 工作区注册表（open/getWorkspace/路径解析）
│   ├── workspace-store.ts        # SQLite 工作区会话存储
│   ├── roots.ts                  # 路径白名单校验核心
│   ├── pi-tools.ts               # Pi SDK 工具适配层
│   ├── skills.ts                 # 技能发现与读取解析
│   ├── git.ts                    # Git 命令封装
│   ├── git-worktrees.ts          # 托管式 Git Worktree 创建
│   ├── review-checkpoints.ts     # 变更快照与 diff 审查
│   ├── logger.ts                 # 结构化日志
│   ├── db/
│   │   ├── client.ts             # SQLite + Drizzle 连接
│   │   └── schema.ts             # 表结构定义
│   ├── ui/
│   │   ├── workspace-app.tsx     # Widget 主应用（挂载、渲染卡片）
│   │   ├── workspace-app.html    # Vite 入口 HTML
│   │   ├── workspace-app.css     # Widget 样式
│   │   ├── card-types.ts         # 工具卡片类型守卫
│   │   ├── heavy-payload.tsx     # 文件/Diff 重型渲染（懒加载）
│   │   └── review-payload.tsx    # Review diff 渲染（懒加载）
│   └── *.test.ts                 # 内联测试（config/roots/skills/workspaces/review）
├── docs/                         # 用户文档
├── scripts/
│   └── dev-server.mjs            # 开发热重载脚本
├── .github/workflows/ci.yml      # CI（typecheck + test + build + doctor）
├── vite.config.ts                # UI 构建配置
├── tsconfig.json                 # 类型检查配置
└── tsconfig.build.json           # 构建配置（排除 ui 与 test）
```

---

## 5. 核心模块详解

### 5.1 server.ts — MCP 服务器与工具注册

这是整个系统的**编排核心**，位于 `src/server.ts:1267` 的 `createServer()` 是总入口。

#### 关键职责

1. **创建 Express 应用** — 通过 `createMcpExpressApp` 并配置 Host 白名单
2. **组装中间件链** — 请求日志 → OAuth Auth Router → 静态资源 → `/healthz` → `/mcp`
3. **创建 MCP 服务器实例** — `createMcpServer()`（`src/server.ts:454`）注册所有工具
4. **会话管理** — `transports: Map<string, StreamableHTTPServerTransport>` 维护活跃会话

#### `/mcp` 端点处理逻辑（`src/server.ts:1345`）

```
请求到达 /mcp
  │
  ├─ Bearer 认证（requireBearerAuth）
  │     失败 → 401 JSON-RPC 错误
  │
  ├─ Resource 校验（checkResourceAllowed）
  │     不匹配 → 401 "invalid_oauth_resource"
  │
  ├─ 是否有 mcp-session-id?
  │   ├─ 是 → 从 transports Map 取出已有 transport
  │   │       不存在 → 404 "Unknown MCP session"
  │   └─ 否 → 是否 InitializeRequest?
  │           ├─ 是 → 创建新 transport，sessionIdGenerator=uuid
  │           │       onsessioninitialized → 存入 Map
  │           │       创建新 McpServer 并 connect
  │           └─ 否 → 400 "No valid MCP session"
  │
  └─ transport.handleRequest(req, res, body)
```

#### 工具注册模式

每个工具通过 `registerAppTool(server, name, definition, handler)` 注册，定义包含：

- `title` / `description` — 面向模型的说明
- `inputSchema` — Zod schema 定义输入参数
- `outputSchema` — 结构化输出 schema（`resultOutputSchema`）
- `annotations` — MCP 工具注解（`readOnlyHint` / `destructiveHint` / `openWorldHint`）
- `...toolWidgetDescriptorMeta(config, kind)` — 条件附加 Widget UI metadata
- `handler` — 异步处理函数，返回 `content` + `_meta.card` + `structuredContent`

#### 三层返回结构

每个工具返回三层信息以适配不同 MCP 客户端：

| 层 | 字段 | 用途 |
|----|------|------|
| 文本层 | `content: ToolContent[]` | 纯文本结果，兼容所有 MCP 客户端 |
| 元数据层 | `_meta.card` | ChatGPT Apps Widget 渲染数据 |
| 结构化层 | `structuredContent` | 模型可解析的结构化结果 |

---

## 6. MCP 工具系统

### 6.1 工具清单

DevSpace 暴露的核心工具及其注解：

| 工具 | 短名 | 注解 | 说明 |
|------|------|------|------|
| `open_workspace` | `open_workspace` | readOnly | 打开工作区，返回 workspaceId + 指令文件 + 技能 |
| `read_file` | `read` | readOnly | 读取文件（支持 offset/limit 分页） |
| `write_file` | `write` | destructive | 创建或完全覆盖文件 |
| `edit_file` | `edit` | destructive | 精确文本块替换编辑 |
| `grep_files` | `grep` | readOnly | 内容搜索（尊重 ignore 规则） |
| `find_files` | `glob` | readOnly | 文件名 glob 匹配 |
| `list_directory` | `ls` | readOnly | 目录列表 |
| `git_status` | `git_status` | readOnly | Git 工作区状态 |
| `git_diff` | `git_diff` | readOnly | Git diff（支持 path/staged/context） |
| `git_log` | `git_log` | readOnly | 最近 Git 提交记录 |
| `run_shell` | `bash` | destructive + openWorld | Shell 命令执行 |
| `show_changes` | — | readOnly | 聚合变更 diff（仅 `changes` 模式） |

### 6.2 工具命名模式

由 `toolNamesFor(config)`（`src/server.ts:162`）根据 `config.toolNaming` 决定：

- **`short`（默认）**：`read` / `write` / `edit` / `grep` / `glob` / `ls` / `bash`，Git 工具固定为 `git_status` / `git_diff` / `git_log`
- **`legacy`**：`read_file` / `write_file` / `edit_file` / `grep_files` / `find_files` / `list_directory` / `run_shell`，Git 工具固定为 `git_status` / `git_diff` / `git_log`

### 6.3 工具模式

`config.minimalTools` 控制工具暴露面：

- **`minimal`（默认）**：禁用 `grep` / `glob` / `ls`，引导模型用 `bash` + `rg` / `find` / `ls` 等命令行工具
- **`full`**：启用全部专用搜索与目录工具

### 6.4 服务器指令（instructions）

`serverInstructions()`（`src/server.ts:186`）根据配置动态生成模型指令，涵盖：

- 工作区复用规则（不要重复调用 `open_workspace`）
- AGENTS.md 指令文件遵循规则
- 技能读取规则（匹配时先读 SKILL.md）
- 文件检查偏好（优先 read/grep/glob/ls）
- 编辑偏好（edit 优于 write）
- Shell 限制（禁止用 shell 写文件）
- show_changes 调用时机（仅 `changes` 模式）

### 6.5 Pi SDK 适配层（pi-tools.ts）

`src/pi-tools.ts` 是 DevSpace 与 Pi 编码代理 SDK 之间的**薄适配层**。

```
DevSpace 工具 handler
    │
    ▼
resolveAllowedPath()     ← 路径安全校验（roots.ts）
    │
    ▼
createReadTool(cwd)      ← 创建 Pi 工具实例
    │
    ▼
tool.execute(name, params)  ← Pi SDK 执行实际文件操作
    │
    ▼
toMcpContent(result)     ← 转换为 MCP content 格式
    │
    ▼
ToolResponse { content, details, isError }
```

每个适配函数（`readFileTool` / `writeFileTool` / `editFileTool` / `grepFilesTool` / `findFilesTool` / `listDirectoryTool` / `runShellTool`）遵循统一模式：先校验路径，再创建 Pi 工具，再执行，再转换结果。异常被捕获并转为 `isError: true` 的 content。

`runShellTool` 特殊处理超时：默认 30 秒，上限 300 秒（`src/pi-tools.ts:123`）。

---

## 7. OAuth 认证流程

### 7.1 设计：单用户 OAuth

DevSpace 实现**单用户 OAuth Provider**（`src/oauth-provider.ts:171`），不依赖外部身份提供者。Owner 密码即唯一的认证凭据。

### 7.2 完整授权码流程

```
MCP 客户端                DevSpace Express            SingleUserOAuthProvider
    │                          │                            │
    │  1. GET /.well-known/    │                            │
    │     oauth-protected-     │                            │
    │     resource/mcp         │                            │
    │─────────────────────────►│  mcpAuthRouter             │
    │◄───── 资源元数据 ────────│                            │
    │                          │                            │
    │  2. GET /authorize       │                            │
    │     (resource, scope,    │                            │
    │      redirect_uri,       │                            │
    │      code_challenge)     │                            │
    │─────────────────────────►│  provider.authorize()      │
    │                          │───────────────────────────►│
    │                          │  校验 resource + scope      │
    │◄──── HTML 审批表单 ──────│  返回 formHtml()            │
    │                          │                            │
    │  3. POST /authorize      │                            │
    │     owner_token=xxx      │                            │
    │─────────────────────────►│  provider.authorize()      │
    │                          │───────────────────────────►│
    │                          │  safeEquals(token, owner)  │
    │                          │  生成 authorization code    │
    │◄── 302 redirect?code= ──│  存入 codes Map (TTL 5min)  │
    │                          │                            │
    │  4. POST /token          │                            │
    │     grant_type=          │                            │
    │     authorization_code   │                            │
    │     code=xxx             │                            │
    │─────────────────────────►│  exchangeAuthorizationCode │
    │                          │───────────────────────────►│
    │                          │  校验 code + redirect_uri   │
    │                          │  issueTokens()              │
    │◄── access_token +        │  存入 accessTokens Map      │
    │    refresh_token ────────│  (SHA-256 hash 索引)        │
    │                          │                            │
    │  5. POST /mcp            │                            │
    │     Authorization:       │                            │
    │     Bearer <token>       │                            │
    │─────────────────────────►│  requireBearerAuth          │
    │                          │───────────────────────────►│
    │                          │  verifyAccessToken()        │
    │◄── 工具调用结果 ─────────│  返回 AuthInfo              │
```

### 7.3 安全要点

| 机制 | 实现 | 位置 |
|------|------|------|
| Owner 密码比较 | `timingSafeEqual` 防时序攻击 | `oauth-provider.ts:50` |
| Token 存储 | SHA-256 hash 后存储，不以明文索引 | `oauth-provider.ts:369` |
| Authorization Code TTL | 5 分钟 | `oauth-provider.ts:44` |
| Access Token TTL | 默认 1 小时（可配） | `config.ts:10` |
| Refresh Token TTL | 默认 30 天（可配） | `config.ts:11` |
| Redirect URI 白名单 | 默认 `chatgpt.com, localhost, 127.0.0.1` | `config.ts:187` |
| Resource 校验 | `checkResourceAllowed` 防 token 跨资源使用 | `server.ts:1358` |
| HTML 转义 | `htmlEscape` 防 XSS | `oauth-provider.ts:57` |
| Owner 密码强度 | 最少 16 字符 | `config.ts:168` |
| 客户端注册 | `InMemoryOAuthClientsStore` 校验 redirect_uri 主机 | `oauth-provider.ts:141` |

### 7.4 审批页面

`formHtml()`（`src/oauth-provider.ts:66`）生成自包含的 HTML 审批表单，内嵌暗色主题样式，显示客户端名称、scope、resource，要求输入 Owner 密码。密码错误时返回 401 并在表单中显示错误信息，保留隐藏字段以便重试。

---

## 8. 工作区管理

### 8.1 WorkspaceRegistry（workspaces.ts）

`WorkspaceRegistry`（`src/workspaces.ts:64`）是工作区的**内存注册表 + 持久化恢复**双层管理器。

#### 核心数据结构

```typescript
interface Workspace {
  id: string;              // ws_{uuid}
  root: string;            // 工作区根目录绝对路径
  mode: "checkout" | "worktree";
  sourceRoot?: string;     // worktree 模式下的源仓库
  worktree?: WorkspaceWorktree;
  skills: Skill[];
  skillDiagnostics: Diagnostic[];
  activatedSkillDirs: Set<string>;  // 已激活技能目录
}
```

#### 两种打开模式

**Checkout 模式**（`openCheckoutWorkspace`，`src/workspaces.ts:163`）：
- 直接在源目录工作
- `assertAllowedPath` 校验路径在白名单内
- 自动创建目录（`mkdir recursive`）
- 校验目标必须是目录

**Worktree 模式**（`openWorktreeWorkspace`，`src/workspaces.ts:175`）：
- 调用 `createManagedWorktree` 创建隔离 worktree
- 工作区根指向 worktree 路径，sourceRoot 指向源仓库

#### 会话恢复机制

`getWorkspace(workspaceId)`（`src/workspaces.ts:83`）实现了**内存优先 + SQLite 回退**的两级查找：

1. 先查内存 `Map`，命中则 `touchSession` 更新最后使用时间
2. 未命中则查 `WorkspaceStore.getSession(id)`
3. 从持久化记录重建 `Workspace` 对象（重新加载 skills）
4. 校验工作区根仍在允许范围内
5. 放回内存 Map

这确保服务器重启后，客户端仍可使用已有 `workspaceId`（前提是路径仍被允许）。

### 8.2 AGENTS.md 指令文件加载

#### 加载的文件（loadInitialAgentsFiles，`src/workspaces.ts:242`）

通过 Pi SDK 的 `loadProjectContextFiles` 加载上下文指令文件，过滤规则：
- `agentDir`（默认 `~/.codex`）下的文件始终加载
- 工作区根目录**直接子文件**（`dirname(path) === root`）才加载

#### 发现的文件（findAvailableAgentsFiles，`src/workspaces.ts:257`）

递归遍历工作区发现**嵌套**指令文件，作为 `availableAgentsFiles` 返回（仅路径，不含内容），模型需在工作前自行读取。

识别的文件名：`AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD`

跳过的目录：`.git` / `.hg` / `.svn` / `.devspace` / `node_modules` / `dist` / `build` / `.next` / `.turbo` / `.cache`

---

## 9. 文件系统安全与路径校验

### 9.1 roots.ts — 安全基石

`src/roots.ts` 是整个文件系统安全的**基石模块**，所有文件操作工具都依赖它。

#### 核心函数

| 函数 | 作用 |
|------|------|
| `expandHomePath(path)` | 展开 `~` / `~/` / `~\` 为家目录，其他路径原样返回 |
| `isPathInsideRoot(path, root)` | 判断路径是否在根目录内（用 `relative` 检测 `..` 前缀） |
| `assertAllowedPath(path, allowedRoots)` | 断言路径在任一允许根内，否则抛 `AccessDeniedError` |
| `resolveAllowedPath(inputPath, cwd, allowedRoots)` | 先 `resolve(cwd, inputPath)` 再 `assertAllowedPath` |

#### 防穿越逻辑

`isPathInsideRoot`（`src/roots.ts:20`）通过计算 `relative(root, path)` 判断：
- 空字符串 → 路径就是根本身
- 不以 `..` 开头、不等于 `..`、不包含 `..{sep}` → 在根内
- 其他 → 在根外

### 9.2 读取路径的特殊处理

`resolveReadPath`（`src/workspaces.ts:130`）支持**技能目录外读**：

1. 先尝试在工作区根内解析路径
2. 失败时尝试匹配已广告的技能路径（`resolveSkillReadPath`）
3. 匹配成功则返回技能文件路径 + 扩展的 `readRoots`

这允许模型读取工作区外的 SKILL.md 文件，但仅限于：
- 已广告的 SKILL.md 文件本身
- 已激活技能目录下的文件（技能 SKILL.md 被读取后才激活）

---

## 10. Git Worktree 隔离机制

### 10.1 设计目标

托管式 worktree 为**并行编码会话**提供工作流隔离（非安全边界），让多个 AI 会话可同时在同一仓库的不同 worktree 工作，互不干扰。

### 10.2 createManagedWorktree 流程（git-worktrees.ts:36）

```
1. assertAllowedPath(sourcePath)          ← 校验源路径在白名单
2. stat(sourcePath)                       ← 确认是目录
3. resolveGitRoot(sourcePath)             ← git rev-parse --show-toplevel
4. resolveBaseCommit(sourceRoot, baseRef) ← git rev-parse --verify {ref}^{commit}
5. git status --porcelain                 ← 检测源是否 dirty
6. managedWorktreePath()                  ← 生成 {repoName}-{randomHex} 路径
7. mkdir(worktreeRoot)                    ← 确保根目录存在
8. assertAllowedPath(worktreePath, [worktreeRoot])  ← 校验 worktree 路径
9. git worktree add --detach {path} {sha} ← 创建 detached worktree
   失败 → rm worktreePath → 抛 GIT_WORKTREE_CREATE_FAILED
```

### 10.3 错误分类

`GitWorktreeError`（`src/git-worktrees.ts:11`）定义了结构化错误码：

| 错误码 | 触发条件 |
|--------|----------|
| `GIT_NOT_AVAILABLE` | 系统未安装 git |
| `GIT_REPOSITORY_NOT_FOUND` | 路径不在 git 仓库内 |
| `GIT_REPOSITORY_HAS_NO_COMMITS` | 仓库无任何提交（HEAD 无法解析） |
| `GIT_INVALID_BASE_REF` | 指定的 baseRef 无法解析为 commit |
| `GIT_WORKTREE_CREATE_FAILED` | `git worktree add` 失败 |

### 10.4 符号链接处理

`assertGitRootAllowed`（`src/git-worktrees.ts:112`）处理符号链接场景：先尝试逻辑路径校验，失败后用 `realpath` 解析规范路径，再映射回逻辑路径。测试中专门验证了符号链接根目录的 worktree 创建（`src/workspaces.test.ts:108`）。

### 10.5 Worktree 路径生成

`managedWorktreePath`（`src/git-worktrees.ts:149`）：
- 仓库名经 `sanitizePathSegment` 清理（非字母数字字符替换为 `-`，截断 80 字符）
- 附加 4 字节随机 hex 后缀：`{repoName}-{a1b2c3d4}`

---

## 11. Skills 技能系统

### 11.1 技能发现（skills.ts）

`loadWorkspaceSkills`（`src/skills.ts:22`）委托 Pi SDK 的 `loadSkills` 从三个来源发现技能：

1. `config.agentDir`（默认 `~/.codex`）下的 `skills/` 目录
2. 项目内 `.pi/skills/` 目录
3. `config.skillPaths`（`DEVSPACE_SKILL_PATHS`）显式指定目录

`DEVSPACE_SKILLS=0` 可完全禁用技能系统。

### 11.2 技能读取安全模型

技能文件可能位于工作区外，DevSpace 通过**两阶段激活**控制访问：

```
open_workspace 返回 skills 列表（含 SKILL.md 路径）
    │
    ▼
模型读取 SKILL.md  →  resolveSkillReadPath 匹配 isSkillFile=true
    │                   ↓
    ▼               markSkillActivated → 加入 activatedSkillDirs
模型读取技能目录内其他文件
    │               → resolveSkillReadPath 匹配 isSkillFile=false
    ▼                   （仅当 baseDir 在 activatedSkillDirs 中）
允许读取
```

`resolveSkillReadPath`（`src/skills.ts:33`）优先级：
1. 精确匹配技能 `filePath`（SKILL.md）→ `isSkillFile: true`
2. 匹配已激活技能 `baseDir` 下的路径 → `isSkillFile: false`
3. 都不匹配 → `undefined`（拒绝读取，回退到工作区根内校验）

### 11.3 技能过滤

`disableModelInvocation` 标记的技能不向模型暴露（`src/server.ts:562`）：
```typescript
const visibleSkills = workspace.skills
  .filter((skill) => !skill.disableModelInvocation)
  .map(...)
```

### 11.4 路径格式化

`formatPathForPrompt`（`src/skills.ts:65`）将绝对路径转为 `~/...` 形式，使模型看到的路径更简洁且跨平台统一（`sep` → `/`）。

---

## 12. Review Checkpoints 变更审查

### 12.1 设计

`review-checkpoints.ts` 实现基于 **Git 工作树快照**的变更审查机制，仅在 `DEVSPACE_WIDGETS=changes` 模式下启用。

### 12.2 快照原理

`createWorkingTreeSnapshot`（`src/review-checkpoints.ts:122`）不创建实际 commit，而是用**临时索引文件**创建树对象：

```
1. mkdtemp → 临时目录
2. GIT_INDEX_FILE=临时路径
3. git read-tree HEAD         ← 加载 HEAD 树到临时索引
4. git add -A                 ← 将工作区所有变更加入临时索引
5. git write-tree             ← 写入树对象（不修改工作区）
6. git commit-tree -p HEAD    ← 创建无引用的 commit 对象
7. rm 临时目录
```

这创建了工作区当前状态的**快照 commit**，不污染仓库引用、不修改工作区。

### 12.3 双引用基准

每个工作区维护两个 Git 引用（`refs/devspace/review/{workspaceId}/`）：

| 引用 | 用途 |
|------|------|
| `open` | 工作区打开时的初始快照 |
| `baseline` | 上次 show_changes 审查后的基准快照 |

### 12.4 reviewChanges 流程（review-checkpoints.ts:74）

```
since = "last_shown"    → 对比 baselineRef
since = "workspace_open" → 对比 openRef

1. 解析基准 commit
2. createWorkingTreeSnapshot → 当前快照
3. git diff --binary baseline current → 完整 patch
4. git diff --numstat -z baseline current → 文件统计
5. parseNumstat → ReviewFile[]（含类型：change/new/deleted/rename-pure/rename-changed）
6. summarizeFiles → 汇总 files/additions/removals
7. markReviewed=true → update-ref baseline 为当前快照
```

### 12.5 文件类型判定（fileType）

| 条件 | 类型 |
|------|------|
| 有 previousPath 且无增删 | `rename-pure` |
| 有 previousPath 且有增删 | `rename-changed` |
| 无 previousPath，仅增 | `new` |
| 无 previousPath，仅删 | `deleted` |
| 其他 | `change` |

---

## 13. UI / Widget 系统

### 13.1 ChatGPT Apps 集成

DevSpace 通过 `@modelcontextprotocol/ext-apps` 向 ChatGPT Apps 兼容客户端提供**交互式工具卡片**。

#### Widget 模式（DEVSPACE_WIDGETS）

| 模式 | 行为 |
|------|------|
| `full`（默认） | 所有工具附加 Widget UI（read/write/edit/grep/glob/ls/bash/open_workspace） |
| `changes` | 仅 open_workspace 与 show_changes 附加 Widget，暴露聚合 show_changes 工具 |
| `off` | 完全禁用 Widget UI |

`shouldAttachWidget`（`src/server.ts:112`）控制每个工具是否附加 `_meta.ui.resourceUri`。

### 13.2 Widget 资源注册

```typescript
registerAppResource(server, "DevSpace Diff Card", "ui://devspace/workspace-app.html", ...)
```

资源 URI `ui://devspace/workspace-app.html` 返回由 `workspaceAppHtml()`（`src/server.ts:394`）生成的 HTML，内嵌 Vite 构建产物的 script/link 标签。

### 13.3 静态资源托管

- 构建产物在 `dist/ui/`，通过 `/mcp-app-assets/{*asset}` 路由托管（`src/server.ts:1331`）
- 设置 CORS 头（`Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin`）
- `immutable: true` + `maxAge: 1y` 长缓存
- 启动时 `assertWorkspaceAppAssets()` 校验产物存在

### 13.4 Workspace App（workspace-app.tsx）

React 应用作为 iframe 内容运行，通过 `@modelcontextprotocol/ext-apps` 的 `App` 类与宿主通信：

```
boot()
  ├─ new App({ name, version })
  ├─ app.ontoolresult = (result) => { ... }   ← 监听工具结果
  ├─ app.onhostcontextchanged = (ctx) => { ... } ← 监听主题/样式变化
  ├─ app.onteardown = async () => { ... }      ← 清理
  └─ app.connect()                             ← 连接宿主
```

#### 卡片渲染流程

```
ontoolresult(result)
  ├─ 提取 structuredContent + _meta.card → 合并为 ToolResultCard
  ├─ 校验 isToolResultCard
  └─ render()
       ├─ isReviewTool → renderReviewCard（文件列表 + 可展开 diff）
       ├─ shouldUseHeavyPayload（read/edit/write）
       │    ├─ 懒加载 heavy-payload.tsx
       │    └─ mountHeavyPayload（FileStream 代码高亮 / PatchDiff）
       ├─ isReviewTool（show_changes）
       │    ├─ 懒加载 review-payload.tsx
       │    └─ mountReviewPayload（@pierre/diffs FileDiff 组件）
       └─ 其他 → renderPrePayload（纯 <pre> 文本）
```

#### 重型渲染懒加载

`heavy-payload.tsx` 和 `review-payload.tsx` 通过**动态 `import()`** 懒加载，避免主包过大。它们使用 `@pierre/diffs` 提供：
- `FileStream` — 代码文件流式渲染（语法高亮）
- `PatchDiff` — 补丁 diff 渲染
- `FileDiff` — 逐文件 diff 渲染（可折叠）

#### Host 上下文适配

`applyHostContext()`（`src/workspace-app.tsx:125`）适配宿主环境：
- `theme` → `applyDocumentTheme`（亮/暗主题）
- `styles.variables` → `applyHostStyleVariables`
- `styles.css.fonts` → `applyHostFonts`
- `safeAreaInsets` → body padding

### 13.5 Vite 构建

`vite.config.ts` 配置：
- `root: src/ui`（HTML 入口在 UI 目录）
- `input: workspace-app.html`
- 产物输出到 `dist/ui/`，带 manifest
- 文件名带 hash：`assets/[name]-[hash].js`
- `base: "./"`（相对路径，适配 iframe 加载）

服务端通过 `readWorkspaceAppManifest()` 读取 `dist/ui/.vite/manifest.json` 获取入口文件名和 CSS。

---

## 14. 配置系统

### 14.1 三层配置源（优先级从高到低）

```
环境变量（process.env）
    │ 覆盖
    ▼
持久化配置文件（~/.devspace/config.json + auth.json）
    │ 覆盖
    ▼
内置默认值
```

### 14.2 loadConfig（config.ts:207）

```typescript
function loadConfig(env): ServerConfig {
  const files = loadDevspaceFiles(env);  // 读 config.json + auth.json
  return {
    host: env.HOST ?? files.config.host ?? "127.0.0.1",
    port: parsePort(env.PORT ?? files.config.port),
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedHosts),
    publicBaseUrl: parsePublicBaseUrl(...),
    minimalTools: parseMinimalTools(env),
    toolNaming: parseToolNaming(env.DEVSPACE_TOOL_NAMING),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir: ...,
    worktreeRoot: ...,
    skillsEnabled: ...,
    skillPaths: ...,
    agentDir: ...,
    logging: parseLoggingConfig(env),
  };
}
```

### 14.3 完整环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `127.0.0.1` | 本地绑定地址 |
| `PORT` | `7676` | 本地端口 |
| `DEVSPACE_CONFIG_DIR` | `~/.devspace` | 配置目录 |
| `DEVSPACE_ALLOWED_ROOTS` | 当前目录 | 逗号分隔的允许根目录 |
| `DEVSPACE_PUBLIC_BASE_URL` | `http://127.0.0.1:7676` | 公网 origin（不含 /mcp） |
| `DEVSPACE_ALLOWED_HOSTS` | 自动推导 | Host 头白名单，`*` 禁用 |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | — | Owner 密码（≥16 字符） |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | Access token 有效期 |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh token 有效期 |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` | 支持的 scope |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` | OAuth redirect 白名单 |
| `DEVSPACE_TOOL_MODE` | `minimal` | `minimal` / `full` |
| `DEVSPACE_TOOL_NAMING` | `short` | `short` / `legacy` |
| `DEVSPACE_WIDGETS` | `full` | `off` / `changes` / `full` |
| `DEVSPACE_SKILLS` | `1` | `0` 禁用技能 |
| `DEVSPACE_AGENT_DIR` | `~/.codex` | 技能/指令目录 |
| `DEVSPACE_SKILL_PATHS` | — | 额外技能目录 |
| `DEVSPACE_STATE_DIR` | `~/.local/share/devspace` | SQLite 状态目录 |
| `DEVSPACE_WORKTREE_ROOT` | `~/.devspace/worktrees` | 托管 worktree 根目录 |
| `DEVSPACE_LOG_LEVEL` | `info` | `silent/error/warn/info/debug` |
| `DEVSPACE_LOG_FORMAT` | `json` | `json` / `pretty` |
| `DEVSPACE_LOG_REQUESTS` | `1` | 请求日志 |
| `DEVSPACE_LOG_ASSETS` | `0` | 静态资源日志 |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` | 工具调用日志 |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` | Shell 命令预览（可能含敏感信息） |
| `DEVSPACE_TRUST_PROXY` | `0` | 信任代理头（X-Forwarded-For 等） |

### 14.4 AllowedHosts 自动推导

`derivedAllowedHosts`（`src/config.ts:214`）自动包含：
- `localhost` / `127.0.0.1` / `::1`
- 本地绑定 host
- 公网 URL 的 hostname
- 配置文件中的 `allowedHosts`

`DEVSPACE_ALLOWED_HOSTS=*` 禁用 Host 校验（仅用于本地调试）。

---

## 15. 持久化层

### 15.1 SQLite + Drizzle ORM

| 组件 | 文件 | 职责 |
|------|------|------|
| `db/client.ts` | 连接管理 | 打开 SQLite、WAL 模式、外键约束、Drizzle 实例 |
| `db/schema.ts` | 表定义 | Drizzle schema 声明 |
| `workspace-store.ts` | 存储逻辑 | 会话 CRUD + 迁移 |

### 15.2 数据库配置

```typescript
sqlite.pragma("journal_mode = WAL");       ← 写前日志，并发读不阻塞
sqlite.pragma("foreign_keys = ON");        ← 启用外键级联删除
```

数据库文件：`{stateDir}/devspace.sqlite`

### 15.3 表结构

#### workspace_sessions

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | TEXT PK | 工作区 ID（`ws_{uuid}`） |
| `root` | TEXT NOT NULL | 工作区根路径 |
| `status` | TEXT | 默认 `active` |
| `mode` | TEXT | `checkout` / `worktree` |
| `source_root` | TEXT | worktree 源仓库 |
| `base_ref` | TEXT | worktree 基准 ref |
| `base_sha` | TEXT | worktree 基准 sha |
| `managed` | TEXT | `true` / `false`（字符串存储） |
| `created_at` | TEXT NOT NULL | ISO 时间戳 |
| `last_used_at` | TEXT NOT NULL | ISO 时间戳 |

索引：`(root, last_used_at DESC)`、`(status, last_used_at DESC)`

#### loaded_agent_files

| 列 | 类型 | 说明 |
|----|------|------|
| `workspace_session_id` | TEXT FK | 关联 workspace_sessions.id（级联删除） |
| `path` | TEXT | 指令文件路径 |
| `content_hash` | TEXT | 内容哈希 |
| `content` | TEXT | 文件内容 |
| `loaded_at` | TEXT | 加载时间 |
| `last_seen_at` | TEXT | 最后见到时间 |

主键：`(workspace_session_id, path)`，索引：`path`

### 15.4 迁移策略

`migrate()`（`src/workspace-store.ts:110`）采用**幂等 DDL + 增量列**策略：
- `create table if not exists` / `create index if not exists`
- `addColumnIfMissing` 通过 `pragma table_info` 检查列是否存在，缺失则 `alter table add column`

---

## 16. 日志系统

### 16.1 结构化日志（logger.ts）

`logEvent`（`src/logger.ts:30`）输出结构化日志：

```json
{"ts":"2026-06-19T...","level":"info","event":"http_request","requestId":"...","method":"POST","path":"/mcp","status":200,"durationMs":42,"ip":"..."}
```

`DEVSPACE_LOG_FORMAT=pretty` 时输出 key=value 格式。

### 16.2 日志事件类型

| 事件 | 级别 | 触发点 |
|------|------|--------|
| `http_request` | info | 每个请求结束（`server.ts:1302`） |
| `mcp_request` | debug | /mcp 请求处理（`server.ts:1370`） |
| `mcp_session_created` | info | 新 MCP 会话（`server.ts:1392`） |
| `mcp_session_closed` | info | 会话关闭（`server.ts:1404`） |
| `mcp_request_error` | error | 处理异常（`server.ts:1419`） |
| `auth_denied` | warn | 认证拒绝（`server.ts:1359`） |
| `tool_call` | info/warn | 每次工具调用（`server.ts:268`） |

### 16.3 工具调用日志

`logToolCall`（`src/server.ts:268`）记录：工具名、workspaceId、路径/命令、成功/失败、耗时、错误预览。

Shell 命令预览受 `DEVSPACE_LOG_SHELL_COMMANDS` 控制（默认关闭，防泄露敏感信息），且通过 `commandPreview`（`src/logger.ts:75`）截断为 120 字符。

### 16.4 代理 IP 解析

`requestIp`（`src/logger.ts:55`）仅在 `DEVSPACE_TRUST_PROXY=1` 时读取 `cf-connecting-ip` / `x-forwarded-for`，否则用 `req.ip` / `socket.remoteAddress`。

### 16.5 会话 ID 前缀

`sessionIdPrefix`（`src/logger.ts:71`）仅记录 UUID 前 8 字符，避免日志中暴露完整会话 ID。

---

## 17. CLI 命令行接口

### 17.1 命令清单（cli.ts）

| 命令 | 别名 | 功能 |
|------|------|------|
| `devspace serve` | `start` / 无参数 | 启动 MCP 服务器（未配置时自动触发 init） |
| `devspace init` | — | 交互式配置向导 |
| `devspace doctor` | — | 诊断配置、运行时、原生依赖 |
| `devspace config get` | — | 打印持久化配置 |
| `devspace config set publicBaseUrl <url>` | — | 更新公网 URL |
| `devspace help` | `--help` / `-h` | 打印帮助 |

### 17.2 init 流程（cli.ts:76）

```
1. 检查是否已配置（--force 跳过）
2. prompts.intro("DevSpace setup")
3. 询问项目根目录（逗号分隔，默认当前目录）
4. 询问端口（默认 7676）
5. 显示公网 URL 说明（note）
6. 询问公网 base URL（校验不含 /mcp）
7. writeDevspaceConfig + writeDevspaceAuth
8. 显示配置路径 + Owner 密码（note）
9. prompts.outro
```

配置文件以 `0o600` 权限写入（`src/user-config.ts:101`），Owner 密码通过 `randomBytes(32).toString("base64url")` 生成。

### 17.3 serve 启动校验

`serve()`（`src/cli.ts:165`）启动前执行：
1. `checkSqliteNative()` — 尝试创建内存 SQLite，失败则报错并建议 `npm rebuild better-sqlite3`
2. 动态 `import("./server.js")` — 延迟加载服务端模块
3. `loadConfig()` + `createServer()`
4. 注册 SIGINT/SIGTERM 优雅关闭

### 17.4 doctor 诊断

`runDoctor()`（`src/cli.ts:201`）报告：
- 配置目录与文件存在性
- Node 版本与 ABI（`satisfies` 校验 `>=20.12 <27`）
- 平台与架构
- Git 可用性（`execFileSync git --version`）
- Bash shell 配置（`getShellConfig` from Pi SDK）
- SQLite 原生依赖状态
- 解析后的配置（URL、根目录、允许主机）

### 17.5 Node 版本守护

`assertSupportedNode()`（`src/cli.ts:327`）在 `main()` 入口立即校验，不满足 `>=20.12 <27` 则抛错并建议安装 Node 22 LTS。

---

## 18. 构建与部署

### 18.1 双产物构建

```json
{
  "build": "npm run clean && npm run build:app && tsc -p tsconfig.build.json",
  "build:app": "vite build"
}
```

| 步骤 | 工具 | 产物 | 配置 |
|------|------|------|------|
| `build:app` | Vite 8 | `dist/ui/`（HTML+JS+CSS+manifest） | `vite.config.ts` |
| `tsc` | TypeScript 6 | `dist/*.js`（服务端 + 类型声明） | `tsconfig.build.json` |

`tsconfig.build.json` 排除 `src/ui/**` 和 `src/**/*.test.ts`，仅编译服务端代码。

### 18.2 开发热重载

`scripts/dev-server.mjs` 实现**文件监听 + 自动重启**：
- 递归监听 `src/` 目录
- 文件变更 → 750ms 防抖重启
- 进程崩溃 → 1500ms 后自动重启
- SIGTERM 优雅停止，3 秒后 SIGKILL 强制停止

通过 `npx tsx src/cli.ts serve` 运行（tsx 提供即时 TS 执行）。

### 18.3 发布配置

```json
{
  "bin": { "devspace": "dist/cli.js" },
  "files": ["dist", "docs", "scripts", "README.md"],
  "publishConfig": { "access": "public" }
}
```

发布包名 `@waishnav/devspace`，包含 `dist/`（编译产物）、`docs/`、`scripts/`、`README.md`。

### 18.4 依赖覆盖

```json
{
  "overrides": {
    "protobufjs": "7.6.4",
    "ws": "8.21.0"
  }
}
```

固定传递依赖版本以避免已知问题。

---

## 19. 测试策略

### 19.1 内联测试（无框架）

DevSpace 使用**原生 Node.js `assert` + 顶层 await**的测试风格，无外部测试框架。测试文件直接以 `tsx` 执行：

```json
{
  "test": "tsx src/config.test.ts && tsx src/roots.test.ts && tsx src/skills.test.ts && tsx src/workspaces.test.ts && tsx src/review-checkpoints.test.ts"
}
```

### 19.2 测试覆盖

| 测试文件 | 覆盖范围 |
|----------|----------|
| `config.test.ts` | 配置解析、默认值、环境变量覆盖、校验异常、配置文件读取 |
| `roots.test.ts` | `~` 展开、路径白名单校验、相对路径解析 |
| `skills.test.ts` | 技能发现、重复去重、disableModelInvocation、技能读取两阶段激活 |
| `workspaces.test.ts` | checkout/worktree 打开、AGENTS.md 加载、嵌套指令发现、会话持久化与恢复、符号链接 |
| `review-checkpoints.test.ts` | 快照初始化、无变更、变更检测、markReviewed 推进基准 |

### 19.3 集成测试特点

`workspaces.test.ts` 是**完整的集成测试**：
- 创建临时目录结构（含 AGENTS.md、嵌套目录、git 仓库）
- 用真实 `git` 命令初始化仓库并提交
- 验证 worktree 创建、dirty 源检测、路径解析
- 验证 SQLite 会话持久化与跨实例恢复
- 在非 Windows 平台验证符号链接根目录

### 19.4 CI 流水线（.github/workflows/ci.yml）

```
矩阵: ubuntu-latest / macos-latest / windows-latest
步骤:
  1. checkout
  2. setup-node 22 (npm cache)
  3. npm ci
  4. npm run typecheck
  5. npm test
  6. npm run build
  7. node dist/cli.js doctor    ← 验证构建产物可运行
```

---

## 20. 关键设计决策

### 20.1 为什么用 Pi SDK 而非自研工具

DevSpace 不重新实现文件读写、grep、glob 等原语，而是复用 `@earendil-works/pi-coding-agent` 的成熟工具实现。`pi-tools.ts` 仅做**路径安全前置校验 + 结果格式适配**，保持适配层薄且可替换。

### 20.2 为什么用单用户 OAuth 而非 API Key

MCP 协议规范要求 OAuth，DevSpace 顺应协议但简化为单用户模型：Owner 密码即唯一凭据，无需外部身份提供者。`SingleUserOAuthProvider` 完整实现授权码流程（含 PKCE、refresh token），满足 MCP 客户端的 OAuth 发现与授权需求。

### 20.3 为什么 Workspace 是会话级而非持久连接

MCP Streamable HTTP 是无状态 HTTP，每个请求携带 `mcp-session-id`。DevSpace 将工作区绑定到会话，内存 Map 提供快速访问，SQLite 提供重启恢复。这平衡了性能与持久性。

### 20.4 为什么默认 minimal 工具模式

减少工具数量降低模型选择负担。专用 grep/glob/ls 工具的功能可通过 `bash` + 命令行工具（`rg`/`find`/`ls`）完成。`full` 模式保留给需要结构化搜索结果的场景。

### 20.5 为什么 Review 用临时索引而非 stash/commit

`createWorkingTreeSnapshot` 用 `GIT_INDEX_FILE` 环境变量指向临时索引文件，创建无引用的 commit-tree 对象。这**不修改工作区、不修改仓库引用、不干扰用户工作流**，是最小侵入的快照方式。

### 20.6 为什么 UI 懒加载重型组件

`heavy-payload.tsx`（含 `@pierre/diffs` 的 FileStream/PatchDiff）和 `review-payload.tsx` 通过动态 `import()` 懒加载，使主 Widget 包仅含卡片框架逻辑，diff 渲染代码仅在展开时按需加载。

### 20.7 为什么配置有三层源

环境变量支持 CI/容器化部署（无需交互），配置文件支持本地开发便利，内置默认确保开箱即用。环境变量优先级最高，便于临时覆盖（如隧道 URL 变更时 `DEVSPACE_PUBLIC_BASE_URL=... devspace serve`）。

### 20.8 安全边界总结

| 威胁 | 防御 | 层级 |
|------|------|------|
| 未授权访问 | OAuth Owner 密码 + Bearer token | 网络层 |
| 路径穿越 | `assertAllowedPath` + `isPathInsideRoot` | 文件系统层 |
| 跨资源 token | `checkResourceAllowed` | OAuth 层 |
| Host 头欺骗 | Host 白名单（自动推导 + 可配） | HTTP 层 |
| XSS（审批页） | `htmlEscape` | HTML 层 |
| 时序攻击 | `timingSafeEqual` | 密码校验层 |
| Token 泄露 | SHA-256 hash 存储 | 存储层 |
| 敏感命令泄露 | `DEVSPACE_LOG_SHELL_COMMANDS` 默认关闭 | 日志层 |
| 技能目录越权 | 两阶段激活（先读 SKILL.md 才解锁目录） | 技能层 |
| Worktree 路径注入 | `sanitizePathSegment` + 随机后缀 | Git 层 |

---

> **文档版本**: 基于 DevSpace v1.0.1 源码分析生成
> **覆盖源文件**: 21 个源文件 + 7 个 UI 文件 + 5 个测试文件 + 5 个文档 + CI 配置 + 构建配置
