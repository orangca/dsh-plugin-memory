# 写入审计与注入核对（`/memory audit`）—— M13

> 竞品对照的第五个方向。`dsh-memento` 把两件事当成卖点：**可重建的审计链**（approval 事件 + 插件审计表）
> 与 **「模型可见 ⟺ 已记录」**（注入的快照逐字进 `system/message`），并且它会**明确说出审计缺口**
> （宿主不认识某类会话事件时就直说）。我们目前只有一个笼统的计数器。本文是接口契约（签名冻结）。

## 1. 审计从哪来：两条来源，各司其职

| 来源 | 覆盖 | 持久性 |
|---|---|---|
| **记录本身派生**（`observedAt`/`origin`/`refs.via`/`status`/`invalidAt`/`supersededBy`） | 成功的写入、合并、失效、归档、待确认 | **天然持久**（就在库里，重启后仍在） |
| **内存尝试环**（新，有界） | **没有落盘的尝试**：被拒写（敏感/回声/策略/队列满）、入队、批准、拒绝待确认 | 进程内（重启即失，文档写明） |

这样设计的好处：**不为审计新增存储**（不留第二份真相），而"被拒"这类最需要解释的事件也不会丢。

## 2. `src/lib.ts` 的新增导出（签名冻结）

```ts
export type AuditAction =
  | 'created' | 'merged' | 'pending' | 'approved' | 'rejected-pending'
  | 'rejected' | 'invalidated' | 'archived' | 'forgotten'

/** 一条审计事件（成功的写入也能从记录派生；这里是"尝试"视角，含被拒的）。 */
export interface AuditEntry {
  /** 毫秒时间戳。 */
  at: number
  /** 相关记录 id；被拒/队列满时可能是 null。 */
  id: string | null
  kind: string
  origin: string
  /** 写入路径：live | sleep | tool | command | solidify | import（来自 refs.via）。 */
  via: string | null
  action: AuditAction
  /** 被拒原因等可读说明。 */
  reason?: string | null
}

/** 有界环：新事件在前，最多 cfg.auditMax 条（<=0 视为不记录）。 */
export function pushAudit(entries: readonly AuditEntry[], entry: AuditEntry, cfg: MemoryConfig): AuditEntry[]

/** 按 action 计数。 */
export function auditCounts(entries: readonly AuditEntry[]): Record<AuditAction, number>

export interface AuditInput {
  entries: readonly AuditEntry[]
  records: Iterable<MemoryRecord>
  cfg: MemoryConfig
  /** 当前分支（可空）。 */
  currentBranch?: string | null
  /** `--verify` 的结果；未做核对时为 null。 */
  verify?: { checked: number; matched: number; missing: number; sample?: string | null; gap?: string | null } | null
}

/**
 * `/memory audit` 的渲染（命令输出，**中文**，与其它命令一致）：
 *  1) 最近 N 条尝试（id 前缀、action、via、origin、kind、时间、原因）；
 *  2) 按 action 与 via 的计数；
 *  3) 库内状态汇总：active / pending / archived / invalid，带 refs 的比例；
 *  4) `--verify` 结果（含"审计缺口"说明：宿主没有 sessionQuery 时必须明说）。
 */
export function formatAudit(input: AuditInput): string
```

### 2.1 配置（`MemoryConfig`）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `auditMax` | number | `50` | 内存尝试环的容量（0＝不记录）；**volatile**（进设置页） |

## 3. `src/index.ts` 的宿主行为

1. **记录尝试**：在这些点各推一条 `AuditEntry`（**全部包在 try/catch 里，绝不影响主流程**）：
   `writeMemory` 的成功创建（`created`）、合并到既有条目（`merged`）、进待确认队列（`pending`）、
   被拒（`rejected`，`reason` 取既有错误码）、`/memory approve`（`approved`）、`/memory reject-pending`（`rejected-pending`）、
   整合里的失效（`invalidated`）与归档（`archived`）、`/memory forget`（`forgotten`）。
2. **新命令 `/memory audit [--limit N] [--verify]`**：
   - 默认：`formatAudit`（记录派生 + 尝试环），`--limit` 控制最近条数（默认 20，上限 200）。
   - `--verify`：核对**本会话**的注入内容是否逐字出现在会话日志里 ——
     取 `ctx.get('sessionQuery')`，`readSession(当前会话 id)`，把 `state.injected.section/context` 里记录的注入行
     与会话事件文本比对（逐行 `includes`，这是"逐字"语义，不做 token 相似度）；
     报告 `checked/matched/missing` 与一条未命中的样例。
     - **审计缺口**：没有 `sessionQuery`、或当前会话 id 未知、或日志里没有任何 `user/message` 事件时，
       必须在输出里**明说缺口**（"本宿主/本会话无法核对，原因：…"），而不是显示 0 或静默跳过。
3. **`/memory stats` 与 `memory_stats`**：加一行「审计：最近 N 条尝试（记录档 M 条）；未命中核对 K 次」之类的最小摘要
   （详细看 `/memory audit`）。
4. **`Schema`** 增加 `auditMax`（number，默认 50）且 **volatile**（设置页字段 29 → 30）。
5. **测试接缝（不计入契约面）**：宿主保留了 `simulateAuditError`（布尔，默认缺省）用于故障注入测试
   —— 它**不在 `Schema` 里**，因此 patch 行设置它会被 schema 校验剥掉、生产不可达；它只让 `auditPush` 抛错，
   用来证明「审计异常不影响写入」。这一条写在这里是为了让审计面**没有未记录的行为**。

## 4. 不可妥协项

- **审计只读**：`/memory audit` 与 `--verify` 绝不修改任何记录或状态；`--verify` 只读会话日志。
- **不新增存储**：成功的写事件从记录派生；只有不落盘的尝试放内存环（有界），不写第二份真相。
- **审计失败不影响主流程**：任何推事件/渲染/核对的异常都被 catch，主流程（写入、注入）照常。
- **缺口要说出来**：拿不到会话日志时明确报"无法核对及原因"，不许把"没核对"渲染成"核对通过"。
- **逐字就是逐字**：`--verify` 用 `includes` 判定，不做模糊匹配（否则就失去"模型可见 ⟺ 已记录"的意义）。

## 5. 验收标准

- `pnpm typecheck` 四套全绿；`pnpm test` 全绿（现有 **245** 项不许回退）。
- lib：`pushAudit`（新在前、`auditMax` 裁剪、0/NaN/负值、不改入参数组）、`auditCounts`、`formatAudit`
  （空环/有事件/含 verify 结果/含审计缺口/记录派生汇总）。
- host：各写路径都推事件（成功/合并/入队/被拒/批准/拒绝待确认/失效/归档/忘记）；
  `/memory audit` 渲染含最近尝试与库内汇总；`--limit` 生效；`--verify` 在**有 sessionQuery** 时给出
  checked/matched/missing 且**不改任何数据**，在**无 sessionQuery** 时明说缺口；
  `auditMax: 0` 时不记录且命令仍可用；审计异常不影响写入。
- client：`auditMax` 进设置页（表单 **30** 字段），中英双语文案齐全。
- 文档：两份 README 增加 `/memory audit` 章节与配置行；`CHANGELOG.md` 增加 0.5.14；本文件保持最新。
