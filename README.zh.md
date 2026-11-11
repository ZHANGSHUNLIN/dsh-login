# dsh-login

[English](./README.md) | 简体中文

本 fork 将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 接入 Great Admin SSO。Great Admin 是唯一身份源；本地 DSH 用户/密码和用户管理已停用。登录后按 Admin `userId` 隔离 DSH 会话，Admin MCP 插件通过 Host 内部 `dshLoginAuth` 服务复用同一身份和 token。

| 登录页 |
|:---:|
| 使用 Great Admin 账号继续登录 |

## 这个插件解决什么问题

DSH 的 Web GUI 本身**没有登录**——它按“单用户、localhost”设计。只要把服务绑到 `0.0.0.0`（手机访问、局域网共享、团队共用），**网络上任何人都能直接打开你的 GUI**：看到全部对话、用你配置的模型密钥消耗额度，甚至修改宿主配置。

`dsh-login` 把它变成一个多用户部署：

- 🔐 **登录墙** —— 页面、静态资源、SPA 路由、API、WebSocket 全部要求有效会话，未登录一律跳转 `/login`
- 👥 **Admin 身份** —— 使用 Great Admin 账号登录；本 fork 不创建或管理 DSH 本地账号
- 🙈 **会话隔离** —— 普通用户只能看到、操作**自己**的对话（含其派生的子代理/分叉）；桥墙对普通用户拒绝白名单外的方法，并把 `session.list`/`session.search`/`workspace.list` 响应收窄为自己拥有的会话；dispatch-seam 守卫对每次分发做归属校验（含 `workspace.follow` 流的逐用户帧过滤）；其他人的会话、消息、工作区一律不可见；凭据、宿主设置等管理域整体禁用
- 🎭 **Admin 管理 DSH 权限** —— 登录后读取 Admin 分配的 `dsh:*` 权限码，按权限过滤 UI bundle 并控制对应 API 方法（`uiRoleGate`，默认开启）
- 🛡 **细粒度功能权限** —— DSH 设置和模型配置、插件管理、Agent 预设分别授权；其他凭据、进程账号和主机控制方法仍默认拒绝
- 🚪 **共享登出** —— Admin MCP 设置卡片和 `/api/auth/logout` 使用同一 DSH session
- 🌐 **远程访问友好** —— `/api` 主机信任围栏使用实时集合（LAN 字面量 + `trustedHosts` + 自动学习主机）

---
## 当前状态

**改造基线：`@islibaodong/dsh-login@0.3.12`，DSH `0.2.2-rc.1`。** 本 fork 使用 Admin SSO 作为唯一身份源；DSH 功能权限来自 Admin 角色，不在 DSH 维护第二套用户和角色。

0.3.12 是**安全修复版本**，修复 [issue #11](https://github.com/islibaodong/dsh-login/issues/11)：流式方法（`workspace.follow` 工作区树、以及带 id 的 `session.page` 等调用）走 `/api/remote.mux` WebSocket，只拦 POST 的桥墙完全看不见——普通用户可枚举并切入他人的工作区。0.3.12 起插件内置 **dispatch-seam guard**：连接准入要求浏览器路径携带有效 dsh-login 会话（含 WebSocket upgrade），分发 seam 对每次浏览器调用逐用户把关——非 user 方法拒绝、id 参数过归属校验、`workspace.follow` 逐帧过滤。同时带上已合并的 PR #12 修复（DSH 0.2.2 登录后主页 400）与 CI 重写（Node 24 矩阵、dist 新鲜度闸门）。

### 兼容历史

| dsh-login | DSH | 说明 |
|-----------|-----|------|
| 0.3.12 | 0.2.2-rc.1 | issue #11 流式方法隔离修复 + PR #12 网关修复 |
| 0.3.11 | 0.2.2-rc.1 | 依赖重定向到 rc.1 元组线（vendor 稳定版） |
| 0.3.10 | 0.2.2-alpha.3 | 线面重钉 199 → 204（schedule CRUD 拆分、forge 评审面） |
| 0.3.9 | 0.2.1-rc.5 | issue #10：launch token 不再暴露给远程客户端 |
| 0.3.8 | 0.2.2-alpha.2 | 线面 146 → 199（forge 面板、会话观察、CUA、liveshareShares） |
| 0.3.7 | 0.2.1-rc.3 | 上游纯客户端 UI 版本，适配面零影响 |
| 0.3.6 | 0.2.1-rc.2 | issue #4：按真实线面重推放行清单 |

更早版本见 [Releases 页面](https://github.com/islibaodong/dsh-login/releases)。

### 上游多用户观察

上游 DSH 仍**没有原生用户账号**——没有用户存储、没有登录、没有身份 UI。0.2.1-alpha.3 引入的是面向非 owner Peer 的只授权 RBAC 引擎（`packages/api/remote-access`）与多主体连接机制；它不拦 owner 主体，而 dsh-login 用户全部以 owner 主体抵达。dsh-login 仍是账号/认证层。
- **所有登录用户先按会话所有权隔离。** 在 option A 下 `/api` 由原生 `connection`/`api-gateway` 持有并按 agent 键控；按用户隔离由三道 seam 组成——前两道随插件内置、默认生效：
  1. **桥墙方法门 + 响应收窄（`apiBridgeAuth`）**——普通用户的 POST 分发只放行 `USER_ALLOWED` 白名单方法，白名单外直接拒绝（`quietDenials` 默认开时回 wire 正确的 forbidden envelope，否则 403）；`session.list`/`session.search`/`workspace.list` 响应收窄为仅含自己拥有的会话/工作区；
  2. **dispatch-seam 守卫（0.3.12 起内置，自动生效——修复 [issue #11](https://github.com/islibaodong/dsh-login/issues/11)）**——连接准入要求浏览器路径携带有效 dsh-login 会话（含 `/api/remote.mux` WebSocket upgrade），并把 dsh-login 身份打标到每个浏览器 peer；分发 seam（`dispatchRpc`/`openWireStream`）随后对每次浏览器调用逐用户把关：非 user 方法拒绝、全部 id 参数（`sessionId`/`workspaceId`/`agentId`/…）过归属校验、`workspace.follow` 流逐帧过滤（镜像上游 per-principal 语义：baseline 收窄、delivered 集合记账、可见性丢失 replace 重同步、未知帧 fail-closed）。未打标 peer（launch-token CLI/SDK、宿主内部调用）保持上游原语义。
  3. **REMOTE 层守卫（`wrapRemoteGateway`，导出、可选）**——面向部署方的组合原语，包装网关公开 API（见 [`docs/compose-guard.md`](docs/compose-guard.md)）；0.3.12 起内置守卫已覆盖浏览器流量，组合它属于额外的纵深防御。
  其余一律禁止：
  - 物理层允许清单：面向用户的线方法面（`USER_ALLOWED`，DSH 0.2.2-rc.1 实际暴露的 204 个方法中的 124 个）——`session.*`（prompt/page/modelCatalog/selectModel/fork/attachment、events/observe/state 族等）、`workspace.*`、`goals.*`、`subagents.*`、`terminal.*`、`job.*`、只读 `workspaceFiles.*`/`officeToPdf.*` 文档预览、`llm.*` 模型选择读取、`skills.list`、`commands.*`、`directoryPicker.*`、`schedule.*`、`speech.*`、`userQuestions.*`、`messageFeedback.*`、`sessionFeedback.record`、`fileUploads.upload`、`fileReferences.list`、`permissionPresets.catalog`、`productAnalytics.*`、`cotTranslation.*`、`sessionReferenceResolver.candidates`、`remoteAccess.follow` 授权流，以及 0.2.2 新增面（按会话的 `forgePanel.*`、`toolResults.watch`、`actionCards.act`、`pluginRecommendations.describe`）；其他任何线上方法都会被拒绝。清单对 wire 面是穷尽的：上游改名或新增方法而没分类时，`tests/wire-surface.spec.ts` 会失败（见 [`docs/adapt-dsh-0.2.1-rc.2-issue-4.md`](docs/adapt-dsh-0.2.1-rc.2-issue-4.md)）
  - 管理员专属域（`ADMIN_ONLY_METHODS`，79 个）：`credentials.*`、`settings.*`、`agentPresets.*`、原生插件管理器（`pluginManager.*`、`pluginMarket.*`、`pluginRegistryProbe.*`、`pluginInventory.*`）、`dynamicCordisRunner.*`、`claudeCodeMods.*`、整个 `account.*` 命名空间（唯一的进程级上游 DeepSeek Platform 授权）、CUA 同意（`cuaAccess.*`）、`schedule.deleteInactive` 与 `liveshareShares.*` 分享管理面
  - 宿主内部：`workspace.initializeDefault`（首次使用的内部管线，对用户拒绝且从不对外通告）
  - 未知方法（不在本版本 wire 面上）会在宿主日志里按方法名报一次并带上目标版本，于是上游改名留下的是诊断信息而不是用户侧的静默拒绝——用 `node scripts/dump-wire-surface.mjs` 从 checkout 重新生成 `src/api-filter.ts`
  - 工作区级变更按 `workspaceId` 所有权守卫：Admin SSO 用户只能修改包含自己会话的工作区，`create` 只能落在自己的沙箱目录（`workspaceRoot/<userId>`）内
  - 物理层 `session.export` 通道（目标在查询字符串中、不走信封）在通道层按所有权校验
  - 流式：`workspace.follow` 帧在 dispatch seam 逐用户过滤（见上）——用户看到的工作区树永不包含他人的工作区或 sessionId
- **按 Admin 权限过滤 UI（`uiRoleGate`，默认开）：** 页面返回前根据 `dsh:*` 权限过滤 `window.__DSH_BOOT__`。插件按 bundle 粒度显示；共享 bundle 中的单个设置项不能独立隐藏。UI 只优化展示，API 方法门、dispatch seam 和 Remote guard 使用相同权限映射执行服务端拒绝。
- **默认用户工作空间（`defaultWorkspace`，默认开启）：** 每个 Admin 用户首次经 `/api` 访问时，自动供给按 `userId` 隔离的默认工作区（默认 `<DSH_HOME>/workspaces/<userId>`），并将新会话归属写入 ownership 索引。通过 DSH 插件配置调整；本 fork 不提供上游的用户管理设置面板。供给幂等且 best-effort。
- **远程访问兼容（`remoteWebUiCompat`，默认开启）：** 通过 DSH 插件配置中的 `remoteWebUiCompat` 和 `remoteWebUiPublicBaseUrl` 适配 `@linxin666/dsh-remote-web-ui`。本 fork 不提供上游的用户管理设置面板。
- **`/api` 桥鉴权墙（`apiBridgeAuth`，默认开启；DSH ≥ 0.1.6-alpha.2）：** 在上游的 `connection/request` 钩子上，dsh-login 对**未携带有效 `dsh_session` 的桥接 `/api` 请求直接回 401**——注销/过期/吊销会话后，即使浏览器仍持有 connection 行的进程级浏览器 cookie，也无法继续调用 `/api`。对已认证的普通用户，桥墙继续做方法级强制（见上文两层模型）并在请求/响应两侧保温所有权索引：记录经 `session.create`/`session.fork`/`workspace.create` 产生的新资源（含管理员创建——record-only，不限制管理员请求），过滤普通用户的 list 响应，并在需要时触发默认工作区供给。插件自有精确路由（`/api/auth/*`、remote-web-ui 的 `/api/pair/*` 配对）不经过桥，登录前照常可用；Remote 流 mux 的 WebSocket 升级仍由上游的 Host/Origin + 浏览器鉴权围栏把关（上游没有提供逐请求钩子）。仅当有无法携带 `dsh_session` cookie 的客户端需要直连桥时才关闭本项——例如 remote-web-ui 的 `/remote` 配对设备通道会在服务端重新发起请求且不带该 cookie（配对凭证在设计上就是绕开 dsh-login 用户模型的完全控制凭据）。DSH < 0.1.6-alpha.2 时该钩子不存在，本项是无害的空操作。
- **DSH 权限映射：** Admin 角色分别分配 `dsh:settings:manage`、`dsh:plugin:manage`、`dsh:agent-preset:manage`。设置权限管理整个 DSH 设置页（包括模型配置），插件权限管理插件安装、启停和更新，Agent 预设权限控制预设入口及 API。未映射的 host 管理方法仍拒绝。
- **登出：** Admin MCP 设置卡片调用 `POST /api/auth/logout`，撤销共享的 DSH 和 Admin SSO 会话。
- **本地账号管理：** 本 fork 不注册上游的用户管理客户端和对应路由。账号及权限在 Great Admin 管理。

## 数据位置

| 数据 | 位置 |
|------|------|
| Admin access/refresh token | 仅保存在 DSH Host 进程内存；重启后重新登录 |
| 会话→Admin userId 所有权索引 | `<DSH_HOME>/.dsh-login/ownership-v2.json`（可用 `dataDir` 配置；`DSH_HOME` 环境变量或 `~/.dsh`） |
| 旧用户名所有权索引 | `<DSH_HOME>/.dsh-login/ownership.json` 保留但忽略 |
| 自动学习 / 管理员白名单 | `<DSH_HOME>/.dsh-login/trusted-hosts.json`（可用 `dataDir` 配置） |
| 默认用户工作空间开关 | `<DSH_HOME>/.dsh-login/settings.json`（可用 `dataDir` 配置） |
| 远程访问兼容开关 | `<DSH_HOME>/.dsh-login/settings-remote-web-ui.json`（可用 `dataDir` 配置） |
| DSH 登录会话 | 仅保存在 DSH Host 进程内存；重启后旧 cookie 失效 |

## `/api` 集成（option A，DSH ≥ 0.1.5-alpha.1）

DSH ≥ 0.1.5-alpha.1 下 dsh-login **不再接管 `/api` 通道**：`cordis.patch.yml` 让自带的 `connection` 行保持启用，`dsh-client-connection` + `api-remotes`/`api-gateway` 持有 `/api` 传输与实时 Remote 流。dsh-login 在这些原生栈之上组成自己的按用户层（详见 [`docs/adapt-dsh-0.1.5.md`](docs/adapt-dsh-0.1.5.md) 与验收清单 [`docs/verify-option-A.md`](docs/verify-option-A.md)）：登录墙占据 fallback 席位并通过原生 `serveStatic` 提供静态服务，同时在对 index 响应时调用 `connection.authorizeIndex`，让浏览器拿到上游 `/api` cookie。旧的 `src/connection.ts` 通道接管及其基于 `dsh-host-apiproxy` 的按用户 `ApiProxy` 已被移除。0.3.12 起按用户会话/工作区隔离由插件内置的 **dispatch-seam 守卫**自动执行（准入打标 + 逐用户分发把关 + `workspace.follow` 逐帧过滤），无需部署侧组合。REMOTE 层守卫（`wrapRemoteGateway` + `createRemoteIsolation`，及发布 `dshLoginOwnership` 服务的 `composeDshLoginGuard` 胶水）仍从宿主 bundle 导出，作为可选的部署侧组合；见 [`docs/compose-guard.md`](docs/compose-guard.md)。

**主机信任按请求实时求值。** 围栏使用 web runtime 的 LAN 字面量 + `trustedHosts` + 持久化白名单（`src/hosts.ts`）。Admin SSO callback 会按 `autoTrustHosts`（默认开启）学习请求 Host，因此经 frp/隧道访问的公网主机登录一次即被信任。

本 fork 不注册上游浏览器设置客户端。DSH 能力通过插件配置管理；身份和权限在 Great Admin 管理。

## 安全说明

### 网关保护范围

| 资产 | 保护方式 |
|------|----------|
| 页面导航 (`/`) | 未认证时 302 重定向到 `/login` |
| 静态资源 (`/assets/*.js`、`.css` 等) | 同样的网关检查 |
| SPA 路由 (`/conversations`、`/settings` 等) | 同样的网关检查 |

**进程 launch token 绝不会到达远程客户端（issue #10）。** 核心为每个进程铸造一个随机 launch token；`dsh web` 只把 `/?token=…` URL 打印在**本地控制台**，该令牌既用于铸造浏览器 Cookie，也是 `GET /connect` 兑换 owner 主体 API 凭据的凭据。早期版本通过把浏览器 302 到 `/?token=<launchToken>` 来引导新设备，这会把令牌暴露给远程客户端（Location 头 → 浏览器历史、代理访问日志）——dsh-login 0.3.9 改为在服务端完成同样的交换，直接带着铸造好的 Cookie 返回 index，令牌从此不出现在线路上。因此远程用户无法再经由 dsh-login 触达 owner 凭据；令牌保持为仅本地控制台可知的秘密，与上游的交付方式一致。

### 桥墙保护范围

| 资产 | 保护方式 |
|------|----------|
| API 请求 (`/api/*`) | `isTrustedApiRequest` 主机信任检查 **加上** 有效 `dsh_session` Cookie（缺失则 401）；普通用户白名单外 POST 方法被拒（`quietDenials` 时回 wire 正确的 forbidden envelope，否则 403）；`session.list`/`session.search`/`workspace.list` 响应收窄为拥有的会话 |
| WebSocket (`/api/remote.mux`) | 升级时主机信任 + 浏览器鉴权检查（上游围栏）；0.3.12 起 dispatch-seam 守卫同样在升级时要求有效 `dsh_session`，并对 `workspace.follow` 帧逐用户过滤 |

### 公网暴露建议

1. 开启 `autoTrustHosts`（默认）时，成功 SSO callback 会把请求 Host 学进白名单，于是 frp/隧道主机登录一次即被信任，无需手改 `trustedHosts`。如需只接受回环 + 显式 `trustedHosts`，把它设为 `false`
2. 在 DSH 前部署反向代理（nginx/caddy）进行 TLS 终结
3. DSH session Cookie 使用 `HttpOnly; SameSite=Lax`；注销端点还校验同源 `Origin`

**排障：公网普通用户"无法添加工作区"？**

几乎从不是 Host 白名单问题（`autoTrustHosts` 已自动学习，登录能通）。0.3.6 起原生目录选择器（`directoryPicker.*`）已对 DSH 用户放行，且 `workspace.create` 限制在调用者沙箱（`workspaceRoot/<userId>`）内；`defaultWorkspace`（默认开）也会在首次 `/api` 访问时预置隔离沙箱。若当前版本仍返回 `not permitted for this user`，说明该方法不在本版本 wire 面上：查看宿主日志中的 `dsh-login: /api/<method> was denied …`，再用 `node scripts/dump-wire-surface.mjs` 重新同步。
- 若 0.3.7+ 仍返回 `not permitted for this user`，说明该方法不在本版本 wire 面上：看宿主日志里每个方法只报一次的 `dsh-login: /api/<method> was denied …`（其中带目标 DSH 版本），再用 `node scripts/dump-wire-surface.mjs` 重新同步。

## 架构说明：fallback vs prefix /

网关使用 `registerFallback()` 而非 `register({ kind: 'prefix', path: '/' })`，因为 DSH WebServer 的前缀匹配逻辑检查 `pathname.startsWith(prefix + '/')`。当 prefix 为 `/` 时，拼接结果为 `//`，而正常路径不会以 `//` 开头——所以 `prefix /` 路由只能精确匹配 `/` 这一个路径。fallback 处理器能捕获所有未被命名路由匹配的请求，这才是认证网关所需的 catch-all 行为。

WebServer 只有一个 fallback 席位。dsh-web-app 的 `web-runtime` 行会无条件挂载 frontend-static 占据它，因此使用 `dsh-login` 时必须禁用 `web-runtime` 行；dsh-login 会重新提供它负责的 `webRuntime` 服务（LAN 信任、`DSH_WEB_URL`），组合其余部分不受影响。

## 运行测试

```bash
# DSH 0.2.2-rc.1 组合使用 Node >=24.9.0。
# 按 lockfile 安装已发布的 DSH 依赖，无需另行检出 DSH 源码。
npm ci
npm test
npm run verify:imports
npm run build
```

`.spec.ts` 文件是标准的 vitest 测试定义，含纯逻辑/多用户相关套件（`users`、`ownership`、`hosts`、`session`、`gateway`、`admin-api`、`capabilities`、`remote-guard`、`remote-web-ui-compat`、`client-bundle`、`settings-panel`、`plugin-entry`、`bridge-list-filter` 等）。`connection`/`api-filter`/`multiuser-e2e` 三个 spec 已在 option A 适配时移除（它们测试的是已删除的 `dsh-host-apiproxy` `/api` 接管）；`dispatch-guard.spec.ts` 覆盖 dispatch-seam 守卫（准入打标、逐用户分发把关、`workspace.follow` 逐帧过滤），`remote-guard.spec.ts` 覆盖 REMOTE 层隔离守卫（含所有权收窄与管理员放行），桥墙（401 + 方法门 + 静默拒绝 + record/filter tee + 供给触发）由 `tests/api-bridge-auth.spec.ts` 覆盖。CI 在 Node 24.9.0 与最新 Node 24.x 上运行全量测试、旧单测冒烟、源码导入检查、构建及已提交产物一致性检查。`node --import tsx/esm tests/runner.mjs` 保留为轻量单测冒烟入口；`node tests/integration-runner.mjs` 直接执行标准网关、多用户登录/初始化/退出和完整插件 HTTP 集成用例。

## 项目结构

```
src/
├── index.ts          # Cordis 插件入口：注册鉴权路由、fallback 登录墙、webRuntime
├── config.ts         # schemastery 配置 schema（Admin SSO、distIndex、dataDir、sessionTtl 等）
├── admin-sso.ts      # authorize/callback、token 交换/刷新、userinfo、logout、Host identity service
├── session.ts        # 按稳定 Admin userId 绑定的内存 DSH session
├── ownership.ts      # OwnershipIndex：DSH sessionId → Admin userId 索引
├── hosts.ts          # TrustedHosts: 信任主机白名单（去抖 JSON 持久化）
├── api-filter.ts     # 纯谓词（AuthUser/USER_ALLOWED/isUserAllowed）
├── bridge-list-filter.ts  # wire 响应观察：owned 会话闭包 + session/workspace.list 收窄（供桥墙使用）
├── host-session-access.ts  # 惰性宿主侧会话面（sessionController 优先、typertGateway 兜底），供供给/列表探针
├── provision.ts      # DefaultWorkspaceProvisioner：按用户沙箱 + registry 工作区 + 种子会话
├── glue.ts           # 部署侧组合胶水（dshLoginOwnership 服务 + composeDshLoginGuard），见 docs/compose-guard.md
├── api-bridge-auth.ts  # 共享 /api 桥墙：401 + 方法门 + 静默拒绝 + 响应观察 tee
├── remote-guard.ts   # option A 隔离：typertGateway RBAC 守卫 + createRemoteIsolation 胶水
├── dispatch-guard.ts   # dispatch-seam 守卫：准入打标 + 逐用户分发把关 + workspace.follow 逐帧过滤（issue #11）
├── settings-panel.client.js  # 上游遗留客户端；本 fork 不注册
├── workspace-setting.ts  # 默认用户工作空间 runtime 开关（继承 BooleanSetting）
├── boolean-setting.ts  # live + 持久化的 {enabled} 运行时开关，被各管理开关复用
├── remote-web-ui-compat.ts  # 写入 remote-web-ui 的 enabled+requirePairingForLan+publicBaseUrl（settings 驱动、实时）
├── capabilities.ts  # 能力发现（deriveCapabilities）+ 读探针分类（isReadProbe）
├── admin-api.ts      # 上游本地账号路由；本 fork 不注册
├── auth.ts           # Cookie helpers
├── gateway.ts        # 认证网关 fallback（登录墙 + serveStatic + 上游 connection.authorizeIndex）
├── login-api.ts      # 上游本地账号路由；本 fork 不注册
├── login-page.ts     # Admin SSO 入口页（setup 遗留模板不可达）
├── http-json.ts      # readBody/sendJson 工具 + resolveDshHome
└── web-runtime.ts    # webRuntime 接管：LAN 信任 + DSH_WEB_URL
dist/client.js        # 构建产物浏览器 bundle（npm run build:client）
scripts/build-client.mjs  # 生成 dist/client.js：设置面板 dsh.client 注册
tests/（上游隔离测试；Admin SSO 测试待补）
└── *.spec.ts         # vitest 测试定义

## 许可证

MIT
