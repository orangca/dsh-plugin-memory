# 可核验引用（refs）—— M9

> 竞品对照得到的第一个方向：社区里两条独立实现（`dsh-memory_rollout`「可核验引用」、
> `Jesse-njx/dsh-memory`「事实带 sessionId/eventRange 引用」）都把**记忆可追溯**当作核心卖点，
> 而我们的记录里连来源会话 id 都没存。本文是并行实现的接口契约（签名冻结）。

## 1. 目标

每条记忆都能回答「**你凭什么这么说**」：指向它来源的会话与事件序号区间。
引用必须**廉价**（写入路径上零额外 IO/模型调用）、**向后兼容**（老记录没有 refs 照常工作）、
**可核验**（有 `sessionQuery` 时能回到原文位置核对）。

## 2. 数据模型

```ts
/** 一条记忆的来源引用：会话 + 事件序号闭区间。 */
export interface MemoryRef {
  sessionId: string
  /** 起始事件序号（含）。 */
  from?: number
  /** 结束事件序号（含）；单点引用时省略。 */
  to?: number
  /** 写入路径，便于区分来源与自查。 */
  via?: 'live' | 'sleep' | 'tool' | 'command' | 'solidify' | 'import'
}
```

- `MemoryRecord.refs?: MemoryRef[]`（可选、向后兼容；**不参与 `recordHash`**，否则同一条记忆因为引用不同会被判成两条）。
- 上限 `cfg.refsMax`（默认 5）；同一 `sessionId + from + to` 视为重复，只留一条。
  **「新引用在前」是调用方约定，不是本层的保证**：`normalizeRefs` 保持入参顺序（见 §3）。
- 会话 id 一律存**完整 id**（不截断）；展示时可短化（见 §3）。
- 引用在字符串形态下的语法见 §2.1（`sessionId#from-to`，多条用 `;`）。

### 2.1 引用的字符串语法（冻结）

引用在**工具输出 / 预览 / `write()` 返回的 `refs` 字段**里是一条字符串，由 `refsToString` 渲染：

| 形态 | 例子 | 什么时候 |
|---|---|---|
| 区间 | `session-84a547da-5727-4ffc-adf0-26d02e749e13#120-180` | `from` 与 `to` 都给且**不相等** |
| 单点 | `session-…-…#93` | 只给 `from`（`to` 省略），或 `from === to` |
| 只有终点 | `session-…-…#180` | 只给 `to` |
| 无语号 | `session-…-…` | `from` / `to` 都没给（序列号未知） |
| 多条 | 上面任意两条用 **`;`** 连接：`session-A#120-180;session-B#93` | 一条记录有多个引用 |

- 分隔符是**单个 `;`**（`formatRefs` 展示时用的是 `'; '`，带一个空格 —— 机器可读串不带空格）。
- **顺序就是 `refs` 数组的顺序**（约定新在前），**上限 `cfg.refsMax`**、去重键 `sessionId|from|to` 与 §2 同一套规则，
  由 `normalizeRefs` 在写入时执行；`refsToString` 自己不做去重、不做裁剪，只渲染拿到的数组。
- 会话 id 不合法（空串等）、序号非整数时该条引用在读取路径被丢弃（`refsOf` 容错，见 §3）；渲染结果可能是空串。
- 无引用 ⇒ 空串 `''`（`write()` 的 `refs` 字段此时是 `[]`，不是 `['']`）。

### 2.2 配置（`MemoryConfig`，默认值写在 `DEFAULTS`）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `refsEnabled` | boolean | `true` | 是否附着引用（关掉后新记录不带 refs） |
| `refsMax` | number | `5` | 每条记录最多保留几个引用 |

## 3. `src/lib.ts` 的新增导出

```ts
/** 容错读取：非法/缺失一律返回空数组。 */
export function refsOf(record: MemoryRecord | null | undefined): MemoryRef[]

/** 规范化（去重 + 裁剪 + 字段校验）：非法项丢弃，**保持入参顺序**（约定「新在前」，见下），最多 cfg.refsMax 条。 */
export function normalizeRefs(value: unknown, cfg: MemoryConfig): MemoryRef[]

/** 合并一个新引用（新在前）；`cfg.refsEnabled === false` 时原样返回。 */
export function withRef(refs: unknown, ref: MemoryRef, cfg: MemoryConfig): MemoryRef[]

/** 展示：完整 id 时是 `session-84a547da-5727-4ffc-adf0-26d02e749e13#120-180`；`{ short: true }` 才是 `ses-84a547da#120-180`；无引用返回空串。 */
export function formatRefs(refs: readonly MemoryRef[] | undefined, options?: { short?: boolean }): string

/** 机器可读的引用串（写进工具输出/预览）：`sessionId#from-to`，多条用 `;` 分隔（语法见 §2.1）。 */
export function refsToString(refs: readonly MemoryRef[] | undefined): string
```

**`normalizeRefs` 不排序、也不认「新在前」**：它**保持入参顺序**，只做去重、裁剪与字段校验。
「新引用在前」是**调用方（写入路径）的责任** —— 纯函数不知道谁更新，不猜。具体约定：

- 新增引用一律用 `withRef`，它把新引用拼在**最前**（`normalizeRefs([ref, ...旧])`）—— 这是唯一的「新在前」来源；
- 直接调 `normalizeRefs`（例如导入、反序列化）时，**顺序就是调用方给的顺序**，给反了就存反了；
- 想要「新的在前」却又直接调 `normalizeRefs` 的调用方，请自己先把数组排成新在前。

**`formatRefs` 默认不短化**：`options.short` 只在显式传 `true` 时才把会话 id 短化成 `ses-84a547da`
（完整 id 存进来，`ses-` 前缀 + `-` 后前 8 个字符）。缺省输出的是**完整会话 id**，
所以不要把 `formatRefs(refs)` 的结果当成 `ses-…` 形态去断言。

**`/sleep` 回放也要带引用**（这是 refs 最硬的价值：补录的每一条都能指回用户当时说的那条消息）：

```ts
export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  at: number | null
  /** 事件序号（来自会话日志）；缺失为 null。 */
  seq: number | null
}
export interface SleepCandidate {
  // …既有字段
  /** 来源引用：该用户消息所在的会话与序号。 */
  refs?: MemoryRef[]
}
```
`buildSleepPlan` 为每个 backfill 候选填 `refs: [{ sessionId, from: seq, via: 'sleep' }]`。

## 4. `src/index.ts` 的宿主行为

1. **序号跟踪（零成本）**：既有的 `ctx.on('session/event')` 里顺手记 `state.seq.last`（每个事件的 `seq`）与
   `state.seq.turnStart`（`turn/start` 的 `seq`），并按 `_session.id` 记 `state.seq.sessionId`。
   **不新增任何 I/O 或服务调用。**
2. **所有写入路径都附着引用**（`refsEnabled` 为真时）：
   | 路径 | `via` | 区间 |
   |---|---|---|
   | 回合收尾规则捕获 | `'live'` | `from = turnStart, to = lastSeq` |
   | 模型工具 `memory_write` | `'tool'` | `from = lastSeq`（单点） |
   | `/memory set`、`/memory self set` 等用户命令 | `'command'` | `from = lastSeq` |
   | 压缩摘要固化 | `'solidify'` | `from = lastSeq` |
   | `/sleep` 补录 | `'sleep'` | 候选自带（用户消息的 seq） |
   - **reinforce / refine 合并时**：新引用合并进既有条目（`withRef`），旧引用保留。
   - `supersede` 新建的条目带自己的引用；被归档的旧条目引用不动。
3. **展示**：`/memory show <id>` 增加一行「来源：<refs>」；`memory_explain` 的记录视图带 `refs`；
   `/sleep` 预览里补录候选带 `refs`。
4. **新命令 `/memory verify <id>`**：核对引用。
   - 取 `ctx.get('sessionQuery')`；不可用 → `kind: 'error'` 并说明「需要 sessionQuery 才能核对」（不抛）。
   - 对每条 ref：`readSession(sessionId)` 后取 `from..to` 区间内的事件，把它们的文本与记录正文比对
     （用 `tokenize` 后的**信息量 token 覆盖率**，阈值 `cfg.recallMinMatch`；避免逐字相等这种脆弱判定）。
   - 输出：每条引用一行「`ses-xxx#120-180` ✅ 命中（覆盖率 0.83）」/「⚠️ 未命中」/「⚠️ 会话或事件不存在」。
   - 无引用的记录 → 明确说「这条没有引用（可能是 0.5.9 之前写入的）」。
5. **可观测**：`state.refs = { attached, verified, mismatched, lastError }`；`/memory stats` 加一行
   「引用：已附着 N 次 / 无引用记录 M 条」。

## 5. 不可妥协项

- **引用不参与指纹**（`recordHash` 不变）：否则同一条记忆因为来源不同会被判成两条，破坏去重与幂等。
- **写路径绝不因为引用而变慢或变脆**：序号跟踪只用既有事件回调的内存赋值；`refsEnabled === false` 时完全跳过。
- **`/memory verify` 只读**：不修改任何记录，服务缺失时降级说明。
- **向后兼容**：0.5.8 及更早的记录没有 `refs` 字段，所有读取路径必须容错（`refsOf` 返回空数组）。

## 6. 验收标准

- `pnpm typecheck` 四套全绿；`pnpm test` 全绿（现有 146 项不许回退）。
- lib：`normalizeRefs`（去重/裁剪/非法丢弃/**保持入参顺序**）、`withRef`（开关关闭时原样返回、新引用拼在最前）、
  `refsOf` 容错、`formatRefs`（缺省完整 id、`{ short: true }` 才短化）/`refsToString`（`;` 分隔、单点 `#from`）、
  `buildSleepPlan` 为候选填 refs、`recordHash` **不因 refs 改变**。
- host：写路径附着（live 区间用 turnStart..lastSeq、tool 单点）、reinforce 合并引用、`/memory show` 显示、
  `/memory verify` 三类结果（命中/未命中/服务缺失）、`refsEnabled=false` 时不附着、stats 行。
- 文档：README 双语（refs 语义 + `/memory verify` + 两个配置键）、`CHANGELOG.md` 增加 0.5.9。
