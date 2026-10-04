# 交付总览 —— 第一次接手这个插件时看这一页

> 这篇是**索引与账本**，不是设计契约：每个数字、每个默认值、每条结论都能在仓库里核对，本文在每节
> 末尾给出可复核的文件或命令。若本文与代码/契约文档不一致，**以代码与契约文档为准**。
> 讲原理看 `docs/protocol-v1.md`（服务面）、`README.md` / `README.zh.md`（用户用法）、`CHANGELOG.md`（逐版事实）。

## 1. 一句话定位

**给 DSH 的本地优先长期记忆插件：在回合结束时用规则从「真实用户消息」里抽取值得记住的内容，存进
`$DSH_HOME/storages/<domainName>/`，下一次会话再把该记的部分按预算注入回模型的上下文——并且让每一条记忆
都能回答「你凭什么这么说」。**

它解决三个具体问题：

| 问题 | 插件给出的答案 |
|---|---|
| 上一轮会话里说过的偏好、约定、事实，下一轮就没了 | 规则捕获 + 持久化；画像 / 自画像 / 项目印象常驻注入（R1），与本轮真正相关的按需召回（R2） |
| 记忆可能记错、记脏，或根本是模型臆测的 | 每条记录带**来源**（会话 + 事件序号区间，`refs`）可回原文核对；`memory_explain` 说清命中哪条信号、命中哪些 token；可删除、可导出 |
| 模型自己写进来的内容会污染上下文 | 可选**写入审批门**（`writePolicy`）；回声去除；`pending` 永不进注入；用户所有物不被模型改写；硬秘密拒写、PII 脱敏 |

它**不是**什么（同样是硬事实）：不自带模型、自己不联网、零运行期依赖（`pnpm verify:self-contained` 断言）；
不提供图形化记忆浏览器（界面只做配置）；语义检索只有宿主注入 embedder 时才存在。

依据：[`package.json`](../package.json) 的 `dependencies`（不存在）、[`SECURITY.md`](../SECURITY.md)、
README 的「Three paths」「Known limitations」、[`docs/protocol-v1.md`](protocol-v1.md) §11。

## 2. 能力清单（按用户能感知到的功能组织）

| 能力 | 你能感知到什么 | 落地版本 | 契约 / 依据 |
|---|---|---|---|
| 本地存储 + 设置表单 | 数据全在 `$DSH_HOME/storages/<domainName>/`（默认 `dsh_memory`），全机一份；设置页 30 个字段改完即热生效 | 存储与浏览器半边 **0.4.2**（首个公开提交）；表单 30 字段于 **0.5.14** | README「The settings form」；`docs/protocol-v1.md` §5 |
| 规则捕获（零模型调用） | 回合结束时从**真实用户消息**抽偏好 / 约定 / 事实；硬秘密直接拒写、PII 脱敏后写入；同一事实换会话再提会提升重要性而非新增重复行 | **0.4.2** | README「Three paths」§1 |
| 双通道注入 | R1 常驻：用户画像 + 自画像 + 当前工作区项目印象；R2 每轮：只注入与本轮真正相关的那几条，带 per-id 冷却与 token 预算 | **0.4.2** | README「Three paths」§2；协议 §3.3 |
| 自画像（人格 + 工作倾向） | 模型对自己的认知（我是谁 / 怎么说话 / 工作倾向），机会式更新：合并 / 强化 / 细化 / 取代 / 跳过，取代保留版本链；低频反思提示 | v2 于 **0.5.4**（页脚口径改为「按事实判断」于 **0.5.5**） | [`docs/self-portrait.md`](self-portrait.md)（M6） |
| 首次称呼一次性设定 | 从第 2 回合起、每会话最多一次、跨会话累计最多 `selfIntroMaxAsks`（默认 2）次，模型用**一句话**问「我叫你什么、你怎么称呼我」；明确拒绝也算「定过了」，永不再问 | **0.5.6** | `docs/self-portrait.md` §7（M7） |
| `/sleep` 空闲梳理 | 独立命令（不是 `/memory` 子命令）：预览默认、不写盘；`--apply` **先备份再写**；重放最近会话完整日志补录漏掉的，再对全库重跑合并 / 冲突 / 归档 / gist | **0.5.7** | [`docs/sleep.md`](sleep.md)（M8） |
| 可核验引用 | 每条记忆带 `refs`（会话 + 事件序号区间）；`/memory verify <id>` 回原文用 token 覆盖率核对并给 `✅ hit / ⚠️ miss`；`/memory show` 打印 `source:` 行 | **0.5.9**（模型可见的 `refs` 字段于 **0.5.16**） | [`docs/refs.md`](refs.md)（M9） |
| 写入审批门 `writePolicy` | `auto`（默认）立刻生效 / `ask` 进待确认队列 / `off` 直接拒绝并给可读原因；规则捕获、用户命令、`/sleep`、导入**永不被门控**；模型无法自己批准；`pending` 不进任何注入路径 | **0.5.10** | [`docs/write-policy.md`](write-policy.md)（M10） |
| 模型可见文本多语言 | `language: 'zh'`（默认）/ `'en'` 只切**模型读到的东西**：注入块及其页眉页脚、反思 / 首次设定提示、R2 块、7 个工具的描述；命令输出**保持中文** | **0.5.11**（英文自画像在默认预算下不渲染的缺陷于 **0.5.12** 修复） | [`docs/i18n.md`](i18n.md)（M11） |
| 分支感知的项目记忆 | 记录可带 `branch` 标签，注入 / 召回按当前 git 分支过滤；分支未知时带标签行 **fail-closed** 不注入；只读 `.git/HEAD`（含 worktree 的 `gitdir:` 指针），**从不执行 git 命令** | **0.5.13** | [`docs/branch.md`](branch.md)（M12） |
| 写入审计与注入核对 | `/memory audit` 并列两种视图：**记录派生**（持久）+ **有界内存尝试环**（含被拒 / 入队 / 批准，重启即失）；`--verify` 用逐字 `includes` 核对本会话注入，缺口明说而不是报「通过」 | **0.5.14** | [`docs/audit.md`](audit.md)（M13） |
| 工具输出带出处 | `memory_recall` / `memory_list` 的每条命中带机器可读 `refs`（`sessionId#from-to`，多条用 `;` 连接；无引用给 `''` 而不是缺键） | **0.5.16** | `CHANGELOG.md` 0.5.16 |
| 来源反查 | `/memory trace <会话 id 前缀> [#<seq>]`：从一次会话反查它留下了哪些记忆，可按事件序号收窄；只读、分支过滤生效、`pending` 不出现；**故意不加第 8 个工具** | **0.5.17** | [`docs/trace.md`](trace.md)（M15-A） |
| 零依赖词面检索升级 | 中文 bigram + 单字兜底、英文轻量词形归并、IDF 加权代替等权命中率、长度归一化让「短而精准」胜过长文堆砌；`memory_explain` 报命中 token 与各自贡献 | **0.5.17** | [`docs/semantic.md`](semantic.md)（M15-B） |
| 服务面冻结：`ctx.memory` v1 → v1.3 | 第三方插件可依赖 `list` / `stats` / `recall` / `write` / `consolidate`，v1.3 起另有 `setEmbedder` / `capabilities` / `lastRecall`；版本用 `'1.x'` 谓词判断，永不用等号 | v1 **0.5.17**；v1.1 **0.5.18**；v1.2 **0.5.19**；v1.3 **0.5.20** | [`docs/protocol-v1.md`](protocol-v1.md) §1/§9/§10/§11 |
| 外接嵌入器（可选） | 宿主通过服务面注入 `embed` 后才可能按语义打分：`recall({ mode: 'semantic' \| 'hybrid' })`；未注入时**逐字节**回落词面并在 `lastRecall()` 明说 `fallback: 'no-embedder'`；嵌入失败永不冒泡、永不丢记忆 | **0.5.20** | [`docs/embedder.md`](embedder.md)（M18） |
| 工程门禁 + 变异体检 | 六道闸进 CI（Node 22.x / 24.x），另有常驻变异工具 `pnpm mutate` 回答「测试到底钉住了什么」 | 门禁 **0.5.15**；`mutate` **0.5.24** | [`CONTRIBUTING.md`](../CONTRIBUTING.md)、[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |

里程碑编号（M6 自画像、M8 `/sleep`、M9 refs、M10 审批门、M11 多语言、M12 分支、M13 审计、M15-A/B 反查与检索、
M16–M18 协议 v1.1/1.2/1.3）见对应 `docs/*.md` 的标题。

## 3. 架构一页图

```
                        ┌───────────────────── DSH 运行时 ──────────────────────┐
   用户 ──── turn ────▶ │ agent/pre-step      ─▶ [R2 每轮召回块]                 │
                        │ agent/turn-stopping ─▶ 规则捕获（只认真实用户消息）    │
   模型 ◀── context ─── │ session/event       ─▶ 事件序号跟踪（refs 的原料）     │
                        │                                                       │
                        │  宿主半边 src/index.ts ──调用──▶ 纯函数层 src/lib.ts   │
                        │   ├─ 7 个 memory_* 工具   （ctx.tools.register）       │
                        │   ├─ /memory 与 /sleep    （ctx.commands.register）    │
                        │   ├─ R1 常驻块：画像 / 自画像 / 项目印象               │
                        │   │   （ctx.systemPrompt.section + .context）          │
                        │   └─ ctx.provide('memory', …) ──▶ 协议面 ctx.memory v1.3
                        └───────────┬───────────────────────────────┬───────────┘
                                    │                               │
                  ctx.storageDomain.open()              ctx.get('sessionQuery')
                                    ▼                               ▼
             $DSH_HOME/storages/<domainName>/          会话日志：一行 JSONL = 一个 zstd 帧
             ├── global.json   水位（schemaVersion、    tools/session-log.ts 逐帧解压
             │                 collectionVersion、lastSleepAt…）   /sleep 补录、/memory audit --verify、
             └── memories/<id>.json  { version, record }            /memory trace 都读它

   浏览器半边 src/client.ts → lib/client.js：
   注册进 keyed 的 plugins.row.config（key = dsh-plugin-memory#dsh-memory），把 30 个 volatile 字段渲染成表单
```

| 半边 / 面 | 位置 | 职责 | 关键事实 |
|---|---|---|---|
| 宿主半边 | `src/index.ts` | 存储、捕获、注入、整合、工具、命令、审计、服务面 | 必需接缝 `inject = ['agents','systemPrompt','storageDomain','tools','commands']`；注册 7 工具 + 2 命令 + 两条注入通道，并 `provide('memory')`（协议 §2.1） |
| 纯函数层 | `src/lib.ts` | 无 `ctx`、无 I/O 的全部判定与渲染 | 单测的全部对象；变异体检的多数目标 |
| 客户端半边 | `src/client.ts` → `lib/client.js` | 设置表单（30 个 volatile 字段） | 编译成 CommonJS 后再包成 `__ModuleLoader__.load({ id, factory })` |
| 存储域 | `ctx.storageDomain.open({ name, version: 1, layout: 'per-record', tables: { memories } })` | 一条记录一个文件 + 一个全局水位 | 句柄只需 `global.get/set`、`table('memories').entries/put/delete`、`close`（协议 §2.2） |
| 会话日志 | `ctx.get('sessionQuery')`；`tools/session-log.ts` | `/sleep` 补录、`--verify` 核对、`trace` 回指的精确读取来源 | DSH 一行一 zstd 帧，单帧解压只拿得到会话头（`CHANGELOG.md` 0.5.8） |
| 协议面 | `ctx.memory`（`protocolVersion = '1.3'`） | 第三方唯一可依赖的接缝 | 工具注册、命令输出、报告文件、设置表单、存储布局都是**内部实现**，可随 patch 变（协议 §2.4） |
| 类型与接缝 | `src/types.ts`、`src/shims.d.ts` | 领域类型 + 实测验证过的 DSH 接缝子集 | npm 上的 `@deepseek-ai/*` 比运行中的 DSH 旧，按实测子集打类型 |

**目录职责**

| 路径 | 作用 |
|---|---|
| `src/` | 四个源文件：`index.ts`（宿主）、`lib.ts`（纯函数）、`client.ts`（界面）、`types.ts` + `shims.d.ts`（类型与接缝） |
| `lib/` | 构建产物，**刻意提交**：GitHub 安装不跑构建脚本，所以它必须与 `src/` 同提交（CI 用 `pnpm build && git diff --exit-code -- lib` 验） |
| `tools/` | 零依赖开发工具：`mutate.ts`（变异体检）、`check-readmes.ts`（中英结构一致性）、`verify-self-contained.ts`（零运行期依赖 + 打包 + 发布物隐私）、`coverage-check.ts`（覆盖率门槛）、`session-log.ts`（会话日志读取）、`bench.ts` / `eval-recall.ts` / `deploy-dev.ts` / `build-client.ts` / `extract-asar.ts` / `scan-asar.ts` 等 |
| `tests/` | 7 个套件（`lib` / `host` / `tools` / `protocol` / `docs` / `client` / `module`），全部跑在构建产物 `lib/*.js` 上 |
| `docs/` | 契约与机制说明，**整目录进发布包**（0.5.18 起）；本页也在其中 |
| `reports/` | 开发期运行自报（`reportPath` 打开时）的 JSON 快照，与评测记录；不是测试基线 |
| `artifacts/` | 发布 tarball（当前 `dsh-plugin-memory-0.5.24.tgz`） |
| `spike/` | 最早的宿主接缝探针与实验报告（M-1），保留作历史证据 |
| `.github/workflows/ci.yml` | 六道闸 + 构建产物同步 + 打包清单断言，Node 22.x / 24.x 双矩阵 |
| `cordis.patch.yml` | 这个插件作为 bundle 贡献的补丁层 |

## 4. 协议面摘要：`ctx.memory` v1.3

服务面在 `apply()` 里注册一次，**一切在 v1 内只做加法**（协议 §1）。判兼容用 `'1.x'` 谓词，**不要**用字符串等号：

```ts
const memory = ctx.get('memory') as MemoryService | undefined
if (!memory) return                                   // 服务是可选的：缺失不是错误
if (memory.protocolVersion && !/^1\./u.test(memory.protocolVersion)) return
```

| 方法 | 形状要点 | 引入 |
|---|---|---|
| `protocolVersion` | `'1.3'`（v1.0 → v1.3 逐版递增） | v1.0 |
| `list(options?)` | `{ status?, branch?, limit? }`；**无参 = 未过滤的原始视图**（含 `pending` / `invalid` / `archived`，返回活对象） | v1.0；三个可选项 v1.1；`branch` 接受**数组** v1.2（空数组 ⇒ 空结果，不是「不过滤」） |
| `stats()` | `{ records, version, opened }` + `writes: { persisted, unpersisted }` + `embedder: { id, dimensions, calls, errors, hits, misses, timeouts }` | v1.0；`writes` v1.2；`embedder` v1.3 |
| `recall(options)` | `{ query?, kind?, scopeLevel?, tag?, limit?（默认 8，clamp 1…50）, minLexical?, minMatch?, minHits?, includeArchived?, status?, branch?, mode? }`；返回 `RecallHit[]`，**只有真会调嵌入时才返回 Promise** | v1.0；`status` / `branch` v1.1；`branch` 数组 v1.2；`mode` v1.3 |
| `write(input)` | 成功形状带 `persisted`（是否真到盘）与 `refs: string[]`；**拒绝形状没有这两个键**；`ok: true` 只表示「内存里已生效」 | v1.0；`persisted` v1.1；`refs` v1.2 |
| `consolidate(reason?)` | `Promise<void>`；幂等式整理，内部失败记录不抛 | v1.0 |
| `setEmbedder(embedder \| null)` | 注册 / 替换 / 清除；非法输入 `rejected_invalid` 且**不改变**现有注册 | v1.3 |
| `capabilities()` | `{ protocolVersion, lexical: true, embedder, embedderId }`——用探测代替猜测 | v1.3 |
| `lastRecall()` | 上一次召回的 `{ mode, used, fallback, candidates, vectors }`，没调过为 `null` | v1.3 |

`mode` 这**一个键带两套词表**（协议 §3.3）：`'query'` / `'memory'` 选**词面姿态**（查询侧怎么打分，缺省 `'query'`），
`'lexical'` / `'semantic'` / `'hybrid'` 选**排序通道**；非法值一律按缺省处理，不报错也不猜。

**三条载荷级约定**（协议 §4.4，每条都有专门断言钉在 `tests/protocol.test.ts`）：

1. **`pending` 不进任何注入路径**——常驻块、每轮召回、`recall()` 默认口径全都过滤
   `status === 'active'`；只有显式 `status: 'pending' | 'invalid' | 'all'` 的审计查询、`/memory pending` 与
   `memory_explain` 诊断能看到它。没有「这是模型自己的提议」的例外。
2. **`refs` 不进指纹**——同 kind / scope / subject / text 而来源不同的两次写入仍是**一条**记录（第二次
   `status: 'merged'`），引用被合并进去。否则同一件事会因为「从哪来」不同而算两条，去重与 `/sleep` 幂等一起坏掉。
3. **`branch` 进指纹**——但只在记录真的带非空标签时（`...(branch ? [branch] : [])`）。于是「到处都成立的约定」
   与「只在 `feature/x` 上成立的临时约定」是两条记录，而**无标签记录的指纹与这个功能出现前一模一样**；
   若做成无条件，全库指纹会在升级瞬间重写。

指纹本体是 `kind | scope.level | scope.key | subject | normalizedText [| branch]` 的 FNV-1a 值，**只用于比较相等**，
不要解析、不要当 id 持久化。

## 5. 工程门禁：六道闸 + 一项变异体检

发布检查清单（顺序与理由）见 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 的「发布检查清单」。六道闸的含义：

| 闸 | 查什么 | 怎么跑 | 退出码 / 读法 |
|---|---|---|---|
| ① `typecheck` | 四套 `tsc`：宿主半边（`tsconfig.json`）、客户端半边（`tsconfig.client.json`）、`tools/`、`tests/`；后两套是 `noEmit` | `pnpm typecheck` | tsc 非零即失败；这是「四套全绿」里最先跑的一道 |
| ② `test` | 先构建（`tsc` + 客户端包装），再用 `node --test` 跑 7 个套件（跑的是**构建产物** `lib/*.js`），最后自动跑 README 一致性 | `pnpm test` | 任一用例失败或 README 漂移 ⇒ 非零 |
| ③ `lint` | oxlint 只开 `correctness` 类规则；`lib/`、`build/`、`artifacts/` 排除；`src/client.ts` 的三斜杠引用有单条窄豁免 | `pnpm lint` | 有 finding ⇒ 非零 |
| ④ `check:readmes` | 中英两份 README 的**六项结构一致**：`## ` 小节数量与共有锚点顺序、代码围栏成对、表格首列键集合、表单字段数、`/memory` + `/sleep` 命令集合、顶部互链 | `pnpm check:readmes`（`pnpm test` 末尾也会跑一次） | `0` = 全部对齐；`1` = 有漂移并逐条点名 |
| ⑤ `verify:self-contained` | 四件事：`dependencies` 为空、`src/`+`tools/` 的裸导入只来自 devDependencies / 内置模块 / 客户端外部模块、`npm pack` 实际产物的必需成员齐全、**发布物隐私扫描**（本机用户名、盘符与 POSIX 家目录绝对路径、UNC、`~/`、真实 `$DSH_HOME`、常见凭证形状）。身份类判据在 CI 里不可用（用户名是 `runner`/`root`）时**显式降为 skip 并说明「没有扫」**，绝不把「跳过」写成「干净」 | `pnpm verify:self-contained` | `0` = 通过或**显式**跳过；`1` = 有失败项；跳过 ≠ 通过 |
| ⑥ 覆盖率门槛 | 只看两个产物的行覆盖率：`lib/lib.js` 与 `lib/index.js`。门槛按取数口径**分开**：报告口径（`--report`，即 `pnpm coverage:check` 用的那套，实测 99.06% / 85.55%）门槛为 **97 / 83**；自算口径（`--coverage-dir`，实测 100.00% / 96.76%）门槛为 **98 / 94**。两套数字不可混用 | `mkdir -p .tmp` → `pnpm coverage > .tmp/coverage.txt 2>&1` → `pnpm coverage:check` | `0` = 两个文件都达标；`1` = 低于门槛、**或输入缺失**（「量不到」不当作「通过」） |
| ＋ 变异体检 | 不是发布闸门，但决定「测试钉住了什么」：`tools/mutate.ts` 里的 **92 条**常驻变异（阈值边界、护栏反转、默认值、缓存淘汰、排序兜底、指纹字段增删，以及客户端表单模型与 `memory_explain` 的分支）逐条改坏一份**临时副本**（`node_modules` 用链接指回，原件一行不改），重建后跑全量；`killed` = 测试发现了，`survived` = 盲区，`build-error` = 编译期就被拦下（单列，不冤杀也不当存活） | 摸底 `pnpm mutate`（确定性抽 8 条）→ 复查 `pnpm mutate --only <id>` → 发布前 `pnpm mutate:full`（`--limit 0`，跑全目录，约 6 分钟）→ 机器可读 `pnpm mutate:ci`（stdout 是纯 JSON） | `0` = 全部被杀死（或编译期拦下）；`1` = **存在存活**（体检不合格的信号）；`2` = 环境问题（node/tsc 缺失、副本建不起来、目录过期）。参数还有 `--seed`（可复现）、`--keep`（保留副本）、`--list`（只看目录） |

CI（`.github/workflows/ci.yml`）在 Node 22.x 与 24.x 两个矩阵上依次跑：typecheck → lint → test → check:readmes →
verify:self-contained → 覆盖率门槛，然后额外验两件与发布直接相关的事：**构建产物与源码同步**
（`pnpm build && git diff --exit-code -- lib`）与**打包清单含插件管理器要的成员**（`lib/index.js`、`lib/client.js`、
`cordis.patch.yml`、`package.json`）。

## 6. 质量证据

### 6.1 测试数量的演进（146 → 498）

各里程碑契约文档里写死的「现有 N 项不许回退」构成了一条可核对的演进链（`docs/*.md` 的「验收标准」小节）：

| 里程碑 | 契约文档 | 当时的用例数下限 |
|---|---|---|
| M8 `/sleep` | `docs/sleep.md` | 102 |
| M9 refs | `docs/refs.md` | **146** ← 本页说的起点 |
| M10 审批门 | `docs/write-policy.md` | 181 |
| M11 多语言 | `docs/i18n.md` | 201 |
| M12 分支 | `docs/branch.md` | 221 |
| M13 审计 | `docs/audit.md` | 245 |
| M15 反查 + 检索 | `docs/trace.md` / `docs/semantic.md` | 273 |
| M16 协议 v1.1 | `docs/protocol-v1.1-changes.md` | 302 |
| M17 协议 v1.2 | `docs/protocol-v1.2-changes.md` | 318 |
| M18 协议 v1.3 | `docs/embedder.md` | 334 |
| 变异第一轮 | `CHANGELOG.md` 0.5.22 | 397 → 435 |
| 变异第二轮 | `CHANGELOG.md` 0.5.23 | 435 → 467 |
| 变异第三轮 | `CHANGELOG.md` 0.5.24 | 467 → **498** |

**0.5.24 交付时**的 498 项构成如下（逐文件数 `test(` 即可核对；仓库在开发中会继续增长，最新的真实数字以
`node --test` 的实际输出为准）：

| 套件 | `tests/lib.test.ts` | `host` | `tools` | `protocol` | `docs` | `client` | `module` | 合计 |
|---|---|---|---|---|---|---|---|---|
| 用例数 | 243 | 159 | 37 | 39 | 15 | 3 | 2 | **498** |

复核命令（读构建产物，不重新构建）：

```sh
node tools/check-readmes.ts
node --test tests/lib.test.ts tests/client.test.ts tests/host.test.ts tests/tools.test.ts tests/module.test.ts tests/protocol.test.ts tests/docs.test.ts
```

### 6.2 三轮变异测试：规模与结果

三轮都遵循同一套纪律：**只改测试，不改生产代码**；每条存活变异先补一条精确用例，并在临时副本上双向实测
（变异版红、未变异版绿）。数字逐字引自 `CHANGELOG.md` 0.5.22 / 0.5.23 / 0.5.24 的三张表。

| 轮次 | 发布 | 轨道 | 试了多少处破坏 | 既有测试当场杀掉 | 存活（盲区） | 补用例后杀掉 |
|---|---|---|---|---|---|---|
| 第一轮 | 0.5.22 | 纯函数层 `src/lib.ts` | 64 | 31 | **30** | 30（lib 176 → 206） |
| | | 宿主 `src/index.ts` | 100 | 50 | **50** | 8（host 131 → 139） |
| 第二轮 | 0.5.23 | 检索 + 自画像（lib） | 38 | 15 | **23** | 23（lib 206 → 228） |
| | | `/sleep` + 审计端到端（host） | 30 | 18 | **12** | 10（host 139 → 149） |
| 第三轮 | 0.5.24 | 纯函数层（lib） | 40 | 16 | **23** | 23（lib 228 → 243） |
| | | 宿主（host） | 41 | 40 | **1** | 10 条新用例（host 149 → 159） |

逐轮相加：**试 313 处破坏，170 处当场被既有测试杀死，139 处存活**（个别条目在各轮表格里未单列，
本页照表引用、不做加总修正）。其中 **5 处被登记为「不可达 / 等价」而不是硬凑用例**——第一轮宿主 2 处、
第二轮宿主 2 处、第三轮宿主 1 处；理由写在 `tests/host.test.ts` 的注释里（例如：工作区级补录候选在契约下不可能存在；
进入 `writeMemory` 的候选已过两道同源指纹闸门，简化计数器在可达输入上不可观察），`CHANGELOG.md` 0.5.22 §「Two
survivors…」、0.5.23 §「Two survivors documented…」、0.5.24「One survivor is documented…」各有一节说明。
`tools/mutate.ts`（0.5.24）把这套方法固化成常驻工具，并在第一次运行时又找到 **2 个真实盲区**：
`pickMergeGroups` 的硬编码 `0.85` 兜底与 `DEFAULTS.mergeSimilarity`（0.7）不一致；以及**没有任何测试断言
`Config` schema 的默认值**——两者都已闭环（后者升级为「每个键的默认值必须等于 `DEFAULTS`」+ 键数钉死的系统性检查）。

### 6.3 五路对抗性审计与三个 🔴

0.5.21 的修复来自一次**独立对抗性审计**：五个代理被要求**证伪**这个插件而不是确认它，各从一个角度出发——
① 契约与实现的出入、② 主动破坏性探针、③ 发布面与隐私、④ 只读文档的使用者、⑤ 对测试套件本身做变异测试。
`CHANGELOG.md` 列出了三条真问题（**它没有逐条标注是哪一路发现的**，本页也不替它归属）：

| # | 问题（🔴） | 机制 | 怎么被发现 / 修复后的防线 |
|---|---|---|---|
| 1 | **安全绕过：`memory_explain({ apply: true })` 绕过写入审批门，并伪造来源** | `writePolicy: 'off'` 下 `memory_write` 被正确拒绝，但同样一段文本走 `memory_explain` 却能落库为 `origin: 'user_explicit'`，并进入上下文。根因：把「来源」交给**模型可控的捕获信号**决定 | 由对照两条工具路径在 `writePolicy: 'off'` 下的行为发现。修复：两条工具路径都用 `deriveOriginFromMessages`（外加显式 `trustToolWrites` 覆盖）推导来源，于是拒绝、PII 脱敏、回声判定、待确认队列与 `persisted` 在两条路径上完全一致。回归用例 `tests/host.test.ts` host#117（标注「审计 critical」），它先复现泄漏前提再钉住修复后行为 |
| 2 | **拒绝服务：`maskPii` 在超长字符序列上是二次方复杂度** | 一次 **200 KB** 的 `memory_write` 把单线程宿主**阻塞了 12.6 秒**（灾难性回溯） | 审计记录下来的证据就是这次测量本身（`CHANGELOG.md` 0.5.21「Security」第 3 条）；修复去掉了病态回溯 |
| 3 | **明文密钥进提示：零宽字符骗过密钥扫描，注入时又被剥掉** | `scanSensitive` 接受了 `sk-\u200babcdef…`（被拆写的密钥），而 `clampText` 在注入前会把零宽 / bidi 字符整体删除——于是插件**自己把明文密钥还原进了系统提示** | 审计给出的机制就是「两个视图不一致」：判定走 NFKC 视图（不删零宽），渲染走 `clampText`（删零宽）。修复：判定与脱敏都改在**渲染等价视图**上做（NFKC 宽度折叠 + 剥离 `\p{Cf}` + 控制字符折空格），即「判定看到的就是渲染后剩下的」。回归用例 `tests/lib.test.ts`「零宽与格式字符不能绕过判定」（含 `\u2060` / `\uFEFF` / `\u202E` / `\u00AD` 等同类写法），并把泄漏前提本身也钉住 |

同一轮还顺带修了三类「说了假话」的行为（不是 🔴，但同样重要）：治理命令（`approve` / `pin` / `archive` /
`confirm` / `refresh` / `reject-pending`）在 `persist()` 失败时曾**谎报成功**，现在如实回答「未落盘，重启后会回退」；
`ask` 模式的同指纹去重（不再出现两条同 hash 的 active 行）；以及非有限数（NaN / Infinity / 0 / 负数）的
`maxInjectedTokens` / `charsPerToken` 曾让注入预算整体失效，现在按默认值 fail-closed。

## 7. 已知限制（诚实清单）

| 限制 | 具体到什么程度 | 依据 |
|---|---|---|
| 检索是词面的，语义是可选项 | 默认路径是中文 bigram + 拉丁词形归并 + IDF + 长度归一化的**词面**检索；只有宿主**显式注入** `embed` 并打开 `embedderRecallMode` 才可能按语义/混合打分 | README「Known limitations」；`docs/embedder.md` §0 |
| 命令输出只有中文 | `language` 只切**模型可见**文本（注入块、提示、R2、7 个工具描述）；`/memory …`、`/sleep`、`stats` 等命令输出一律中文，本轮范围外 | `docs/i18n.md` §1/§4；README 的语言覆盖表 |
| 向量缓存不跨重启 | 向量缓存是进程内 LRU（`embedderCacheMax`，默认 2000）；`stats().embedder` 的计数与 `stats().writes` 一样**只增不减、重启归零** | `src/index.ts` 的向量缓存与嵌入器计数器注释；协议 §3.2 |
| `list()` / `recall()` 默认是**未过滤的原始视图** | 无参 `list()` 返回插入序的全部状态（含 `pending` / `invalid` / `archived`）的**活对象**；无参 `recall()` 也只看它自己的池。想要「模型实际看到什么」必须显式传 `status: 'active'`（以及 `branch: 'current'`） | 协议 §3.1/§3.3；`CHANGELOG.md` 0.5.17/0.5.18 |
| `ok: true` 不等于「已落盘」 | 它只表示「过了闸门并在**内存**里生效」；持久化看 `write()` 结果的 `persisted`（v1.1）或 `stats().opened` / `stats().writes` | 协议 §3.4 |
| 审计的「尝试」视图不持久 | `/memory audit` 的内存尝试环容量由 `auditMax`（默认 50）决定，**重启即失**；只有记录派生部分是持久的 | `docs/audit.md` §1 |
| 压缩固化取决于部署 | 代码监听 `compaction/summary`；没挂载压缩插件的 profile 根本不会产生该事件 | README「Known limitations」 |
| 跨会话全文检索通常不可用 | 会话查询索引出厂是 `openAt: never`，所以插件自建词面索引，历史回指只用精确读取 | README「Known limitations」 |
| 没有图形化的记忆浏览 | 界面只做配置；浏览 / 删除 / 固定走命令与 7 个工具（GUI 不提供记忆浏览器） | README「Known limitations」 |
| 两项显式降级 | ① 自画像不与部署的 persona 文本去重；② 部署注册了会挤掉其它 prompt 段的 `complete` 段时，自画像段随之消失，插件**不会**自动改走 `context()` 通道 | README「Known limitations」 |
| 端到端增益未自动化 | 离线评测只测召回链路本身；「有记忆 vs 全上下文」的 Δ 是文档化的**手工**流程 | README「Known limitations」 |
| 注入远端嵌入器会把正文送出本机 | 插件自己**不联网、不带模型**；它只把记忆正文交给被注入的 `embed`。远端 embedder ⇒ 正文离开本机——这个决定与后果属于宿主 / 用户 | `SECURITY.md`；协议 §11 隐私段 |
| 导入文件要可信 | `/memory import` 会逐字段校验并把来源降级为 `observed`、强制 `pinned: false`，但它读的是你给的路径 | `SECURITY.md`；README 命令表 |

## 8. 发布历史（0.5.9 → 0.5.24）

版本号只按 **patch** 递增（`0.5.x → 0.5.x+1`），纯文档提交不升版本；协议版本与包版本相互独立。
起点之前：`0.4.2` 是首个公开提交（宿主半边、双通道注入、7 工具、16 条 `/memory` 命令、34 个单测），
`0.5.0` 整体改写为 TypeScript 并提交 `lib/`。

| 版本 | 一句话主题 |
|---|---|
| 0.5.9 | 可核验引用：每条记忆都能说出自己来自哪次会话、哪段事件序号 |
| 0.5.10 | 可选写入审批门：模型只提议（`ask` 排队 / `off` 拒绝），你决定 |
| 0.5.11 | 模型可见文本多语言：模型看英文、终端看中文 |
| 0.5.12 | 修 0.5.11：默认预算下英文自画像整段渲染不出来的问题 |
| 0.5.13 | 分支感知的项目记忆：特性分支上的约定留在那条分支上 |
| 0.5.14 | 写入审计与注入核对：`/memory audit` + `--verify`（缺口明说，不报假通过） |
| 0.5.15 | 工程加固：`lint` / `check:readmes` / `verify:self-contained` / 覆盖率门槛进 CI |
| 0.5.16 | 工具输出带出处：`memory_recall` / `memory_list` 的每条命中带 `refs` |
| 0.5.17 | 来源反查 `/memory trace` + 零依赖检索质量升级 + `ctx.memory` 冻结为协议 v1 |
| 0.5.18 | 协议 v1.1：`list` 的三个过滤项、`write` 的 `persisted`，整份 `docs/` 进发布包 |
| 0.5.19 | 协议 v1.2：`branch` 数组、`stats().writes`、`write` 结果带 `refs`，并给发布物加隐私自动扫描 |
| 0.5.20 | 协议 v1.3：宿主可注入外接嵌入器（插件仍不联网、不带模型） |
| 0.5.21 | 独立对抗性审计的修复：安全绕过 / 12.6 秒 DoS / 明文密钥进提示 |
| 0.5.22 | 变异测试驱动的测试加固（第一轮）：64 + 100 处破坏，80 处盲区 |
| 0.5.23 | 变异测试第二轮：专打上一轮刻意跳过的大函数（38 + 30 处破坏，35 处盲区） |
| 0.5.24 | `pnpm mutate` 工具化 + 发布检查清单 + 变异第三轮（40 + 41 处破坏）；套件 467 → **498** |

## 9. 去哪看细节

| 你想知道 | 看这里 |
|---|---|
| 用户怎么用（命令、工具、配置项、隐私） | [`README.md`](../README.md)（英文）/ [`README.zh.md`](../README.zh.md)（中文，结构逐项对齐） |
| 第三方怎么依赖服务面（签名、形状、错误码、三条载荷级约定） | [`docs/protocol-v1.md`](protocol-v1.md)（英文）/ [`docs/protocol-v1.zh.md`](protocol-v1.zh.md)（中文） |
| 每一版到底改了什么 | [`CHANGELOG.md`](../CHANGELOG.md) |
| 怎么发一版（顺序、推送失败的三种真相、变异体检怎么读） | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| 安全边界与威胁模型 | [`SECURITY.md`](../SECURITY.md) |
| 各能力的接口契约 | `docs/refs.md`、`docs/write-policy.md`、`docs/i18n.md`、`docs/branch.md`、`docs/audit.md`、`docs/trace.md`、`docs/semantic.md`、`docs/sleep.md`、`docs/self-portrait.md`、`docs/embedder.md`、`docs/protocol-v1.1-changes.md`、`docs/protocol-v1.2-changes.md` |
| 这个插件建立在哪些 DSH 机制上（面向插件作者） | [`docs/dsh-mechanisms.md`](dsh-mechanisms.md) |
