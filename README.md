# dsh-capability-ledger

<!-- ai-made-notice -->
> **本仓库 100% 由 AI 生成** —— 需求、代码、测试、文档都是人与 AI 对话里由 AI 写出来的，人只负责验收和拍板。
> **实验性 · 自用性质 · 非商业**：它紧贴 DeepSeek Harness（DSH）的宿主接缝（`apply` / `inject` / client bundle / 配置解析），只在写它的那个 DSH 版本上验证过，宿主升级后可能直接失效。
> **安装前必读**：DSH 的 profile 加载是**全有或全无**——一个插件 `import` 失败会连坐整个 profile，甚至把配置写残。装之前先备份 profile 里的 `package.json` 与 `cordis.patch.yml`。
> **没有发布到 npm**：把本目录放进 profile 的 `node_modules`（或 `"<包名>": "link:<本目录绝对路径>"`），再在 `package.json` 的 `dsh.profile.bundles` 里登记，重启 DSH。
> **卸载/回滚**：从 `dsh.profile.bundles` 摘掉 → `pnpm remove <包名>` 或删掉 junction → 重启；出问题就用备份的那两个文件还原。

一个自研的 DSH 插件：**一次扫描，回答两个问题**——

1. **能力台账**：14 个 skill、几十个工具，哪些真的被加载/调用过？每次请求固定注入多少 token，钱花在哪个 bundle 上？
2. **安全体检**：现在装的这些插件，下次重启会不会把整个 profile 连坐崩掉？有没有安装期脚本、明文凭据、宿主 peer 影子副本、升级后会过期的 `@deepseek-ai/*` 副本？

两个问题共用一次扫描，只读，不改任何配置。红项只给**可复制的处置命令**，停用/卸载永远由人决定。

> **当前状态（2026-10-31）：面板未挂载。**
> 面板上线两个多月只有我自己点开过，用户对它没有体感，按"没人看就停"的自定规则从 desktop profile 摘掉了。
> 保留下来的是**体检与闸门**：`node scripts\audit-cli.mjs`（体检）、`node scripts\preflight-restart.mjs`（重启前三问，已接进 `tools\dsh-restart-safe.ps1`）。
> 源码与面板都在，重新挂载只要三步：
> 1. `<dsh-home>\profiles\desktop\package.json` 的 `dependencies` 加 `"dsh-capability-ledger": "link:<repo>"`，`dsh.profile.bundles` 加 `dsh-capability-ledger`；
> 2. `pnpm install --prefer-offline`（在 profile 目录里跑，它会把 junction 建回来）；改 manifest 用 `node <workspace>\tools\profile-set.mjs remove|show bundle|dep <id>` 那个小工具，别手抄 JSON；
> 3. `node tools\gate-profile-boot.mjs` 的 `EXPECTED` 改回当时形态，再重启。

## 为什么不用现成的

先例都看过了，但都只解决一半，而且都要么依赖别人的运行依赖、要么只算次数不算成本：

| 先例 | 取它的什么 | 为什么不装 |
| --- | --- | --- |
| `@dsh-cc/skill-usage@0.9.2` | 口径：只读监听 + 用 `callId` 配对「调用→结果」，只记 committed load | 带 5 个 `@dsh-cc/*` 运行依赖，为一个记账要背一条依赖链 |
| `dsh-skill-scoreboard@1.1.2` | 口径：按会话去重累计 + 只读 GET 路由 + 设置卡挂载 | 只有 skill 计数，没有工具/固定成本；面板形态与本机 profile 不兼容 |
| `dsh-skill-radar` | 口径：时间窗口 + 零命中标「建议归档」 | 只看 skill、只看最近 7 天 |
| `uio-o/dsh-plugin-operation-log`、`JeffreySuen-x/dsh-skill-dossier` | 仅 UI 参考 | 不是台账 |

**只取机制、自己重写，零第三方依赖**（`node:` 内置模块 + `react` 由 shell 提供）。

## 面板

- 侧边栏底部 Settings 旁一个「台账」按钮 → 打开 `main` 区的全屏页（key `capability-ledger`）。
- 标题下一行「统计窗口」：全部历史 / 最近 90 天 / 最近 30 天。切窗口是**换分母**，不是过滤表格——会话、轮次、请求、成本全部按窗口重算；窗口模式下不做跨窗口 diff（那是假 diff），也只在「全部历史」时写基线快照。
- 五个页签：
  - **总览**：会话/轮次、工具调用、每请求固定 schema 字节与 ≈token、技能零使用数、体检红项；成本按 bundle 分布；与上次快照的 diff。
  - **技能台账**：每个 skill 的加载次数（含斜杠调用，单独标出）/ 涉及会话数 / 尝试失败数 / 描述字数（左「模型可见」右「完整」，可见 < 完整 即真截断）/ 是否还在目录 / 最后加载时间 / 判定。
  - **工具台账**：每个工具的调用、失败、schema 字节、是否被注入、归属 bundle、判定；下方是每个 bundle 的固定成本表。
  - **安全体检**：结论（可重启 / 不可重启）、红项、黄项、说明、版本漂移、逐 bundle 明细、可复制的闸门与备份命令。
  - **候选预检**：输入 npm 包名或本地插件目录，装之前先扫。

## 口径（可检验，别当账单）

- **技能加载**：会话事件 `tool/call` 中 `name === 'skill'`，用 `callId` 与 `tool/result` 配对，且 `!data.error && !message.isError` 才算一次成功加载。技能名取 `arguments` JSON 字符串里的 `name`。斜杠形态（`user/message` 且 `data.source.kind === 'skill-invocation'`）另行计入同一张表并标 `slashLoads`，因为它不会产生 `skill` 工具调用。
- **技能目录与截断**：取会话里 `user/message` 且 `data.source.kind === 'skill-catalog'` 的 `source.entries`（`[{name, description}]`）——这就是模型当时看到的原文，所以「模型可见字数」是观测值。完整描述来自 `ctx.skills.list()`，但宿主只有本层技能：bundled 技能注册在 agent preset 层，插件拿不到全文。因此截断分三档：`measured`（可见 < 完整，确定截断）、`suspected`（看不到全文，但可见字数正好顶到 500 上限，标「疑似」不断言）、`none`。
- **工具调用**：同上，按工具名累计；失败单独计。
- **固定成本的两个数**：`每请求注入（历史实测）` 取每条会话 `request/header` 里真实注入的 `header.tools`，按 `JSON.stringify({name,description,parameters})` 的 UTF-8 字节累加取均值；`当前注册表（下次请求）` 是 `ctx.tools.schemas()` 当下总和。两者差在历史请求里可能含已移除工具，**不要混读**——能靠停用省下的只有后者。token 按 **3.5 B/token** 估算，只用于横向比较。
- **工具来源分档**：`plugin`（在已装 bundle 源码里找到该工具名的引号字面量）、`mcp`（`mcp__<server>__<tool>` 前缀，按 server 归行）、`builtin`（宿主/预设动态注册，静态找不到归属，摘不掉）。分档的意义是「可摘 vs 不可动」：只有可摘的那部分能真的省 token。
- **统计窗口**：按会话 `header.createdAt` 与 `now - N 天` 比较筛选，`window.covered` 是窗口内会话数、`window.available` 是磁盘上全部会话数。窗口越小，判断「最近还在用吗」越准、判断「这个 skill 一辈子没用过」越不准——所以要两个窗口一起看。
- **判定规则**（提示，不是自动动作）：
  - skill：`加载 0 次` → 零使用（建议归档/删）；`< 2 个会话` → 观察；`≥ 2` → 保留。
  - 工具：`调用 0` → 零调用；`< 3` → 少量；否则常用。
  - 体检红项：client 产物无法 materialize / bundle 列了但没装 / 宿主入口缺失 / 明文凭据 → **现在就会连坐启动**。黄项：非 optional 宿主 peer、安装期脚本、版本漂移等形态风险，当前不失败。

## 安全体检做了什么

移植自本项目自己的闸门 `<workspace>\tools\audit-dsh-plugins.mjs`，并改成纯函数 `auditProfile(profileDir)`（面板 / 测试 / CLI 共用一份实现）：

- 读 profile 的 `package.json`（`dsh.profile.bundles` / `dependencies`）与 `cordis.patch.yml`。
- 对每个 bundle：包在不在 `node_modules`、宿主入口在不在、**客户端产物用 `window` shim 真实执行一遍**（和 shell 加载器同一契约：`__ModuleLoader__.load({id, factory})` → 校验 id → 跑 `factory(require)`），相对依赖缺失 = 致命（就是 2026-10-29 那次崩溃的形状），平台外部依赖缺失 = 正常。
- 非 optional `peerDependencies`（`@deepseek-ai/*` 宿主包被声明为非 optional 时，pnpm 会物化一份影子副本）。
- `preinstall/install/postinstall/prepare` 脚本。
- 明显的明文凭据字面量（只报**位置**，绝不回显值）。
- profile 内 `@deepseek-ai/*` 副本 vs 应用自带版本（nightly 升级后易过期）。

「应用自带版本」是这么找的：`DSH_APP_ASAR` / `DSH_APP_ROOT` / `DSH_INSTALL_DIR` 环境变量 → `process.resourcesPath`（只在应用内有效）→ 注册表 `...\Uninstall` 的 `InstallLocation` → `%LOCALAPPDATA%\Programs\DeepSeek Harness` → `%ProgramFiles%`。找到后直接解析 `app.asar` 的 header 读 `/dsh/package.json` 与 `/dsh/node_modules/@deepseek-ai/*/package.json`（asar 的 `offset` 是十进制字符串，不能当数字用）。

**找不到应用副本时不会假装没事**：会推一条黄项「version drift was NOT checked」并提示设 `DSH_APP_ROOT`，而不是静默给出"无漂移"。9 个漂移包会合并成一条黄项，明细在 `versionDrift` 数组里、面板上逐行列出。
- deps 有、bundles 没有的包。

**不做**：不安装、不停用、不卸载、不执行插件业务代码、不改 profile 任何文件。唯一的写入是报告快照。

## 隐私红线

- 台账只读**本机会话日志**与 profile 清单，不上传任何会话内容、不联网。
- 候选预检里只有「输入 npm 包名」这一路会联网（`npm view --json` 查元数据），且不下 tarball、不执行包代码。
- 任何时候如果要「把会话内容上传」，就是这条方案该停的信号。

## 重启闸门（一键三问）

```powershell
node <repo>\scripts\preflight-restart.mjs
# 指定 profile / 落盘路径 / 只留退出码
node ...\scripts\preflight-restart.mjs --profile <dsh-home>\profiles\desktop --json <workspace>\reports\preflight.json --quiet
```

一次问三个问题，**任一为否就拒绝重启**：

1. **manifest**：本插件还在 `dependencies` 且还在 `dsh.profile.bundles` 里吗？（只登记一半、或两项都没了 = profile 已经被壳自愈截断。）
2. **audit**：`auditProfile()` 有红项吗？（红项 = 下一次启动就会连坐的那些，比如 client 产物 materialize 失败、bundle 列了没装。）
3. **gate**：调 `<workspace>\tools\gate-profile-boot.mjs`（用 `DSH_GATE_SCRIPT` 覆盖）——真实的 profile 组合是否仍然通过：bundle 数、patch 条数、被跳过的 bundle、组合警告。

| 退出码 | 含义 | 该怎么办 |
| --- | --- | --- |
| `0` | 可以重启 | 重启，或用 `tools\dsh-restart-safe.ps1` |
| `1` | 拒绝重启（有红项） | 按打印的红项修，修完再跑一次 |
| `2` | 环境错误（profile 无效等） | 什么都没验证，别当通过 |

`<workspace>\tools\dsh-restart-safe.ps1` 已经接上它：有本脚本时优先调用（旧 `audit-dsh-plugins.mjs` 作兜底），非 0 就保留快照并退出，不再往下重启。每次运行都会写 `<workspace>\reports\preflight-latest.json`。

## 体检 CLI

```powershell
node <repo>\scripts\audit-cli.mjs
# 指定 profile / 落盘 JSON / 只留退出码
node ...\scripts\audit-cli.mjs <dsh-home>\profiles\desktop --json <workspace>\reports\plugin-audit.json --quiet
```

存在红项时退出码 `1`，可直接接进重启前置检查：

```powershell
node <repo>\scripts\audit-cli.mjs --quiet
if ($LASTEXITCODE -ne 0) { Write-Error '体检有红项，不要重启 DSH'; exit 1 }
```

## HTTP API（只读）

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/capability-ledger/report` | GET | 台账 + 体检 + diff + meta；`?refresh=1` 强刷；`?window=all\|<天数>` 换统计窗口 |
| `/api/capability-ledger/audit` | GET | 只体检 |
| `/api/capability-ledger/candidate` | POST `{spec}` | 候选预检（npm 元数据 / 本地目录） |
| `/api/capability-ledger/export` | POST | 写 `capability-ledger-<时间戳>.json` + `.md` |

## 数据落地

- 最近快照：`<workspace>\reports\capability-ledger-latest.json`（面板每次刷新「全部历史」时 60s 节流自动写，用于 diff；窗口模式不写）
- 闸门快照：`<workspace>\reports\preflight-latest.json`（每次 preflight 覆盖写）
- 导出：同目录 `capability-ledger-<YYYYMMDD-HHMMSS>.json` / `.md`，窗口模式文件名带 `-<N>d` 后缀
- 路径覆盖：`DSH_CAPABILITY_LEDGER_DIR`（报告目录）、`DSH_PROFILE_DIR`（profile 目录）

## 安装 / 卸载

装：

```powershell
# 1) 备份（AGENTS.md 硬规则：bundle 加载全有或全无）
Copy-Item <dsh-home>\profiles\desktop\package.json <dsh-home>\profiles\desktop\package.json.bak -Force
Copy-Item <dsh-home>\profiles\desktop\cordis.patch.yml <dsh-home>\profiles\desktop\cordis.patch.yml.bak -Force
# 2) 在 profile package.json 的 dependencies 加 link，并加进 dsh.profile.bundles
#    "dsh-capability-ledger": "link:<repo>"
# 3) 重启前跑闸门
node <repo>\scripts\audit-cli.mjs --quiet
```

卸载：从 `dsh.profile.bundles` 与 `dependencies` 移除该项，重启。

## 开发

```powershell
cd <repo>
node --test test/*.test.mjs
```

`test/client.test.mjs` 是**接缝测试**：它按 shell 的真实契约 eval `client.js` → 捕获 `__ModuleLoader__.load` → 调 `factory(require)` → 调 `apply(ctx)`，断言注册了 `sidebar.footer.action` 与 `main#capability-ledger`。只读源码文本的测试抓不到「加载即崩」，这个能。
