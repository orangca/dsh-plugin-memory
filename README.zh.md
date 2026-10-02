# dsh-plugin-memory

DSH（DeepSeek Harness）的**个性化长期记忆**插件：本地优先、自动捕获、双通道注入、
可解释可删除。

中文 | [English](README.md)

- **本地**：全部数据落在 `$DSH_HOME/storages/<domainName>/`，无网络请求、无 embedding 服务。
- **自动**：回合收尾时用规则从**真实用户消息**里抽取该记的事，零额外模型调用。
- **有预算**：每次注入有硬 token 上限，超出按优先级截断。
- **可解释**：每条记忆带来源（会话 + seq 区间）、置信度与时间线。
- **可删除**：单条删除、一键清空、整库导出；删除后同进程内立即不再注入。

---

## 记忆分四层

| 层 | 内容 | 作用域 | 注入 |
|---|---|---|---|
| 用户画像 | 用户偏好、环境、禁忌 | profile | 常驻（user-role 快照） |
| Agent 自画像 | **我是谁、我怎么说话、我怎么工作**：人格 + 工作倾向两小节 | profile | 常驻（system prompt 段） |
| 项目模糊印象 | 对某个工作区的粗颗粒印象（技术栈 / 构建 / 目录） | workspace | 常驻，且显式标注「模糊且可能过时」 |
| 情景 / 语义 / 程序性 | 结论、事实、做法 | workspace | 按需召回 |

## 三条路径

1. **写入**：回合收尾规则抽取（默认路径，零模型调用）+ 模型调用 `memory_write`。
   硬秘密（API key / 私钥 / 密码 / 身份证 / 银行卡）**一律拒写**，且没有 force 通道；
   邮箱与手机号按 `piiPolicy` **脱敏后写入**（`a***@b.com` / `138****5678`）。
   同一件事在**新的会话**里再次被提到时自动提升重要度（`repeatMentionBoost`），不新增重复条目。
2. **召回**：
   - **R1 常驻**：画像、自画像、当前工作区的项目印象；
   - **R2 按轮**：用本轮用户消息做记忆侧命中匹配，只注入真的相关的条目，同一 id 有冷却轮次。
3. **整合**：默认每 30 分钟一次 + 启动补跑。合并重复、把矛盾条目标记为失效（可恢复）、
   按类型半衰期衰减归档、对单一主题过多的条目做规则式摘要。

## 自画像：人格 + 工作倾向

自画像（`agent_self`）是**模型对自身的认知**，常驻注入 system prompt，分两小节：

| 小节 | 内容 | subject |
|---|---|---|
| 人格 | 我是谁、我怎么说话、我重视什么 | `self.persona.*` |
| 工作倾向 | 我擅长与不擅长什么、用户定下的规矩、用户纠正、模型自评 | `self.work.*` |

- **机会式更新**：模型在对话与工作中主动写 —— `memory_write` 的 `kind: 'agent_self'` 可带 `facet`
  （`'persona'` / `'work'`，缺省 `'work'`，仅对该 kind 有意义）；用户也可以用 `/memory self set` 直接设定。
- **低频反思提示**：每隔 `selfReflectEveryTurns` 个回合（默认 12）注入一句反思提示（提示里写明
  「没有新认识就不要写」），每会话至多 `selfReflectMaxPerSession` 次（默认 3），且本会话至少进行到
  `selfReflectMinTurn` 回合（默认 4）才可能出现。可用 `selfReflectEnabled` 整体关掉；
  `recallMode` 为 `dry`/`off` 时不注入（与按轮召回一致）。
- **演化，而不是只增不减**：同一主题的新认知与旧条目相似度 ≥ `selfPortraitMergeThreshold`（默认 0.6）时
  合并改写；低于阈值则视为改主意 —— 旧条目**归档留痕**（`status: 'archived'`，并带 `supersededBy` 指向
  新条目），修订链可用 `/memory self history` 查看。
- **用户所有物保护**：用户设定/确认过的条目（`origin: 'user_explicit'` 或 `pinned: true`）**模型不可覆盖**，
  只能由用户侧的写入取代。
- **优先级**：自画像只是**描述**、不是指令 —— 与用户当场的要求冲突时，**一律以用户为准**。

```
/memory self                             列出人格与工作两小节（各条带 id、来源、置信度）
/memory self set <persona|work> <正文>    用户直接设定/覆盖（记为用户侧、固定、置信度 1）
/memory self history [subject]            修订链：由旧到新（含归档时间）
/memory self reset [persona|work]         归档当前自画像（保留历史，不删除）
```

## 防「记忆污染 / 自激」

- 自动捕获**只读真实用户消息**（插件自己注入的上下文不算）；
- 模型自评若只是复述刚注入的内容，会被**回声剔除**；
- 模型自评要进 system prompt 通道，必须**跨 ≥2 个不同会话复现**，且自评配额 ≤4/12 条；
- **非用户侧来源永远不能推翻用户侧条目**（冲突时用户胜）；
- 自画像的收敛改写对用户侧条目无效：模型**不能**覆盖 `user_explicit` / `pinned` 的自画像，只能改写自己写的；
- 用户侧来源不衰减，只能由用户撤销。

---

## 环境要求

- DSH Desktop 或带 profile 的 `dsh` CLI（本插件以**组合包 / bundle** 形式安装，贡献一个 patch 层）。
- **安装方不需要任何额外条件**：包里已带构建好的 `lib/`，`dsh plugin add` 不跑构建，也不需要 `allowBuilds` 授权。
- **参与开发**需要 Node.js ≥ 22.18（原生剥离 TypeScript 类型；更早的 22.x 需加 `--experimental-strip-types`）
  以及 pnpm（版本见 `packageManager`）。

## 安装

```sh
# 从 tarball 安装（发布产物推荐这种方式）
dsh plugin --profile desktop add ./dsh-plugin-memory-<version>.tgz

# 直接从 GitHub 安装（本包无需构建，因此不需要 prepare 授权）
dsh plugin --profile desktop add github:orangca/dsh-plugin-memory

# 发布到 npm 后
dsh plugin --profile desktop add dsh-plugin-memory
```

卸载（**不会**删除记忆数据）：

```sh
dsh plugin --profile desktop remove dsh-plugin-memory
```

要清空数据，用 `/memory clear --all --yes`，或手动删除 `$DSH_HOME/storages/<domainName>/`。

### 手工安装（不用插件管理器）

把本包加进 profile 的 `dependencies`，把 `dsh-plugin-memory` 追加到 `dsh.profile.bundles`；
（可选）再加一行 user 级行，让设置界面出现本插件的表单：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: dsh-memory
  config:
    domainName: dsh_memory
```

## 配置表单在哪

插件导出 schemastery `Config`，其中 17 个可调字段声明为 `volatile()`；同时附带一个小的浏览器半边
（`src/client.ts`，构建为 `lib/client.js`）把它们渲染成表单。位置：**「插件」页 → `dsh-plugin-memory` → 行 `dsh-memory`**
（列表里的行卡片上还有一行摘要）。

实现上，客户端半边注册进 **keyed** 插槽 `plugins.row.config`，key 为
`'dsh-plugin-memory#dsh-memory'`，并复用 DSH 共享的 `SettingsFormModel` / `SettingsForm`。
保存时会经 settings 服务校验整个 Config 并写入 profile patch，**无需重启**。

## 用户命令

```
/memory list [--kind=agent_self] [--archived]   列出记忆（归档条目需 --archived）
/memory search <关键词>                          词面检索（含归档，不含已失效）
/memory show <id 前缀>                           查看完整记录（含来源与时间线）
/memory forget <id 前缀>                         永久删除一条
/memory restore <id 前缀>                        恢复被失效/归档的条目（并撤销推翻它的条目）
/memory pin <id 前缀>                            固定（不衰减、不自动归档）
/memory archive <id 前缀>                        归档（不常驻注入，仍可检索）
/memory refresh <id 前缀>                        刷新（衰减重新计时）
/memory confirm <id 前缀>                        把模型自评升级为用户确认
/memory reject <id 前缀>                         拒绝一条自我观察（同类不再产生）
/memory self                                     自画像：列出人格与工作两小节
/memory self set <persona|work> <正文>            直接设定/覆盖自画像（用户侧、固定、置信度 1）
/memory self history [subject]                   自画像修订链（旧 → 新，含归档时间）
/memory self reset [persona|work]                归档当前自画像（保留历史，不删除）
/memory export [path]                            导出 JSON
/memory import <path>                            导入 JSON（按指纹去重；逐字段校验、数值夹取、`pinned` 强制关闭、来源一律降级为 `observed`）
/memory clear --all --yes                        永久清空全部（`--all` 与下面的筛选条件互斥）
/memory clear --kind=<kind> --scope=<level> --yes   清空子集；条件之间是 AND，取值按枚举校验
/memory consolidate                              立即整理一次
/memory stats                                    运行时可观测：计数、写入、渲染耗时、注入行数
/memory help
```

## 模型工具

| 工具 | 用途 |
|---|---|
| `memory_write` | 结构化写入（`kind` + `text`，可选 `subject` / `field` / `value` / `scopeLevel`；`kind='agent_self'` 时可选 `facet: 'persona' | 'work'`）。**写入来源由插件判定，模型不能自称「用户要求的」** |
| `memory_recall` | 按查询 / 类型 / 作用域 / 标签检索 |
| `memory_list` | 按确定性顺序列出 |
| `memory_forget` | 按 id 删除；按 query 删除需 `confirm: true`（预览阈值更严） |
| `memory_maintain` | 手动触发整合（合并 / 失效 / 归档 / 摘要） |
| `memory_stats` | 运行时可观测：条数、写入 / 拒绝计数、注入行数、渲染耗时 |
| `memory_explain` | 诊断：一段文本会命中哪条信号、被哪条规则排除、会写成什么（自画像条目额外显示 `facet` 与 `supersededBy`） |

## 配置

在 patch 行里设置 `config`；完整默认值见 `src/lib.ts` 的 `DEFAULTS`。表单里可改的 17 个字段：

| 字段 | 默认 | 含义 |
|---|---|---|
| `domainName` | `dsh_memory` | 领域名（兼作落盘目录名） |
| `maxInjectedTokens` | `300` | 常驻注入的硬 token 上限 |
| `maxItemTokens` | `60` | 单条记忆注入长度上限 |
| `selfPortraitMaxTokens` | `120` | 工作两小节共享的自画像段预算 |
| `selfPortraitEnabled` | `true` | 自画像（人格 + 工作两小节）常驻注入的开关；表单里 `0`=关、`1`=开 |
| `selfPersonaMaxTokens` | `80` | 人格小节的独立预算 |
| `selfPortraitMergeThreshold` | `0.6` | 新认知与旧条目合并改写的相似度阈值（低于则归档旧条目并由新条目取代） |
| `selfReflectEnabled` | `true` | 低频反思提示开关；表单里 `0`=关、`1`=开 |
| `selfReflectEveryTurns` | `12` | 两次反思提示之间的最小回合间隔 |
| `selfReflectMinTurn` | `4` | 本会话最小回合数（太早没有素材） |
| `selfReflectMaxPerSession` | `3` | 每会话最多提醒几次 |
| `recallMode` | `inject` | `off` / `dry`（只算不注入）/ `inject` |
| `recallTopK` | `8` | 每轮最多召回几条 |
| `captureMode` | `rule` | `off` / `rule` |
| `captureMaxPerTurn` | `3` | 每回合最多自动写入几条 |
| `consolidateEnabled` | `true` | 定时整合开关 |
| `consolidateIntervalMinutes` | `30` | 整合间隔 |

只能通过 patch 行设置的进阶旋钮（含默认值）：自画像条数 `selfPortraitMaxItems` 12 /
`selfPortraitMaxSelfObserved` 4；捕获调优 `capturePerHour` 20、`captureMinConfidence` 0.6、
`echoThreshold` 0.9、`gistMinMarkers` 2；自评准入 `selfPortraitPromoteSessions` 2、
`selfPortraitModelMinConfidence` 0.85；整合 `mergeSimilarity` 0.7、`archiveAfterDays` 180、
`archiveBelowImportance` 0.15、`summarizeAbove` 5；召回细节 `recallMinQueryChars` 12、`recallMinHits` 2、
`recallMinMatch` 0.4、`recallCooldownTurns` 3、`recallBudgetMs` 10；隐私 `piiPolicy` `mask`；
`repeatMentionBoost` 0.1；`reportPath`（开发期自报告 JSON）；`seed`（仅开发期示例数据，**出厂关闭**）。

## 数据与隐私

```
$DSH_HOME/storages/dsh_memory/
├── global.json            # 水位：schema 版本、collectionVersion、最后整合时间
└── memories/<id>.json     # 一条记忆一个文件，形状 { version, record }
```

- 存储根是 **home 级**：同一台机器上的所有 profile 默认共用一份记忆库——对「个人记忆」通常正是想要的。
- 数据不出本机：无遥测、无 embedding 服务、不上传任何历史。
- 敏感内容在落盘前就被拒写，个人信息脱敏后写入；两种行为都有单测覆盖。
- DSH 不会自动迁移领域版本：升级 `version` 必须同时声明 `compatibleVersions`。

## 开发

TypeScript 编写、`tsc` 构建、pnpm 管理。开发工具也是 TypeScript —— Node 22.6+（24 默认开启）原生剥离类型，
所以 `node tools/<name>.ts` 直接可跑，工具链不需要构建步骤。

```sh
pnpm install                                      # 只装开发依赖：typescript、@types/node、schemastery 类型
pnpm build                                        # src/*.ts → lib/*.js（并给客户端半边套上 lazy-CJS 包装）
pnpm test                                         # 先构建，再对构建产物跑单测
pnpm typecheck                                    # 宿主半边、客户端半边、工具，分别检查，不产出文件
node tools/eval-recall.ts                         # 离线召回评测（读真实会话日志）
node tools/bench.ts                               # 热路径基准（每回合召回、每 step 渲染、整合）
node tools/deploy-dev.ts                          # 把 lib/ 挂成新的开发修订版（需先 pnpm build）
node tools/deploy-dev.ts --set "recallMode='dry';maxInjectedTokens=200"
node tools/extract-asar.ts                        # 提取 DSH 客户端产物（排查界面问题）
node tools/scan-asar.ts settingsNumberField       # 定位某个符号在 app.asar 里的位置
```

目录职责：

| 路径 | 作用 |
|---|---|
| `src/index.ts` | 宿主半边：存储、捕获、注入、整合、工具、命令 |
| `src/lib.ts` | 纯函数层（不依赖 `ctx`）——单测的全部对象 |
| `src/client.ts` | 浏览器半边：设置表单（编成 CommonJS 后再被包装） |
| `src/types.ts`、`src/shims.d.ts` | 领域类型 + 本插件实际依赖的 DSH 接缝子集 |
| `lib/` | 构建产物：**刻意提交进仓库**（见下），并通过 `files` 进发布包 |
| `tools/build-client.ts` | 把编译后的客户端包成 `window.__ModuleLoader__.load({ id, factory })` |
| `tools/deploy-dev.ts` | 把 `lib/` 复制成一个新的开发修订版并改写 profile patch |

为什么把构建产物也提交：`dsh plugin add github:<owner>/<repo>` 拉的是**源码而不是产物**，也**不会**跑构建脚本。
如果 `lib/` 被 git 忽略，GitHub 安装下来的包 `main` 会指向不存在的文件。提交它可以让安装保持「零构建步骤」——
既不需要 `prepare`，也就不需要用户为构建脚本授予 `allowBuilds`（那等于允许代码在安装时于本机执行）。

三条用真实调试时间换来的经验：

- **条目要能在 profile patch 里被定位**，settings 服务才会为它投影表单；只存在于 bundle 层的行可能不出现。
- `deploy-dev.ts` **永不重用修订号**：Node 的 ESM 缓存按解析后的真实路径命中，复用路径会拿到缓存里的旧模块。
- **npm 上的 `@deepseek-ai/*` 包比你正在运行的 DSH 旧**——发布版 `dsh-client-ui-primitives` 甚至不导出 settings API。
  因此按 `src/types.ts` / `src/shims.d.ts` 里**实测验证过的子集**打类型，而不是导入不匹配的发布版类型。

本插件依赖的 DSH 接缝、插槽语义与环境事实，见 [`docs/dsh-mechanisms.md`](docs/dsh-mechanisms.md)
（面向插件作者，不含任何环境特定信息）。

## 已知限制

- **压缩固化取决于部署**：代码监听 `compaction/summary`；没有挂载压缩插件的 profile 不会产生该事件。
- **跨会话全文检索通常不可用**：会话查询索引出厂是 `openAt: never`，因此本插件自建词面索引，
  历史回指只用精确读取。
- **检索是词面匹配**：CJK bigram + 拉丁词干 + 记忆侧覆盖率；同义改写级别的召回需要向量检索，属后续工作。
- **没有图形化的记忆浏览**：界面只提供配置；浏览、删除、固定记忆走上面列出的 `/memory` 命令与 7 个模型工具。
- **两项设计显式降级**：① 自画像不与部署的 persona 文本去重；② 若部署注册了会把其它 prompt 段挤掉的
  `complete` 段，自画像段会随之消失，插件**不会**自动改走 `context()` 通道。
- **端到端增益（有记忆 vs 全上下文）未自动化**：离线评测只测召回链路本身；Δ 是文档化的手工流程
  （同一组问题分别用 `recallMode: 'off'`、本插件、以及把全部历史贴进对话来作答，再比较准确率与 token 成本）。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
