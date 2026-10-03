# 写入审批门（writePolicy）—— M10

> 竞品对照的第二个方向。社区两个头部记忆插件都把「**AI 只提议，用户决定**」当成核心安全机制：
> `dsh-memento` 是「审批门不可绕过：每条写路径都被强制经过服务内部的审批 waterfall」，
> `dsh-memory-evolve` 是「AI 自建的记忆先进待确认队列」。我们目前靠规则 + 2 会话晋升**自动写**，
> 没有「先问再写」这条通道。本文是并行实现的接口契约（签名冻结）。

## 1. 目标与默认值

给模型来源的写入加一道**可选**的审批门，三种策略：

| `writePolicy` | 模型来源的写入 | 其它来源（规则捕获 / 用户命令 / `/sleep` / 导入） |
|---|---|---|
| `'auto'`（**默认**） | 立刻生效（＝现状） | 立刻生效 |
| `'ask'` | 进**待确认队列**（`status: 'pending'`），用户批准后才生效 | 立刻生效 |
| `'off'` | 直接拒绝并给出可读原因 | 立刻生效 |

- **默认 `auto`，不改变任何现有行为**（这是硬要求：升级后用户不该察觉差异）。
- 判定的是 **`origin === 'model_proposed'`**：只有"模型自己提出的记忆"受门控。
  规则捕获（`observed`）、用户明确要求（`user_explicit`）、用户纠正（`user_correction`）**不受门控**——
  它们本来就是用户说的话，把用户的话塞进待确认队列只会淹没它。
- **模型不能自己批准**：没有任何工具能改变 `pending` 状态，只有用户的 `/memory approve` 才行。

## 2. 数据模型：复用 `status`

```ts
export type MemoryStatus = 'active' | 'pending' | 'invalid' | 'archived'
```

- 待确认记录**照常落盘**（进程重启后还在），只是 `status: 'pending'`。
- 通过既有 `status` 白名单过滤天然不进上下文：`listActive()`、`renderContextBlock`、`renderSelfBlock`、
  `recallRecords`、`/memory list`、`memory_stats` 计数……**但每一条读取路径都必须有测试钉死**
  （漏一条＝未批准的模型猜想进了系统提示，这是本功能最严重的失效模式）。

### 2.1 配置（`MemoryConfig`，默认值写在 `DEFAULTS`）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `writePolicy` | `'auto' \| 'ask' \| 'off'` | `'auto'` | 模型来源写入的策略 |
| `pendingMax` | number | `50` | 待确认队列上限；**满了拒绝新写入并报结构化错误，绝不静默丢弃** |

## 3. `src/lib.ts` 的新增导出（签名冻结）

```ts
export type WritePolicy = 'auto' | 'ask' | 'off'

/** 容错解析：非法/缺失 → 'auto'。 */
export function normalizeWritePolicy(value: unknown): WritePolicy

export type ModelWriteDecision = 'apply' | 'queue' | 'reject'

/**
 * 模型来源写入的处置（纯函数、确定性）：
 *   policy 'auto' → 'apply'；'ask' → 'queue'；'off' → 'reject'
 *   非模型来源（origin !== 'model_proposed'）**永远** 'apply'。
 */
export function decideModelWrite(policy: unknown, origin: MemoryOrigin): ModelWriteDecision

/** 待确认记录：status === 'pending'，按 observedAt 从新到旧。 */
export function listPending(records: Iterable<MemoryRecord>): MemoryRecord[]

/** 队列是否已满（count >= cfg.pendingMax；pendingMax <= 0 视为不设上限，NaN 回落默认）。 */
export function pendingQueueFull(count: number, cfg: MemoryConfig): boolean

/** `/memory pending` 的渲染（空队列要给出「没有待确认的写入」而不是空白）。 */
export function formatPendingQueue(records: Iterable<MemoryRecord>, cfg: MemoryConfig): string
```

## 4. `src/index.ts` 的宿主行为

1. **`writeMemory` 分流**：算出 `decision = decideModelWrite(cfg.writePolicy, origin)`：
   - `'apply'`：完全维持现状（含既有收敛、去重、脱敏、引用附着）。
   - `'queue'`：**先做既有安全闸**（敏感拒写、PII 脱敏、回声检测、队列上限），通过后建记录
     `status: 'pending'`、照常写 refs 与 hash、落盘；**此时不执行自画像收敛**（收敛推迟到批准时）。
     返回 `{ ok: true, pending: true, id, text }`，让模型知道"已提议、待用户确认"。
   - `'reject'`：返回 `{ ok: false, error: 'rejected_write_policy: …' }`，**不写盘**。
   - 队列满 → `{ ok: false, error: 'pending_queue_full: 待确认队列已满（N/上限），请先 /memory pending 处理' }`，不写盘。
   - 计数：`state.writes.pending`（新增）与 `state.writes.rejected` 分别统计。
2. **批准 / 拒绝**（新命令，**只读之外唯一的写入口，且只能由用户触发**）：
   - `/memory pending` → `formatPendingQueue`；每行带 id 前缀、kind/facet、origin、时间、refs、正文预览。
   - `/memory approve <id 前缀>` → 该记录 `status: 'active'`；**若它是 `agent_self`**，
     此刻才跑 `planPortraitUpdate` 的收敛（add/reinforce/refine/supersede 按当时的库状态决定）。
   - `/memory reject-pending <id 前缀>` → `status: 'invalid'`（**保留**用于审计，不物理删除），并计入 `state.writes.rejected`。
     > 为什么不是 `/memory reject`：那个命令早就用于「拒绝一条**已生效**的自我观察」，语义不同。
     > 队列出口因此另起 `reject-pending`（实现与测试已按此落地，Lead 裁决后契约同步为这个名字）。
   - 前缀不唯一 → 明确报错并列出候选；找不到 → 明确报错。
3. **读取路径审计**（每条都要确认并有测试）：
   `renderContextBlock` / `renderSelfBlock` / `recallRecords` / `memory_recall` / `memory_list` /
   `/memory list` / `/memory search` / `memory_explain`（要能显式看到 pending，用于诊断）/
   项目印象重算 / 整合（合并、失效、归档、摘要、固化）/ `/sleep` 的计划与落盘
   —— **除 `/memory pending` 与 `memory_explain` 之外，一律不得出现 pending 记录**。
4. **可观测**：`/memory stats` 与 `memory_stats` 增加「待确认：N 条（writePolicy=…）」，N 为 0 时也显示策略值。
5. **重启存活**：pending 记录随普通记录一起加载（`listActive` 之外），`/memory pending` 重启后仍能看到。

## 5. 不可妥协项

- **默认 `auto` 必须与 0.5.9 行为逐字节等价**（有测试对比：默认配置下模型写入立刻生效、不进队列）。
- **pending 绝不进任何注入路径**（含 R2、常驻、自画像、印象），也不参与排序/召回/整合。
- **模型无法自我批准**：除用户命令外没有任何路径把 `pending` 改成 `active`。
- **有界且诚实**：队列满时拒绝并报结构化错误，不静默丢弃、不自动压缩。
- **审批不改变安全闸**：`ask` 模式下敏感信息照样在"入队前"就被拒写（队列不是绕过脱敏的后门）。
- **拒绝保留痕迹**：`reject` 置 `invalid` 而非删除，`/memory verify` 与审计仍能看到它曾经存在。

## 6. 验收标准

- `pnpm typecheck` 四套全绿；`pnpm test` 全绿（现有 **181** 项不许回退）。
- lib：`normalizeWritePolicy`（非法→auto）、`decideModelWrite`（3 策略 × 4 来源）、`listPending` 排序、
  `pendingQueueFull`（0/负/NaN/Infinity）、`formatPendingQueue`（空/多条）。
- host：`ask` 模式的工具写入 → `pending` 且 `ok:true`；**该记录不出现在常驻块与 R2**（关键安全测试）；
  `/memory pending` 列出；`/memory approve` → 变 active、随后**能**注入、`agent_self` 在批准时才收敛；
  `/memory reject` → invalid 且永不注入；`off` 模式拒绝且零写入；队列满 → 结构化错误；
  用户命令与 `/sleep` 补录**绕过**队列；规则捕获（observed）**绕过**队列；重启后 pending 仍在；
  `/memory stats` 与 `memory_stats` 显示待确认条数与策略。
- client：`writePolicy` 与 `pendingMax` 进设置页（表单 25 → 27 字段），中英双语文案齐全。
- 文档：两份 README 增加「写入审批门」章节与配置行；`CHANGELOG.md` 增加 0.5.10；本文件保持最新。
