# `/sleep` —— 空闲梳理（M8）

> 用户诉求（2026-10-02）：*添加 `/sleep` 命令，可以在空闲时读取现有记忆库和最近的一些会话的完整记录，
> 生成重新梳理的记忆库。*
>
> 本文是**并行实现的接口契约**：`src/lib.ts`（纯函数）、`src/index.ts`（宿主命令）、`src/client.ts`（设置页）
> 三边照它实现；签名与语义冻结，要改先改这里。

## 1. 它是什么

`/memory consolidate` 只做**库内治理**（合并/失效/归档/摘要），`/sleep` 做的是**跨库 + 跨会话**的梳理：
把最近若干会话的**完整事件日志**重新过一遍记忆管线，补上当时漏掉/被节流掉的记忆，
再把整个库重新排一遍，产出一份「睡醒之后的记忆库」。

数据来源是宿主服务 **`ctx.sessionQuery`**（实测契约，见 §3），不是手工解会话日志文件 ——
DSH 的日志是**多 zstd 帧拼接**的，`zstdDecompressSync` 只能解第一帧（实测 8MB 文件只解出 213 字符）。

## 2. 行为（一句话）

```
/sleep [--sessions=N] [--all] [--apply]
```

- **默认预览**：只读、只算，输出一份「会怎么改」的计划（补录 N 条 / 合并 M 组 / 失效 K 条 / 归档 J 条 / 重算印象）。
  **不写任何东西**。
- **`--apply`**：先自动导出一份备份（见 §6），再按计划落盘，最后回报统计。
- `--sessions=N`：回看最近 N 个会话（默认 `cfg.sleepSessions`，上限 20）。
- `--all`：不按 cwd 过滤，回看**全部**最近会话（默认按当前/最近会话的 cwd 过滤，避免把别的项目的事混进来）。

## 3. 宿主接缝（`ctx.sessionQuery`，实测契约）

用 `ctx.get('sessionQuery')` 取（可选服务，取不到要有清楚的降级文案）。本插件只依赖四个方法：

```ts
interface DshSessionQuery {
  listSessions(signal?: AbortSignal): Promise<DshSessionRecord[]>
  filterSessions(filters: readonly DshSessionResultFilter[], signal?: AbortSignal): Promise<DshSessionRecord[]>
  readSession(sessionId: string): Promise<DshSessionLogSnapshot>
  listEvents(sessionId: string): Promise<DshSessionEventRecord[]>
}
interface DshSessionRecord { header: { id: string; cwd?: string; createdAt: number; origin?: 'subagent'; parentSession?: string }; live: boolean; persisted: boolean }
interface DshSessionLogSnapshot { session: { id: string; cwd?: string; createdAt: number }; inheritedEventCount: number; events: DshSessionEvent[] }
interface DshSessionEvent { type: string; seq: number; time: number; data?: Record<string, unknown> }
```

要点（**实测**，不是猜的）：

- `SessionEventMap['user/message']` 的 `data` 就是 `UserMessage`（`role: 'user'`、`content` 是内容块数组、`source.kind` 为 `'user' | 'model' | 'tool' | 'system-prompt'`）。
  **只有 `data.source.kind === 'user'` 才是真实用户消息** —— 我们自己注入的 `runtime-context` 消息也在日志里，
  必须排除，否则 `/sleep` 会把注入当用户要求（自激）。
- `SessionEventMap['assistant/message']`：`data.message` 是 assistant 消息，用于回声检测（`isEcho`）。
- 会话可能带 `origin: 'subagent'` / `parentSession` —— 子代理会话默认**跳过**（它们的"用户消息"是父代理的指令，不是用户说的）。
- `inheritedEventCount` 是继承自父会话的事件数，与本次梳理无关，忽略即可。

## 4. `src/lib.ts` 的新增导出（签名冻结）

```ts
/** 一条从会话日志里抽出来的消息（只保留梳理用得上的字段）。 */
export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  at: number | null
}

/** `transcriptOf` 的输入：宿主读到的会话事件（`readSession` 的原始产物）。 */
export interface SleepSessionInput {
  sessionId: string
  cwd?: string | null
  createdAt: number
  /** `readSession()` 返回的完整事件日志（只读，不修改）。 */
  events: readonly unknown[]
  /** 可选：`origin: 'subagent'` 或带 `parentSession` 的会话整体跳过（契约 §3）。 */
  origin?: 'subagent'
  parentSession?: string
  header?: Record<string, unknown>
}

/** 一个会话的抽取结果。 */
export interface SleepSource {
  sessionId: string
  cwd: string | null
  createdAt: number
  messages: TranscriptMessage[]
}

/** 回放捕获产出的一条候选记忆。 */
export interface SleepCandidate {
  text: string
  sessionId: string
  at: number | null
  scope: { level: 'workspace' | 'profile'; key: string }
  origin: MemoryOrigin
  confidence: number
  /** 与 `recordHash` 同源的指纹，用于「库里已有」判定。 */
  hash: string
}

/** 梳理计划：**只描述要做什么，不做任何写入**。 */
export interface SleepPlan {
  scanned: { sessions: number; messages: number; chars: number }
  /** 库里没有的候选（按 hash 去重后）。 */
  backfill: SleepCandidate[]
  /** 命中已有指纹而跳过的条数。 */
  duplicates: number
  /** 建议合并组（同 subject、相似度 ≥ cfg.mergeSimilarity）。 */
  merges: Array<{ ids: string[]; subject: string; text: string }>
  /** 建议失效的矛盾条目（保留 keep，失效 drop）。 */
  conflicts: Array<{ keep: string; drop: string; subject: string }>
  /** 建议归档的条目 id（`shouldArchive`）。 */
  archive: string[]
  /** 重算后的项目印象（按 workspace 分组，最多 `cfg.sleepMaxGists` 条）。 */
  gists: Array<{ level: 'workspace'; key: string; text: string }>
  /** 人读的说明/降级原因，按顺序渲染。 */
  notes: string[]
  /** 上限裁剪后的候选数（`cfg.sleepMaxBackfill`）。 */
  truncated: number
}

/**
 * 从会话事件抽消息：**只认 `data.source.kind === 'user'` 的 user/message**，
 * 以及用于回声检测的 assistant/message 文本（`cfg.sleepAssistantContext` 条以内，默认 3，取该用户消息之前最近的几条）。
 * 空文本、控制字符、超长文本按 `clampText` 处理；每个会话的字符预算 `cfg.sleepMaxCharsPerSession`。
 */
export function transcriptOf(
  sessions: readonly SleepSessionInput[],
  cfg: MemoryConfig,
): { sources: SleepSource[]; messages: number; chars: number; skippedSubagents: number }

/**
 * 生成梳理计划（纯函数、确定性）。
 * 步骤：
 *  1. 回放捕获：对每条真实用户消息跑 `extractCandidates`（`deriveOriginFromMessages` 语义：命中显式祈使 → user_explicit，
 *     否则跳过 —— `/sleep` **只补录用户明确要求记住的东西**，不把闲聊变成记忆）；
 *  2. 去重：`recordHash` 命中库内已有（含 archived）→ `duplicates += 1`，不进 backfill；
 *  3. 合并：对库内归档后的 active 集跑 `pickMergeGroups`；
 *  4. 冲突：跑 `findConflicts`；
 *  5. 归档：跑 `shouldArchive`；
 *  6. 项目印象：用回放期间 `detectWorkspaceMarkers` 观察到的标记，按 workspace 重算 `composeGistText`；
 *  7. 裁剪：backfill 最多 `cfg.sleepMaxBackfill` 条（按时间升序取最早？→ 取**最新**的，更贴近当前事实），
 *     其余计入 `truncated`；
 *  8. **不碰自画像**：人格/工作倾向属于模型自我认知，规则不能替它下结论。计划里不产生任何 `agent_self` 写入。
 */
export function buildSleepPlan(input: {
  records: Iterable<MemoryRecord>
  sources: readonly SleepSource[]
  cfg: MemoryConfig
  now?: number
}): SleepPlan

/** 预览/回报文本（中文，与既有命令风格一致；空计划必须给出「无需改动」而不是空白）。 */
export function formatSleepPlan(plan: SleepPlan, cfg: MemoryConfig): string

/** 计划是否无事可做（backfill/merges/conflicts/archive/gists 全空）。 */
export function sleepPlanIsEmpty(plan: SleepPlan): boolean
```

### 4.2 已采纳的实现口径（实现者提问后定案，2026-10-02）

| 议题 | 定案 |
|---|---|
| `SleepCandidate` 的字段 | 增加**可选** `kind` / `subject`（与实况捕获同源：`subject = deriveSubject(text, signal)`、scope 用 `defaultScopeFor`）。没有它们，补录落盘后的指纹与候选对不上，第二次 `/sleep` 就不幂等 |
| 单会话超预算 | **保留最新**的消息，丢弃条数写进该会话的 `notes`；被总预算整体裁掉的会话仍留在 `sources`（`messages: []` + note），让降级原因能随计划呈现 |
| `duplicates` 的统计口径 | 命中已有指纹而跳过的条数（库内**含 archived 与 invalid**，也含本次更早的重复候选） |
| 项目印象何时跳过 | 仅当存在 active 的 `project_gist`、同 workspace、subject 为 `project.overview` 且文本完全相同时跳过 —— 保证第二次 `/sleep` 是空计划 |
| `scanned.messages/chars` | 含为回声检测保留的 assistant 文本 |
| `formatSleepPlan` 的用途 | **只用于预览**（尾行固定声明「未写入任何内容」）；`--apply` 之后由宿主用自己的统计文本，不复用它 |
| 备份文件名 | ISO 时间戳里的 `:` / `.` 换成 `-`（Windows 路径非法字符），形如 `sleep-backup-2026-10-02T09-22-17-243Z.json`，仍匹配 `sleep-backup-*.json` |
| 空计划 + `--apply` | 仍按 §5.2a 字面**先导备份**再落 0 条，并追加「计划为空：本次无需改动」。也就是说重复 apply 会各留一份备份 —— 这是「先备份」不变式的代价，用户可以自行清理旧备份 |
| `state.sleep.runs` | 只在 `--apply` 累加（预览零副作用，连计数都不动） |
| `findConflicts` 的「用户侧 drop 跳过」 | 计划层（lib）已全部排除，宿主侧保留为**防御性**代码 |

### 4.3 测试也要被类型检查（Lead 补做）

`tests/**` 此前不在任何 tsconfig 的 `include` 里 —— 等于测试代码从未被 `tsc` 检查过
（实测 `tests/lib.test.ts` 里就存在一个既有类型错误）。新增 `tsconfig.tests.json`（`noEmit`）
并接进 `pnpm typecheck` 与 CI，让测试与源码同标准。

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `sleepEnabled` | boolean | `true` | `/sleep` 命令开关（关掉后命令返回说明，不做任何事） |
| `sleepSessions` | number | `3` | 默认回看最近几个会话 |
| `sleepMaxCharsPerSession` | number | `120000` | 单会话字符预算（超出截断并记 note） |
| `sleepMaxCharsTotal` | number | `300000` | 总字符预算 |
| `sleepMaxBackfill` | number | `20` | 单次最多补录几条 |
| `sleepAssistantContext` | number | `3` | 每条用户消息前保留几条 assistant 文本（回声检测用） |
| `sleepMaxGists` | number | `8` | 最多重算几条项目印象 |

## 5. 宿主行为（`src/index.ts`）

1. **命令注册**：在既有 `/memory` 之外**注册独立命令 `sleep`**（用户明确要的是 `/sleep`）：
   `ctx.commands.register({ name: 'sleep', description: '…', input: { hint: '[--apply] [--sessions=N] [--all]' }, handler })`。
2. **流程**：取服务 → 列会话（`filterSessions` 按 cwd，或 `listSessions` 取最近 N）→ `readSession` 逐个读 →
   `transcriptOf` → `buildSleepPlan` → 预览时直接 `formatSleepPlan` 返回；`--apply` 时：
   a. **先备份**：把当前全部记录导出到 `<exportDir>/sleep-backup-<ISO 时间戳>.json`（复用既有导出实现，
      失败则**中止 apply** 并如实报错 —— 没有备份就不改库）；
   b. 依次执行：backfill（走 `writeMemory`，`origin` 用候选的来源）、merges（复用整合的合并路径）、
      conflicts（`status: 'invalid'`）、archive（`shouldArchive` → `status: 'archived'`）、gists（写 `project_gist`）；
   c. 更新 `state.sleep` 计数与 `MemoryMeta.lastSleepAt`（水位）；
   d. 最后 `flush()` 并返回统计文本。
3. **永不抛**：整条命令包在 try/catch 里，失败返回 `{ kind: 'error', text }`；服务缺失时给出可读说明
   （「当前宿主没有 sessionQuery 服务，`/sleep` 需要它读取会话记录；`/memory consolidate` 仍可用」）。
4. **可观测**：`state.sleep = { runs, added, merged, invalidated, archived, gists, skipped, last: { at, sessions, messages, chars } | null }`，
   在 `/memory stats` 里加一行；`memory_stats` 工具同步。
5. **与召回模式无关**：`/sleep` 是用户显式触发的维护动作，**不受** `recallMode` / `autoRecall` 影响（但 `sleepEnabled === false` 时拒绝执行）。

## 6. 安全与不可妥协项

- **默认不写**：没有 `--apply` 就绝不落盘（这是这个命令最重要的性质）。
- **有备份才改**：`--apply` 的第一件事是导出备份；备份失败即中止，绝不「先改再备份」。
- **不碰自画像**：`/sleep` 不生成任何 `agent_self` 写入（见 §4 第 8 条）。
- **不碰用户所有物**：合并不动 `pinned`；冲突判定不允许把用户侧条目判成 `drop`（沿用 `findConflicts` 既有语义，
  若它给出「用户侧 drop」的计划，必须在 `notes` 里标注并**跳过该条**）。
- **自激防护**：注入的 `runtime-context` 消息不是用户消息（§3），补录的候选也要过 `isEcho` 与敏感扫描（`writeMemory` 已带）。
- **预算硬上限**：总字符、单会话字符、会话数、补录条数都有上限，任何一项超限都要在 `notes` 里写清。

## 7. 验收标准

- `pnpm typecheck` 三套全绿；`pnpm test` 全绿（现有 102 项不许回退）。
- lib：`transcriptOf`（只认 `source.kind === 'user'`、跳过 subagent、预算截断）、`buildSleepPlan`
  （补录/去重/合并/冲突/归档/印象/裁剪/不产生 agent_self）、`formatSleepPlan`、`sleepPlanIsEmpty` 全覆盖。
- host：无 `sessionQuery` 时的降级文案；预览模式**零写入**；`--apply` 先备份后写；重复执行幂等（第二次无新增）；
  `sleepEnabled=false` 拒绝执行；`/memory stats` 与 `memory_stats` 暴露 sleep 行。
- client：3 个新配置键（`sleepEnabled` / `sleepSessions` / `sleepMaxBackfill` 至少进表单；其余可用 patch 行）。
- 文档：两份 README 增加 `/sleep` 章节与配置行，`CHANGELOG.md` 增加 0.5.7，本文件保持最新。
