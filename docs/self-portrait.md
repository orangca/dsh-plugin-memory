# 自画像 v2 —— 设计契约（M6）

> 这份文档是**并行实现的接口契约**：`src/lib.ts`（纯函数）、`src/index.ts`（宿主）、
> `src/client.ts`（设置页）三边各自照它实现，签名与行为不得擅自改动；需要改就先改这里。

## 1. 为什么要改

0.5.x 的 `agent_self` 是**规范型**的：记录的是「用户确认过的工作约定」+「模型自评的工作习惯」，
门控靠置信度与会话复现，呈现只有「我的工作约定」与「自我观察」两块。

用户要的是**自我认知型**（RP 式）：自画像是模型对「我是谁、我怎么说话、我重视什么、
我擅长与不擅长什么」的认知，并且要**通过与用户对话和实际工作不断改进**——
不是只增不减地堆积，而是允许收敛改写（旧认知归档留痕）。

产品决策（2026-10-02 与用户确认）：

| 决策 | 选择 |
|---|---|
| 内容 | **人格 + 工作倾向两小节** |
| 改进方式 | **机会式（模型主动写）+ 低频反思提示（插件按回合数注入一句）** |
| 冲突语义 | **允许收敛改写，保留修订历史**（旧条目归档 + `supersededBy` 指向新条目） |

## 2. 数据模型

### 2.1 记录字段（`MemoryRecord` 新增，均可选、向后兼容）

```ts
export type SelfFacet = 'persona' | 'work'

interface MemoryRecord {
  // …既有字段不动
  /** 仅 agent_self 使用；缺失时按 'work' 处理（0.5.x 的存量条目都是工作约定）。 */
  facet?: SelfFacet
  /** 被本条取代的旧自画像条目 id（旧条目 status='archived' 且 supersededBy=新条目 id）。 */
  supersedes?: string[]
  /** 本条被谁取代（归档时写入）。 */
  supersededBy?: string
}
```

- **不新增存储表、不改动既有字段语义**：`domain.table('memories')` 原样存这两个可选字段。
- 归档复用既有 `status: 'archived'`（归档只影响常驻注入，仍可被检索/查看历史）。

### 2.2 subject 约定

| facet | subject 前缀 | 例 |
|---|---|---|
| persona | `self.persona.` | `self.persona.voice`（语气）、`self.persona.values`、`self.persona.identity` |
| work | `self.work.` | `self.work.style`、`self.work.strengths`、`self.work.weaknesses` |

`portraitSubjectFor(facet, key)` 负责拼装并做小写/白名单校验（key 只允许 `[a-z0-9_]`，非法则回退 `'general'`）。

## 3. `src/lib.ts` 的新增导出（签名冻结）

```ts
export type SelfFacet = 'persona' | 'work'

/** 解析任意输入为 facet；无法识别时返回 fallback（默认 'work'）。 */
export function normalizeFacet(value: unknown, fallback?: SelfFacet): SelfFacet

/** 记录的 facet：agent_self 且无 facet 字段 → 'work'（存量兼容）。 */
export function facetOf(record: MemoryRecord): SelfFacet

/** 'self.persona.voice' 这种规范 subject。 */
export function portraitSubjectFor(facet: SelfFacet, key: string): string

export interface PortraitCandidate {
  text: string
  facet: SelfFacet
  subject: string
  origin: MemoryOrigin
  confidence: number
  observedAt?: number
}

export type PortraitAction = 'add' | 'reinforce' | 'refine' | 'supersede' | 'skip'

export interface PortraitDecision {
  action: PortraitAction
  /** 被 reinforce/refine/supersede 命中的既有条目 id；add/skip 时为 null。 */
  targetId: string | null
  /** 最终要写入的正文（reinforce 取更长的一条，refine 合并）。 */
  text: string
  /** 最终置信度。 */
  confidence: number
  /** 可读原因，写进工具返回值与 stats（如 'same-subject-user-owned'）。 */
  reason: string
  /** supersede 时是否把 target 归档（并写 supersededBy）。 */
  archiveTarget: boolean
}

/**
 * 自画像收敛决策：**纯函数、确定性**。
 * 规则（按顺序判定）：
 *  1. 正文去空白后 < 8 字符 → skip / 'too-short'
 *  2. 同 subject + 同 facet 的 active 条目里：
 *     a. 指纹相同或一方包含另一方 → reinforce（取更长文本；confidence +0.05 上限 1；reason 'reinforced'）
 *     b. 相似度 ≥ cfg.selfPortraitMergeThreshold（默认 0.6）→ refine（合并文本；confidence 取较大者；reason 'refined'）
 *     c. 否则 → 认知变化 → supersede（archiveTarget=true；reason 'superseded'）
 *  3. 无同 subject 条目 → add
 *  4. **用户所有物保护**：target 的 origin 是 user_explicit/user_correction 或 pinned=true 时，
 *     候选必须**同样来自用户侧**（user_explicit/user_correction）才允许 refine/supersede；
 *     否则：
 *       · `refine` / `supersede` → skip / 'user-owned'
 *       · `reinforce` → **仅当双方归一化文本完全相同**时才允许（只累加置信度与 reinforcement，
 *         绝不改写正文）；只要候选文本与 target 不同（哪怕只是"包含"）→ skip / 'user-owned'
 *     ⚠ 为什么 reinforce 也要管：reinforce 在"一方包含另一方"时取更长的一条，模型只要写一句
 *     包含 pinned 条目全部 token 的长句，就能把自己的话写进用户设定的条目——这违反第 6 节的意图
 *     （实测复现过，见 progress.md 第十八轮）。
 */
export function planPortraitUpdate(
  candidate: PortraitCandidate,
  existing: Iterable<MemoryRecord>,
  cfg: MemoryConfig,
): PortraitDecision

export interface PortraitRevision {
  subject: string
  facet: SelfFacet
  /** 由旧到新。 */
  chain: MemoryRecord[]
}

/** 修订链：把 archived 的旧条目按 supersededBy/supersedes 串起来（按 observedAt 升序）。 */
export function portraitHistory(records: Iterable<MemoryRecord>): PortraitRevision[]

export interface ReflectInput {
  /** 当前回合号。 */
  turn: number
  /** 本会话上一次反思提醒的回合号；从未提醒过为 null。 */
  lastReflectTurn: number | null
  /** 本会话已提醒次数。 */
  reflectionsThisSession: number
  /** 本会话已进行的回合数。 */
  sessionTurns: number
}

/** 反思提醒闸门（纯函数）：enabled=false / 已达每会话上限 / 未到最小回合 / 未到间隔 → false。 */
export function shouldReflect(input: ReflectInput, cfg: MemoryConfig): boolean

/** 自画像块的固定文案（宿主与测试都用它，避免字符串散落）。 */
export const PERSONA_HEADER: string
export const PERSONA_FOOTER: string
export const WORK_CONFIRMED_HEADER: string   // 既有 '[我的工作约定 · 来自用户确认]'
export const WORK_OBSERVED_HEADER: string    // 既有 '[自我观察 · 未经用户确认]'
export const WORK_OBSERVED_FOOTER: string
export const REFLECT_NOTICE: string          // 反思提示正文（约 60–90 token）

/**
 * 渲染：**人格小节在前，工作两节在后**（工作节沿用既有文案，保持向后兼容）。
 * 预算：persona 用 cfg.selfPersonaMaxTokens，工作两节共享 cfg.selfPortraitMaxTokens（用户侧优先）。
 * 人格小节内部：用户侧条目优先，模型自评其次（各自受 cfg.selfPortraitMaxSelfObserved 约束）。
 */
export function renderSelfBlock(records: Iterable<MemoryRecord>, cfg: MemoryConfig): RenderedBlock
```

### 3.1 `MemoryConfig` 新增（默认值写在 `DEFAULTS`）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `selfPortraitEnabled` | boolean | `true` | 自画像三小节的开关 |
| `selfPersonaMaxTokens` | number | `80` | 人格小节预算 |
| `selfPortraitMergeThreshold` | number | `0.6` | refine 的相似度阈值 |
| `selfReflectEnabled` | boolean | `true` | 低频反思提示开关 |
| `selfReflectEveryTurns` | number | `12` | 两次提醒之间的最小回合间隔 |
| `selfReflectMinTurn` | number | `4` | 本会话最小回合数（太早没素材） |
| `selfReflectMaxPerSession` | number | `3` | 每会话最多提醒几次 |

`src/types.ts` 的 `MemoryConfig` 接口同步这 7 个键。

### 3.2 已采纳的实现口径（实现者提问后定案，2026-10-02）

| 议题 | 定案 |
|---|---|
| `reinforce` 的置信度基线 | `min(1, max(候选, target) + 0.05)` —— 不能用候选基线，否则 0.9 的条目会被 0.6 的候选降级 |
| `refine` 的文本合并 | 一方包含另一方 → 取长的；否则 `长；短`（确定性） |
| `skip` 的 `targetId` | 一律 `null`（含 `'user-owned'`） |
| 「指纹相同」的判定 | 归一化文本相等（候选没有 scope，算不出 `recordHash`） |
| 同 subject 多条时的选择 | 指纹 > 包含 > 相似度 > `compareRecords`，取第一条（与入参顺序无关，已测） |
| `portraitHistory` 的返回范围 | **只返回链长 ≥ 2 的组**；单条不算「修订历史」，由 `/memory self` 列当前条目 |
| `shouldReflect` 的最小回合闸门 | 看 `sessionTurns`（本会话回合数）；间隔闸门看 `turn - lastReflectTurn`；`sessionTurns` 非有限时退化为 `turn` |
| `renderSelfBlock` 与开关 | 额外遵守 `selfPortraitEnabled === false` → 返回空块（lib 侧兜底，不只靠宿主） |
| 人格小节内部的配额 | 用户侧与模型自评**各自**受 `selfPortraitMaxSelfObserved` 约束 |
| `recordHash` 是否纳入 facet | **不纳入**（避免改变存量指纹、导致去重失效） |
| 布尔配置键的写回类型 | 界面 `0/1`，spec 必须写**真布尔**（见第 5 节的原因） |

## 4. `src/index.ts` 的宿主行为

1. **写入路径**：`memory_write` 工具与 `/memory self set` 在 `kind === 'agent_self'` 时接受可选 `facet`
   （`'persona' | 'work'`，缺省 `'work'`）；写入前调 `planPortraitUpdate`，按决策执行：
   - `add`：正常新建（`subject` 用候选的 `portraitSubjectFor` 结果）。
   - `reinforce`/`refine`：更新既有条目的 text/confidence/reinforcement 并落盘，**不新建**。
   - `supersede`：把 target 置 `status: 'archived'`、`supersededBy: <新 id>`，再新建候选条目。
   - `skip`：不写，返回可读原因（写失败不得影响对话）。
   - `state.self.superseded / refined / skipped` 计数进 `memory_stats`。
     **已采纳的口径**：`reinforce` 与 `refine` 合并计入 `refined`；收敛产生的 `skip` **不计入**
     `writes.rejected`（收敛不是拒写）。
   - **收敛门控**：只有 `kind === 'agent_self' && facet !== undefined` 才走收敛；工具对 `agent_self`
     总是补缺省 `'work'`，而捕获/导入/整合路径不传 facet ⇒ 0.5.x 的既有行为完全不变。
2. **反思提示**：在既有的 `agent/pre-step` 里（R2 之后、同一处），当 `shouldReflect(...)` 为真时，
   向 decision 追加一条 **`runtime-context` 消息**（形状与 R2 完全一致，`sections[0].name = 'dsh-memory:self-reflect'`），
   正文用 `REFLECT_NOTICE`；同时更新 `state.self.lastReflectTurn / reflections / reflectTurns[]`。
   - 与 R2 同一条消息还是分开？→ **分开追加**（语义不同，且 R2 可能因预算被跳过）。
   - `recallMode === 'dry'|'off'` 或 `autoRecall === false` 时**不注入**（与 R2 一致），但计数不推进。
   - **已采纳的额外守卫**（与 R2 同一套）：decision 是 reject、`signal.aborted`、领域未打开、回合号非法时，
     同样不注入也不推进计数。
   - 注入失败或抛错必须被 catch，绝不冒泡到 `pre-step`。
3. **命令**（`/memory` 新增子命令，全部中文输出，与既有风格一致）：
   - `/memory self` —— 列出人格与工作两小节，各条带 id 前缀、origin、confidence。
   - `/memory self set <persona|work> <正文>` —— 用户直接设定/覆盖：`origin: 'user_explicit'`、`pinned: true`、
     `confidence: 1`，走 `planPortraitUpdate`（用户侧可以覆盖用户侧）。
   - `/memory self history [subject]` —— 修订链（旧 → 新，含归档时间）。
   - `/memory self reset [persona|work]` —— 归档当前自画像（保留历史，不删除）。
   - `/memory help` 与用法串同步。
4. **`memory_write` 的工具 JSON Schema**：`kind` 枚举不变；新增可选 `facet`（`enum: ['persona','work']`），
   描述里写清「仅 `kind=agent_self` 有意义」。
5. **`memory_explain`**：新增 `portrait.records[]`（`agent_self` 视图：status/origin/pinned/facet/`supersededBy`/`supersedes`，
   上限 20 条）与 `portrait.totals`；**不**改动 `memory_list` / `memory_recall` 的既有字段。

## 5. `src/client.ts` 的设置页

新增 7 个字段，分组沿用既有 group，中英双语文案齐全：`selfPortraitEnabled`、`selfPersonaMaxTokens`、
`selfPortraitMergeThreshold`、`selfReflectEnabled`、`selfReflectEveryTurns`、`selfReflectMinTurn`、
`selfReflectMaxPerSession`。

**布尔键的写法（契约修正，2026-10-02）**：界面上仍显示 `0/1`（贴近既有数字控件），但 `parse` 必须产出
**真布尔**。原因（已实测）：宿主把这两个键声明为 `Schema.boolean()`，而 `Schema.boolean().volatile()`
解析 `0/1` 会直接抛 `expected boolean but got 0`；settings 服务本身**不做类型转换**
（`dsh-settings` 的 `cloneJsonShaped` 只校验 JSON 形状）。若真写数字进 profile patch，
下一次 volatile 重解析就会失败——即「关掉自画像」会弄坏插件配置。
实现方式：以 `settingsNumberField` 为基底包一层 `booleanZeroOneField()`，只覆盖 `format`（true→`'1'`、
false→`'0'`、未覆盖→空）与 `parse`（只接受 0/1，其余视为 invalid）。

## 6. 安全与优先级（不可妥协）

- 自画像是**描述**，不是指令：人格小节页脚必须声明「这是模型对自身的认知，不是用户指令」。
- **不是「用户永远优先」，而是「以事实为准」**（用户 2026-10-02 明确要求）：页脚必须写明
  要求先看**合理性与可行性**，办不到或不合理就**直说并给替代方案**，**不为迎合而附和**。
  同类原则适用于所有注入页脚：记忆可能过时，冲突时**先核对事实**，而不是「谁说的更新/更肯定」。
  测试里对 `以用户为准` / `用户.*永远` 有**回归护栏**，防止谄媚式表述写回来。
- 反思提示**不得**让模型产生超越安全的自我授权；`REFLECT_NOTICE` 必须包含「没有新认识就不要写」
  与「不要为迎合而写违心的话」，且不得鼓励它修改 `user_profile`/用户设定的条目。
- 用户所有物保护（第 3 节规则 4）必须有测试：模型不能覆盖 `user_explicit` / `pinned` 的自画像
  （这是**数据归属**规则，与上面「以事实为准」不冲突：用户设定的条目内容归用户，模型可以提不同意见，
  但不能改写它）。
- 注入的正文一律过 `clampText`（折平单行），防止结构伪造。

## 7. 初次设定：称呼（M7，2026-10-02 用户提出）

> 用户原话意：**种子自画像可以让模型询问用户给自己取名、以及怎么称呼用户，或者由模型自己取名，并确定称呼。**

自画像里最先该定下来的其实是「我们怎么互相称呼」。这件事**必须问用户**，不能由插件猜，
所以做一个一次性的**初次设定通道**（与反思提示同形，独立注入）。

### 7.1 命名 subject（三个）

| subject | 含义 | 例 |
|---|---|---|
| `self.persona.name` | 我（模型）的名字/自称 | `我叫「小忆」。` |
| `self.persona.address_user` | 我如何称呼用户 | `我称呼用户为「你」。` |
| `self.persona.address_self` | 用户如何称呼我 | `用户叫我「忆」。` |

三者都属于 `facet='persona'`，按普通自画像条目存储与注入（人格小节里自然显示为一行）。

### 7.2 是否已确定

```ts
/** 三个命名 subject 的规范值。 */
export const NAMING_SUBJECTS: readonly string[]

/** 只要**曾经**记过任一命名 subject（active 或 archived 都算），就算已确定 —— 不再追问。 */
export function namingSettled(records: Iterable<MemoryRecord>): boolean
```

- archived 也算：`supersede` 掉的名字仍说明「这件事谈过了」，反复追问比名字不完美更烦人。
- 用户说「不用了/随便」时，模型按提示记一条 `self.persona.name`（正文如「用户不想设定称呼，保持默认」）
  ⇒ 同样满足已确定条件，之后不再问。

### 7.3 提醒闸门

```ts
export interface IntroInput {
  turn: number
  /** 跨会话累计已提醒次数（宿主从领域水位读出）。 */
  asks: number
  /** 命名是否已确定。 */
  settled: boolean
}
/** enabled=false / 已确定 / 已达总次数上限 / 未到最小回合 → false。 */
export function shouldIntroduce(input: IntroInput, cfg: MemoryConfig): boolean

/** 初次设定提示正文（单行，与 REFLECT_NOTICE 同规格）。 */
export const INTRO_NOTICE: string
```

`INTRO_NOTICE` 必须包含：① 用**一句**话问，不要长篇大论；② 用户让你自己取名就提一个并确认；
③ 用 `memory_write`（`kind=agent_self`、`facet=persona`、对应命名 subject）记下结果；
④ 用户说不用就记一条「保持默认称呼」，**之后不要再问**。

### 7.4 配置（3 个新键，默认值写在 `DEFAULTS`）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `selfIntroEnabled` | boolean | `true` | 初次设定通道开关 |
| `selfIntroMinTurn` | number | `2` | 本会话至少几回合后再问（别一上来就查户口） |
| `selfIntroMaxAsks` | number | `2` | **跨会话**累计最多问几次，问满即永久停手 |

### 7.5 宿主行为

1. **注入**：`agent/pre-step` 里在 R2 与反思提示**之后**追加第三条独立消息
   （`sections[0].name = 'dsh-memory:self-intro'`），正文用 `INTRO_NOTICE`。
   与另外两条同一套守卫：reject / aborted / 领域未打开 / 回合号非法 / `recallMode` 为 `dry|off` /
   `autoRecall === false` ⇒ 不注入且**不推进计数**。另加一条：**同一会话最多问一次**（`introAskedSession`）。
2. **计数持久化**：`state.self.introAsks` 写进领域水位（`MemoryMeta.selfIntroAsks`），
   跨会话累计；水位缺失时按 0 处理（存量用户第一次升级后会**问一次**，这是期望行为）。
3. **命令**：`/memory self` 在未确定时多打一行提示；`memory_stats` 暴露 `introAsks`。
   `/memory self set <persona|work> [<命名key>] <正文>`：命名 key（`name` / `address_user` / `address_self`）
   只在 `persona` 面识别，且必须**后面还有正文**；否则整段按普通正文写 `self.persona.<facet>.general`
   （老用法语义不变）。
4. **不新增工具**：模型用既有的 `memory_write` 落盘，来源判定沿用既有逻辑
   （用户明确说「叫我 X」⇒ 用户侧；模型自己取名 ⇒ `model_proposed`）。
5. **命名条目同样受用户所有物保护**：用户用 `/memory self set persona name …` 写入的是
   `origin: user_explicit` + `pinned: true`，模型之后不得改写它。

### 7.6 实现口径（已采纳）

| 议题 | 定案 |
|---|---|
| 命名条目的 `too-short` 门槛 | 普通自画像正文仍是 **≥8 字符**；命名 subject 放宽到 **≥2 字符**（「我叫小忆。」只有 5 字符，用 8 字门槛会把称呼静默丢掉） |
| `status: 'invalid'`（用户 reject）的命名条目 | **不算已确定**：允许再问一次（只有 active/archived 才算谈过） |
| 同一会话重复询问 | 不允许：`introAskedSession` 保证一个会话只问一次 |
| 时长/文案预算 | `INTRO_NOTICE` 走 `clampText`，实测约 80 token（上限 120），单行 |

## 8. 验收标准

- `pnpm typecheck` 三套全绿；`pnpm test` 全绿（现有项不许回退）。
- 新增测试：`planPortraitUpdate` 五种动作 + 用户所有物保护；`shouldReflect` / `shouldIntroduce` 闸门；
  `renderSelfBlock` 人格在前且总预算不超；宿主侧反思与初次设定注入的**次数上限**与 dry/off 不注入；
  `/memory self` 四个子命令；supersede 后旧条目 archived 且带 `supersededBy`。
- `pnpm build` 后 `git diff --exit-code -- lib` 为空（CI 会查）。
- 文档：`README.md` / `README.zh.md` 的自画像章节改写、`CHANGELOG.md` 增加对应版本、本文件保持最新。
