# 记忆服务协议 v1

> 宿主半边（`src/index.ts`）对外提供**一个**名为 `memory` 的服务。本文把它的服务面冻结下来，让第三方可以放心依赖。
> 本文是 [protocol-v1.md](protocol-v1.md) 的中文版，两份逐节对齐；`tests/protocol.test.ts` 会把下面每一条承诺
> 钉在真正发布的 `lib/index.js` 上。
>
> 本文全部照实现读出来，不写意图。实现与本文今天不一致的地方，一律列在 §8 交 Lead 裁决 —— 不在这里悄悄改成
> 「实现的样子」。

## 1. 协议版本与稳定性承诺

这是 **v1**。v1 之内只做加法：

- 方法名、入参含义、每个返回结构的键、§3.4 的错误码、§4.4 的三条载荷约定，全部冻结；
- 允许**新增方法**，允许给 `MemoryRecord` / 召回命中**新增可选字段**（调用方必须忽略不认识的键，不要做穷举式校验）；
- 允许给 `write` / `recall` / `list` **新增可选入参**。

任何破坏上面这些的改动 —— 改名/删除方法、改变字段含义、把可选字段变成必填、改变参与去重指纹的输入 ——
都是**破坏性改动**：必须把协议版本升到 `v2`，单独发一版，并在 `CHANGELOG.md` 里说明。插件版本号仍按 patch 递增
（`0.5.16 → 0.5.17`）；协议版本与包版本相互独立。

要下线的方法必须在整个 v1 里照常可用，并先在本文件里标为「已废弃」。

本文写的是 **v1.3**。v1.1 是 v1.0 之上的**纯加法**：`list()` 多了可选的 `status` / `branch` / `limit`，`recall()`
多了两个可选过滤，`write()` 多了 `persisted` 字段，服务面的 `protocolVersion` 从 `'1.0'` 变成 `'1.1'`（§9）。
v1.2 则是 v1.1 之上的**又一次纯加法**：`list()` / `recall()` 的 `branch` 接受**分支数组**，`stats()` 多了 `writes`
计数，`write()` 的每个**成功**形状多了 `refs`，服务面的 `protocolVersion` 从 `'1.1'` 变成 `'1.2'`（§10）。
`'1.0'` / `'1.1'` 调用方依赖过的东西一样没动 —— 所有无参调用的返回值与 0.5.18 逐字节相同（§3.1、§3.3）。
v1.3 又是 v1.2 之上的**纯加法**：宿主可以通过服务面**注入嵌入器**（`setEmbedder`），`capabilities()` /
`lastRecall()` 是新增的只读方法，`stats()` 多了 `embedder` 诊断，`recall()` 多了可选的 `mode`（§11）。服务面的
`protocolVersion` 从 `'1.2'` 变成 `'1.3'`。`'1.0'` / `'1.1'` / `'1.2'` 调用方依赖过的东西一样没动 —— 没注册嵌入器时
所有调用与 0.5.19 逐字节相同，缺省 `recall({ mode: 'lexical' })` **零**嵌入调用（§3.3、§11）。

今天服务对象上**有** `protocolVersion`（`'1.3'`），调用方应当先读它再决定怎么用（未知版本给可读降级，不要崩）。
判断兼容性请用 `'1.x'` 谓词（`/^1\./u`），**不要**比字符串相等：v1.1 已经这样要求，v1.2 照办，v1.3 继续照办 —— 谁写成
`protocolVersion === '1.2'`，谁就会把自己锁在 `'1.3'` 门外；请只比前缀 / 主次版本。§9、§10 与 §11 的最小示例都是这么写的。

## 2. 服务定位方式与可选性

服务在 `apply()` 里**恰好注册一次**：

```ts
ctx.provide('memory', { protocolVersion, list, stats, recall, write, consolidate, setEmbedder, capabilities, lastRecall })
```

`setEmbedder` / `capabilities` / `lastRecall` 是 v1.3 的加法（§3.6、§11）；写着 `'1.2'` 的服务面根本没有它们。

定位方式：

```ts
const memory = ctx.get('memory')
```

下面三种情况 `ctx.get('memory')` 都是 `undefined`，调用方每一种都得处理：

| 情况 | 原因 |
|---|---|
| 这个 profile 里没装/没启用本插件 | 没有任何东西调用过 `provide` |
| 宿主没有 `provide` 接缝 | 注册包在 `try/catch` 里；插件在没有它的情况下照常工作 |
| 插件实例已被卸载 | 宿主不会回收引用，所以请自己丢掉旧引用，重载后重新获取 |

调用方的规矩：

1. **先探测，别假设。** `const memory = ctx.get('memory') as MemoryService | undefined; if (!memory) return`
   —— 静默降级；可选服务缺失不是错误。
2. **不要 import 类型。** 包只导出 `apply` / `Config` / `name` / `inject`，不导出服务类型；请按 §3 自己声明一个最小
   接口（这份文档就是为此存在的）。
3. **只有本文是接缝。** 工具注册、`/memory` 与 `/sleep` 的命令输出、开发期自报告文件、设置页表单、存储域的盘上布局
   都是内部实现，patch 版之间可能变。
4. **不要把引用缓存过插件重载**；也不要把 `list()` / `recall()` 返回的记录当副本改（它们是内存里的活对象，见 §8 缺口 5）。

## 3. 方法：签名 / 入参 / 返回结构 / 错误形状

服务对象的签名（实现体是内部的，语义以 §3.1–§3.6 为准）：

```ts
interface MemoryService {
  protocolVersion: string            // '1.3'
  list(options?: ListOptions): MemoryRecord[]
  stats(): {
    records: number
    version: number
    opened: boolean
    /** 新增：本进程内累计的写入落盘结果（v1.2）。 */
    writes: { persisted: number; unpersisted: number }
    /** 新增（v1.3）：嵌入器运行状况；没注册 / 没用过时 id 为 null、计数全 0。 */
    embedder: {
      id: string | null
      dimensions: number | null
      /** 嵌入调用次数（批量算一次）。 */
      calls: number
      /** 失败的调用次数（抛出 / reject / 形状或维度不对 / 超时）。 */
      errors: number
      /** 向量缓存命中 / 未命中（未命中＝真的调了 embed）。 */
      hits: number
      misses: number
      /** 因超时被放弃的次数（含在 errors 里）。 */
      timeouts: number
    }
  }
  recall(options: RecallOptions): Array<{ record: MemoryRecord; match: number; score: number }>
  write(input: WriteMemoryInput): Promise<WriteMemoryResult>
  consolidate(reason?: string): Promise<void>
  /** 新增（v1.3）：注册 / 替换 / 清除宿主注入的嵌入器；传 `null` 清除。插件只调用它，绝不自己联网或带模型。 */
  setEmbedder(embedder: Embedder | null): { ok: true; id: string | null } | { ok: false; error: string }
  /** 新增（v1.3）：能力探测 —— 调用方据此决定用不用语义，不要靠猜。 */
  capabilities(): {
    protocolVersion: string
    lexical: true
    /** 是否已注册可用的嵌入器。 */
    embedder: boolean
    /** 已注册的 id（未注册为 null）。 */
    embedderId: string | null
  }
  /** 新增（v1.3）：上一次 `recall()` 的诊断；一次都没调用过时为 `null`。 */
  lastRecall(): {
    mode: 'lexical' | 'semantic' | 'hybrid'
    used: boolean
    fallback: 'no-embedder' | 'embed-error' | 'timeout' | null
    candidates: number
    vectors: number
  } | null
}
```

### 3.1 `list()`

- **入参**：可选的 `options`；签名逐字冻结为：

```ts
list(options?: {
  /** 只看某个状态；`'all'` ＝ 不过滤（与今天一致）。缺省 = 'all'（**保持向后兼容**）。 */
  status?: 'active' | 'pending' | 'invalid' | 'archived' | 'all'
  /**
   * 分支过滤：
   *   `'current'`（字符串字面量）= 用**与注入完全相同的** `branchVisible` 口径过滤当前 cwd 的分支；
   *   其它字符串 = 只保留 `branchOf(record)` 等于该值的记录（外加无标签记录？**不**：只保留等于该值的）；
   *   数组（v1.2）= 只保留 `branchOf(record)` **落在数组里**的记录（无标签记录**不**算命中 —— 与单个字符串一致）；
   *   **空数组 ⇒ 空结果**（不是"不过滤"）；数组里的 `'current'` 按当前分支解析（等价于把当前分支名放进数组）；
   *   `null` = 不过滤。缺省 = 不过滤（向后兼容）。
   */
  branch?: 'current' | string | readonly string[] | null
  /** 最多返回几条（>=1；非法值忽略）。缺省 = 不限。 */
  limit?: number
}): MemoryRecord[]
```

| 键 | 默认 | 含义 |
|---|---|---|
| `status` | `'all'` | `'all'` = 不过滤（与今天完全一致）。其它值只保留 §4.3 状态等于该值的记录；`'active'` 因此**不含** `pending`。 |
| `branch` | 不给 | 不给 / `null` = 不过滤（今天的行为）。`'current'` 用**与注入完全相同**的 `branchVisible` 口径，按当前 cwd 过滤。其它字符串只保留 `branchOf(record)` 等于该值的记录 —— 无分支标签的记录**不会**被算进去。**v1.2：** 传**数组**时只保留 `branchOf(record)` **落在数组里**的记录（无标签同样不算命中）；**空数组 ⇒ 空结果**（**不是**「不过滤」）；数组里的 `'current'` 按当前分支解析（等价于把当前分支名放进数组）。 |
| `limit` | 不给 | 最多返回这么多条（`>= 1`；非法值忽略）。 |

- **返回**：过滤后仍留存的记录的新数组，按**插入顺序**（先加载、后写入）。**无参调用**返回内存库里的**全部**记录，
  与 0.5.17 逐字节相同：顺序、内容、活对象都不变 —— 不排序、不过滤。
- **影响面**：过滤只影响**返回集合**，不影响任何记录的状态。无参 `list()` 仍是那个能看到 `pending` / `invalid` /
  `archived` 的原始视图（显式 `recall({ status: … })` 是 v1.1 新增的第二道审计门 —— §3.3）。
- **错误形状**：无（只是造数组 + 过滤）。

### 3.2 `stats()`

- **入参**：无。
- **返回**：`{ records: number; version: number; opened: boolean; writes: { persisted: number; unpersisted: number }; embedder: { … } }`
  —— 即 v1.0 的三个键，加上 v1.2 的 `writes` 计数与 v1.3 的 `embedder` 块（§3.6、§11）。

| 字段 | 含义 |
|---|---|
| `records` | 内存中的记录条数（含全部状态，与 `list()` 同一集合） |
| `version` | 库版本号：每次成功的 put/delete 都 +1，可用来判断「有没有变」。**不是**存储 schema 版本 |
| `opened` | `ctx.storageDomain.open()` 是否成功。`false` 表示写入没有落到盘上（见 §8 缺口 3） |
| `writes`（v1.2 新增） | 本进程内累计的写入落盘结果。`persisted`：`persist()` 返回真的次数（真的落盘）；`unpersisted`：`ok: true` 但没落盘的次数（域未打开 / `put` 抛错）。计数**只加不减**，进程内累计、重启归零（与 `version` 同性质）。拒绝路径（`ok: false`）**不计入**这两个数 —— 那根本不叫写入。它与内部既有的 `state.writes` 计数器**并列存在、不复用**（既有计数器语义不同）。 |
| `embedder`（v1.3 新增） | 嵌入器运行状况：`id` / `dimensions`（未注册时为 `null`）、`calls`（批量算一次）、`errors`（抛出 / reject / 形状或维度不对 / 超时）、`hits` / `misses`（向量缓存；未命中＝真的调了 `embed`）、`timeouts`（同样计入 `errors`）。没注册嵌入器时所有计数恒为 `0`、`id` / `dimensions` 恒为 `null`，所以统计行与 0.5.19 完全一致。注册方式与语义见 §3.6、§11。 |

- **错误形状**：无。

### 3.3 `recall(options)`

- **入参**：`RecallOptions`；v1.1 新增两个可选键，v1.3 新增 `mode`，签名逐字冻结为：

```ts
interface RecallOptions {
  // …既有字段不变
  /** 状态过滤；缺省 = 今天的行为（active，`includeArchived: true` 时再含 archived）。 */
  status?: 'active' | 'pending' | 'invalid' | 'archived' | 'all'
  /** 分支过滤，语义与 `list` 的 `branch` 完全一致（v1.2 起同样接受数组；**空数组 ⇒ 空结果**）。缺省 = 不过滤（今天的行为）。 */
  branch?: 'current' | string | readonly string[] | null
  /** 新增（v1.3）：排序通道。缺省 `'lexical'` ＝ 与 0.5.19 逐字节相同，且零嵌入调用。 */
  mode?: 'lexical' | 'semantic' | 'hybrid'
}
```

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `query` | `string` | `''` | 相关性查询；空/不给 = 不做相关性过滤 |
| `kind` | `MemoryKind` | — | 按 kind 过滤 |
| `scopeLevel` | `'profile' \| 'workspace' \| 'session'` | — | 按 scope 层级过滤 |
| `tag` | `string` | — | 按标签精确过滤 |
| `limit` | `number` | `8` | 夹到 1…50 |
| `mode` | `'query' \| 'memory'` | `'query'` | 短查询 / 整轮用户消息 |
| `minLexical` | `number` | `0.34` | `mode: 'query'` 的阈值 |
| `minMatch` | `number` | `0.4` | `mode: 'memory'` 的阈值 |
| `minHits` | `number` | `2` | `mode: 'memory'` 的最少有信息量 token 命中数 |
| `includeArchived` | `boolean` | `false` | 同时纳入 `archived` 记录 |
| `status` | `'active' \| 'pending' \| 'invalid' \| 'archived' \| 'all'` | 不给 = 今天的候选集合 | 允许返回哪些 §4.3 状态。不给 = 今天的行为（`active`，外加 `includeArchived === true` 时的 `archived`）；`'all'` = active + pending + invalid + archived，排序不变；`'pending'` **是允许的** —— 这是显式的管理/审计查询（§9） |
| `branch` | `'current' \| string \| readonly string[] \| null` | 不给 = 不过滤 | 与 `list` 的 `branch` 语义完全一致（§3.1）：`'current'` = 注入自己那套 `branchVisible` 口径，按当前 cwd 过滤；其它字符串只保留 `branchOf(record)` 等于该值的记录；**v1.2：** 数组只保留 `branchOf(record)` 落在数组里的记录（无标签不算命中），**空数组返回空结果**；`null`/不给 = 不过滤 |
| `mode`（v1.3 新增） | `'lexical' \| 'semantic' \| 'hybrid'` | `'lexical'` | 用哪条通道给命中排序。`'lexical'` 就是今天的行为、与 0.5.19 完全一致：**根本不看 embedder，也不会产生任何嵌入调用**。`'semantic'` 只用嵌入相似度排序（词面只作为嵌入不可用时的兜底）。`'hybrid'` 用 `score = (1 - w) * lexical + w * semantic`，`w = cfg.embedderWeight`（默认 `0.5`）。没有可用嵌入器时，`'semantic'` / `'hybrid'` 返回词面结果并由 `lastRecall()` 明说原因（§3.6）—— 绝不静默 |

- **返回**：`Array<{ record: MemoryRecord; match: number; score: number }>`，按 `score` 降序、再按记录确定性顺序（§4.1）
  排序，截断到 `limit`。
  - `match` 是所选模式下的相关性（0…1）；`score` 是排序分（词面 + 重要度 + 时效）。
  - 候选集合：不给 `status` 时就是今天的集合 —— `status === 'active'` 恒在内，`includeArchived === true` 时再加上
    `archived`；**只有不给 `status` 时，无论其它入参怎么组合，`pending` 与 `invalid` 都永不返回。** 显式的
    `status: 'pending' | 'invalid' | 'all'` 是唯一能取到它们的门 —— 那是审计查询，绝不是注入路径（注入路径不传 `status`）。
- **错误形状**：任何入参形状都不抛（运行期容忍 options 缺席）。
- **回落必须说出来，绝不藏着（v1.3）。** 没注册嵌入器时，`mode: 'semantic'` 照样返回词面结果，且
  `lastRecall().fallback === 'no-embedder'`。嵌入器抛出 / reject / 超时 / 返回形状或维度不对时，计进
  `stats().embedder.errors`，并由 `lastRecall()` 如实报成 `'embed-error'` / `'timeout'`（§3.6）。这类失败
  绝不 reject 调用、绝不丢记忆、绝不让回合失败；`mode: 'lexical'` 与此完全无关，什么都不调用。

### 3.4 `write(input)`

- **入参**：`WriteMemoryInput`。服务面自 0.5.17 起做**最小校验**：`kind` 必须是六个枚举之一、`text` 必须是非空字符串，
  否则返回 `{ ok: false, error: 'rejected_invalid: …' }` 且不落盘（见 §8）。

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `kind` | `MemoryKind` | — | **必须给**：`user_profile` / `agent_self` / `project_gist` / `episodic` / `semantic` / `procedural`；同时决定默认 scope（§4.1） |
| `text` | `unknown` | `''` | 走 `String(...)` 强制转换；`trim()` 后为空 ⇒ `rejected_invalid` |
| `precision` | `'exact' \| 'gist'` | `'exact'` | |
| `origin` | `MemoryOrigin` | `'model_proposed'` | `user_explicit` / `user_correction` / `model_proposed` / `observed`；决定写入审批门与自画像配额 |
| `scope` | `{ level, key }` | 由 `kind` 决定 | |
| `subject` / `field` / `value` | `string \| null` | `null` | 归一化主题键 / 结构化键 / 结构化值 |
| `tags` | `string[]` | `[]` | |
| `source` | `MemorySource \| null` | `null` | 规则捕获的来源指针 `{ sessionId, seqStart, seqEnd }` |
| `confidence` / `importance` | `number` | `0.6` / `0.5` | 0…1 |
| `pinned` | `boolean` | `false` | 钉住的条目排最前 |
| `sessionId` | `string` | — | 喂给 `reinforcement.sessions` 与「重复提及」加成 |
| `facet` | `'persona' \| 'work'` | — | 仅 `agent_self` 有意义；**只有显式提供**才会走自画像收敛 |
| `refVia` | 见 §4.2 | — | 按跟踪到的事件序号推导本次写入的引用 |
| `refs` | `MemoryRef[]` | — | 显式引用；优先于 `refVia` |
| `branch` | `string` | — | 分支标签；不给 = 跨分支成立。改变它会**改变指纹**（§4.4） |

- **返回**：`WriteMemoryResult` 对象；成功与拒绝都是结构化结果（v1.1 给每个成功形状加了 `persisted`，v1.2 再加
  `refs`，逐字冻结为）：

```ts
type WriteMemoryResult =
  | { ok: true; status: 'created' | 'merged'; id: string; record: MemoryRecord; boosted?: number; /** 新增 */ persisted: boolean; /** 新增（v1.2） */ refs: string[] }
  | { ok: true; pending: true; id: string; text: string; /** 新增 */ persisted: boolean; /** 新增（v1.2） */ refs: string[] }
  | { ok: false; error: string }
```

| 形状 | 何时 |
|---|---|
| `{ ok: true, status: 'created', id, record, persisted, refs }` | 新记录已生效；`persisted` 说明是否真的到了存储域；`refs` 是它的机器可读引用串 |
| `{ ok: true, status: 'merged', id, record, boosted?, persisted, refs }` | 已有同指纹的 `active` 记录，就地更新 |
| `{ ok: true, pending: true, id, text, persisted, refs }` | `writePolicy: 'ask'` 把 `model_proposed` 写入排进队列；**没有 `status` 键**，什么都没生效 |
| `{ ok: false, error: '<code>: <message>' }` | 被拒；**既没有** `persisted` 键**也没有** `refs` 键；自画像收敛产出决策时会多一个 `portrait` |

  `record` 是完整落库记录（§4.1 的全部必填字段）。`portrait` 是内部收敛决策，**形状在 v1 不冻结** —— 除非在排查
  自画像写入，否则忽略它。
- **`persisted`（v1.1 新增）**：**这次写入是否真的落到了存储域**（`persist()` 成功）。领域未打开、或 `put` 抛错 ⇒
  `false`，而 `ok` 仍是 `true`。`ok` 的含义 —— 「过了闸门并写进了内存库（或排进队列）」—— **不变**，只是不再含糊。
  拒绝路径（`ok: false`）**不加**该字段；既有调用方忽略它即不受影响。
- **`refs`（v1.2 新增）**：本次写入后该记录携带的**机器可读引用串** —— 即 `refsToString(refsOf(record))` 的结果，
  无引用为 `[]`。调用方不必再读 `record` 就能拿到出处；`pending` 路径此前连 `record` 都没有，现在也有了出处。
  拒绝路径（`ok: false`）**不加**该字段；既有调用方忽略它即不受影响。
- **错误码**（`error` 一律是「错误码 + `": "` + 说明」）：

| 错误码 | 触发条件 |
|---|---|
| `rejected_sensitive` | `text` 含硬秘密（API key、私钥、密码、身份证/银行卡号） |
| `rejected_echo` | `origin: 'model_proposed'`，且 `text` 与刚注入的内容高度相似 |
| `rejected_write_policy` | `origin: 'model_proposed'` 而 `writePolicy === 'off'` |
| `rejected_by_user` | 该指纹被 `/memory reject` / `/memory reject-pending` 登记过 |
| `pending_queue_full` | 待确认条数达到 `pendingMax` |
| `rejected_invalid` | `text` 经 `trim()` 后为空 |
| `portrait_skipped` | `agent_self` + `facet`：收敛决定不应用这次写入 |

  只匹配**错误码前缀**。**说明文字在 v1 一律是中文** —— `language` 切换的是模型可见的工具文案，不是这些字符串，而说明
  文字本身可能在 patch 版里改写。
- **错误形状**：上面这些拒绝路径都不抛，返回结构化结果。Promise 被 reject 说明故障发生在这几条路径之外（例如宿主给的
  对象自己抛了）—— 按宿主故障处理，不要当成策略性拒绝。
- **`ok` 不代表「已落盘」。** 它的含义是「过了闸门并写进了内存库（或排进队列）」。v1.1 看上面的 `persisted`；
  面对 `'1.0'` 服务面时，告诉别人「记住了」之前先看 `stats().opened` 与这条记录有没有出现在 `list()` 里（见 §8 缺口 3）。

### 3.5 `consolidate(reason?)`

- **入参**：`reason?: string`，默认 `'manual'`（只用于自报告/摘要）。
- **返回**：`Promise<void>`，解析为 `undefined`。
- **行为**：家庭整理式维护 —— 合并同 subject 的近似条目、把冲突条目置 `invalid`、按衰减归档、重算项目印象、生成摘要、
  落盘用量。运行中重入的调用直接跳过；领域没打开时立即返回。
- **错误形状**：内部失败记录到 `state.consolidate.last` / 自报告里，不抛；实践中不会 reject。

### 3.6 `setEmbedder(embedder)` / `capabilities()` / `lastRecall()`（v1.3 新增）

- **`setEmbedder(embedder | null)`** 注册、替换，或（传 `null`）清除**宿主注入**的嵌入器。这是嵌入器进入本插件的
  **唯一**途径：插件自己绝不调用网络、绝不自带也不运行任何模型（§11）。校验是同步且穷尽的 —— `id` 必须是非空字符串、
  `embed` 必须是函数、`dimensions` 若给必须是 ≥1 的有限整数；不合法时返回 `{ ok: false, error: 'rejected_invalid: …' }`
  且**不改变**当前注册状态。成功返回 `{ ok: true, id }`（清除后 `id` 为 `null`）。
- **`capabilities()`** 是能力探测：`{ protocolVersion, lexical: true, embedder, embedderId }`。没注册之前 `embedder`
  恒为 `false`、`embedderId` 恒为 `null`；判断「能不能用语义打分」请看它（面对 `'1.2'` 服务面时先看
  `typeof memory.setEmbedder === 'function'`），不要靠猜、也不要只看配置 —— 配置可能开着混合模式而根本没有嵌入器。
- **`lastRecall()`** 描述**最近一次** `recall()`：请求的 `mode`、嵌入器是否真的参与了（`used`）、回落原因
  （`'no-embedder' | 'embed-error' | 'timeout' | null`）、参与排序的候选条数与可用向量数；一次都没调用过时为 `null`。
  调用方靠它得知「你要了语义、拿到的是词面，原因是……」而不必读内部实现，也正是它让 §0 第 5 条（绝不假装）可以从外部核查。

## 4. 数据模型

### 4.1 `MemoryRecord`

下面除标注可选外，键恒存在。调用方必须忽略不认识的键（§1）。

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `string` | 唯一 id，也是落盘 key |
| `kind` | `MemoryKind` | `user_profile` / `agent_self` / `project_gist` / `episodic` / `semantic` / `procedural` |
| `precision` | `'exact' \| 'gist'` | 原话 vs 大意 |
| `origin` | `MemoryOrigin` | `user_explicit` / `user_correction` / `model_proposed` / `observed` |
| `scope` | `{ level: 'profile' \| 'workspace' \| 'session'; key: string }` | 默认：`user_profile`/`agent_self` → `profile`；其余 → `workspace`（key 为 `'*'`）。`session` 级永不进常驻块 |
| `subject` | `string \| null` | 归一化主题键（自画像写入用 `self.<facet>.<key>`；key 缺失回落 `general`） |
| `field` / `value` | `string \| null` | 可选的结构化键值对；调用方不给就是 `null` |
| `text` | `string` | 单行正文（注入前由 `clampText` 压成一行） |
| `tags` | `string[]` | 默认 `[]`；带 `summary` 标签的条目不进常驻块 |
| `source` | `MemorySource \| null` | 规则捕获的来源指针 `{ sessionId, seqStart, seqEnd }` |
| `confidence` | `number` | 0…1 |
| `importance` | `number` | 0…1；排序主键 |
| `pinned` | `boolean` | 钉住的条目排最前 |
| `status` | `MemoryStatus` | §4.3 |
| `invalidAt` | `number \| null` | 置为 `invalid` 的时刻；restore 时复位为 `null` |
| `branch`（可选） | `string \| null` | `null`/缺失 = 跨分支成立。**参与指纹** |
| `supersedes` | `string[]` | 本条取代了哪些 id |
| `facet`（可选） | `'persona' \| 'work'` | 自画像面；缺失按 `'work'` 读 |
| `supersededBy`（可选） | `string` | 取代本条的那个 id |
| `refs`（可选） | `MemoryRef[]` | 可核验来源引用。**永不参与指纹** |
| `observedAt` | `number` | 插件观察到它的时间 |
| `eventTime` | `number \| null` | 事件时间（已知时） |
| `lastUsedAt` | `number \| null` | 最近一次被注入/使用 |
| `useCount` | `number` | 被注入/使用次数 |
| `reinforcement` | `{ sessions: string[]; count: number }` | 跨会话复现计数 |
| `hash` | `string` | 去重指纹（§4.4） |

确定性顺序（各处并列时的 tie-break）：`pinned` → `importance` → `confidence` → `id`。

### 4.2 `MemoryRef`

```ts
interface MemoryRef {
  sessionId: string
  from?: number          // 起始事件序号（含）
  to?: number            // 结束事件序号（含）；单点引用省略
  via?: 'live' | 'sleep' | 'tool' | 'command' | 'solidify' | 'import'
}
```

每条记录最多 `refsMax`（默认 5）个引用，**新在前**；`sessionId + from + to` 相同视为重复，只留一条。`via` 是写入路径：
`live` = 回合收尾规则捕获，`tool` = `memory_write`，`command` = 用户命令，`solidify` = 压缩摘要固化，`sleep` = `/sleep`
补录，`import` = 导入。显式 `input.refs` 优先于 `refVia`；`refsEnabled: false` 时完全不附着引用。

### 4.3 `status` 取值语义

| 取值 | 含义 |
|---|---|
| `active` | 唯一会参与注入与召回的取值 |
| `pending` | 被写入审批门（`writePolicy: 'ask'`）排队的条目，**在等用户确认**。不进注入、工具也列不出来；默认召回拿不到，**除非显式点名**（`list({ status: 'pending' })`、`recall({ status: 'pending' })`，属审计查询，§3.1/§3.3）；只有用户命令（`/memory approve`、`/memory confirm`）能让它变 `active` |
| `invalid` | 冲突落败方 / 被拒绝的待确认写入。默认不参与召回，连 `includeArchived` 也拿不到；只有显式 `status: 'invalid'`（或 `'all'`）查询能取到；可用 `/memory restore` 恢复 |
| `archived` | 不进注入，但 `includeArchived: true` 时仍可被检索（衰减归档与整合合并都落在这里） |

### 4.4 三条载荷级约定

这三条是这份文档存在的理由；`tests/protocol.test.ts` 里每条都有专门断言。

1. **`pending` 绝不进任何注入路径。** 常驻块（`section` + `context` 两条通道）不进、按轮召回不进、`recall()` 也不进 ——
   除非调用方显式传 `status: 'pending' | 'invalid' | 'all'`（§3.3），那是注入路径绝不会发出的审计查询（v1.1 起
   `list()` 也归入这一类）。`list()`、`recall({ status: … })` 与 `memory_explain` 的待确认区是诊断路径，能看到它。
   实现方式是每条读取路径都按 `status === 'active'` 过滤 —— 不给「这是模型自己提的」留任何例外。
2. **`refs` 不进指纹。** 两次写入若 kind/scope/subject/text 相同而引用不同，结果是**同一条**记录（第二次返回
   `status: 'merged'`），两次的引用会并进这一条。否则同一条记忆会因为来源不同被判成两条，去重与幂等一起失效。
3. **`branch` 进指纹**，但只在这条记录确实带非空分支标签时追加（`...(branch ? [branch] : [])`）。于是「哪儿都成立的约定」
   与「只在 `feature/x` 成立的临时约定」是两条记录，而**没有标签的记录指纹与加这个功能之前完全一致**。无条件拼上 branch
   会让全库指纹集体改变，去重、`/sleep` 补录幂等与 `write` 幂等会同时失效。

指纹本身是 `kind | scope.level | scope.key | subject | 归一化正文 [| branch]` 的 FNV-1a 哈希。它**不是**文档化的稳定格式：
只用来判等，不要解析，也不要把指纹当 id 存下来。

## 5. 配置面：volatile 与 patch 行

两个入口，区别很重要：只有配置 schema 里声明为 `volatile()` 的键会被投影到 DSH 设置页、可以在页面上改（热生效）；
其余键只能通过 profile 的 `cordis.patch.yml`（或本插件的配置行）设置，且需要重载。

**volatile（进设置页，30 个键）：**

```text
domainName, maxInjectedTokens, maxItemTokens, selfPortraitMaxTokens, selfPortraitEnabled,
selfPersonaMaxTokens, selfPortraitMergeThreshold, selfReflectEnabled, selfReflectEveryTurns,
selfReflectMinTurn, selfReflectMaxPerSession, selfIntroEnabled, selfIntroMinTurn, selfIntroMaxAsks,
sleepEnabled, sleepSessions, sleepMaxBackfill, refsEnabled, refsMax, branchAware, recallMode,
recallTopK, captureMode, captureMaxPerTurn, consolidateEnabled, consolidateIntervalMinutes,
writePolicy, pendingMax, language, auditMax
```

**只能走 patch 行** —— `DEFAULTS` 里其余全部（`sleepMaxCharsPerSession`、`sleepMaxCharsTotal`、
`sleepAssistantContext`、`sleepMaxGists`、`reportPath`、`seed`、`piiPolicy`、`captureMinConfidence`、
`capturePerHour`、`captureTimeoutMs`、`echoThreshold`、`gistBudgetRatio`、`charsPerToken`、`sectionOrder`、
`contextOrder`、`trustToolWrites`、`autoRecall`、`recallMin*`、`recallCooldownTurns`、`recallBudgetMs`、
`mergeSimilarity`、`archiveAfterDays`、`archiveBelowImportance`、`summarizeAbove`、
`solidificationMaxPerCompaction`、`selfPortraitMaxItems`、`selfPortraitMaxSelfObserved`、
`selfPortraitMinConfidence`、`selfPortraitModelMinConfidence`、`selfPortraitPromoteSessions`、
`consolidateMaxRecords`、`repeatMentionBoost`、`gistMinMarkers` ……），再加上根本没进 schema 的键：
`exportDir`、`simulateCaptureError`、`simulateAuditError`、`revision`。

一个会漏到服务面上的运行期细节：volatile 字段由宿主以**访问器对象**（`{ get(): T }`）下发，插件读之前会解包。服务调用方
看不到这一层 —— 它的意义只是「在设置页改 volatile 键不需要重载」。
默认值就是 `src/lib.ts` 的 `DEFAULTS`；出厂的是 `writePolicy: 'auto'`、`recallMode: 'inject'`、`language: 'zh'`、
`branchAware: true`、`seed: false`。

## 6. 最小可用调用示例

服务类型没有导出，请自己声明用到的那一小片：

```ts
/** 本调用方需要的 protocol v1 切片；见 docs/protocol-v1.zh.md §3–§4。 */
interface MemoryService {
  recall(options: { query?: string; kind?: string; limit?: number }):
    Array<{ record: { id: string; text: string; status: string; importance: number }; match: number; score: number }>
  write(input: { kind: string; text: string; subject?: string; importance?: number }):
    Promise<{ ok: boolean; status?: 'created' | 'merged'; id?: string; pending?: boolean; error?: string }>
  stats(): { records: number; version: number; opened: boolean }
}

export function injectProjectConventions(ctx: { get(name: string): unknown }, cwd: string | null): string {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) return ''                       // 可选服务：静默降级
  const hits = memory.recall({ query: '构建工具链', kind: 'semantic', limit: 3 })
  if (hits.length === 0) return ''
  return ['## 项目约定', ...hits.map((hit) => `- ${hit.record.text}`)].join('\n')
}

export async function remember(ctx: { get(name: string): unknown }, text: string): Promise<boolean> {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) return false
  const result = await memory.write({ kind: 'semantic', text, subject: 'build.tool' })
  // ok:true 且 pending:true 表示「已提议、等用户确认」，不是「记住了」。
  // 只有 ok:true 也不代表落盘：v1.1 看 result.persisted（§3.4），否则看 memory.stats().opened。
  return result.ok === true && result.pending !== true
}
```

`ctx.get('memory')` 要在 step / effect 里调用（那时服务才是活的），插件重载后要重新获取。

## 7. 兼容性矩阵

| 依赖 | 状态 | 说明 |
|---|---|---|
| Node.js | `>= 22`（package `engines`） | 22.18+ 靠原生类型剥离直接跑 `.ts` 源码；更早的 22.x 需要 `--experimental-strip-types`。发布的 `lib/*.js` 两者都能跑 |
| DSH 宿主 | 只依赖实测运行契约 | `inject = ['agents', 'systemPrompt', 'storageDomain', 'tools', 'commands']`；`commands`/`agents` 缺席只是注册降级，不抛 |
| `ctx.storageDomain` | **强烈建议提供** | 没有它插件照样加载、服务照样作答，但 `stats().opened === false`，什么都不会持久化（§8 缺口 3） |
| `ctx.provide` 接缝 | 可选 | 缺席 ⇒ `ctx.get('memory')` 恒为 `undefined`（§2） |
| `ctx.get('sessionQuery')` | 可选 | 只有 `/sleep` 与引用核对需要；缺失时这两条路径给出说明后降级，不抛 |
| 客户端半边（`dsh.client` / `lib/client.js`） | 可选 | 只负责设置页表单与预览；没有它，宿主半边的全部服务面照常工作 |
| `@deepseek-ai/schemastery` | 可选 peer | 不可用时整个 `Config` schema 被丢弃（或退化成不带 volatile 的版本）；服务面不受影响 |
| 运行期依赖 | **零** | `dependencies` 为空；发布包发的是 `lib/`，不是 `src/` |
| 外接嵌入器（`setEmbedder`） | **可选** | 默认什么都不注入：没注册嵌入器时所有调用与 0.5.19 逐字节相同，召回路径**零**嵌入调用。插件绝不联网、绝不自带模型；是否把记忆正文发给外部服务、发去哪里、留不留日志，由宿主 / 用户决定，不是插件的决定（§3.6、§11） |
| 协议版本字段 | 有：`'1.3'` | §1、§9、§10、§11；用 `'1.x'` 谓词（`/^1\./u`）判断，不要比字符串相等。写着 `'1.2'` 的服务面只是没有 v1.3 的新键（嵌入器注入、`capabilities()`、`lastRecall()`、`stats().embedder`、`recall` 的 `mode`）；写着 `'1.1'` 的连 v1.2 的新键（数组 `branch`、`stats().writes`、`write` 的 `refs`）也没有；`'1.0'` 的连 v1.1 的键也没有 |

## 8. 缺口与已声明行为（2026-10-03 集成时复核）

2026-10-03 照实现读出来的清单；`tests/protocol.test.ts` **不**把其中任何一条断言成「正确」，这里也不在 `src/` 里绕开它们。

**集成时已修（3 条）**：
- ~~1. 服务面没有 `protocolVersion`~~ → **已加** `protocolVersion`（加法；§1 的稳定性承诺不变）；v1.1 的加法之后读出来是 `'1.1'`（§9）。
- ~~4. `write` 不校验入参~~ → **已在服务面补最小校验**：`kind` 必须是六个枚举之一、`text` 必须是非空字符串，
  否则返回 `{ ok: false, error: 'rejected_invalid: …' }` 且**不落盘**。工具侧原本有 JSON Schema 兜着，服务面此前没有，
  于是第三方能写出 `kind: undefined` 的记录 —— 现在是结构化拒绝。
- ~~7. 协议文档不在发布包里~~ → **`package.json` 的 `files` 现在发整个 `docs/`**（v1.0 时只列了两份协议文档；§9）。

**保留为「已声明行为」（不是缺陷，但调用方必须知道）**：

2. **`list()` 与 `recall()` 默认是未过滤的原始视图。** 两者直接读 `state.records.values()`，而所有注入路径都过
   `branchVisible(...)`。于是 `branchAware: true` 时，第三方通过 `ctx.memory` 能看到别的分支的带标签记录，尽管这些记录
   被正确地挡在提示之外。**裁决：默认保持原始视图**（服务面是管理/审计视角，默认过滤会让第三方无法看全库）。v1.1 加的是
   可选开关、不是改默认：无参仍是原始视图；`list({ status })` / `recall({ status })` 按 §4.3 状态过滤，`list({ limit })`
   截断条数，`list({ branch: 'current' })` / `recall({ branch: 'current' })` 用**注入自己那套** `branchVisible` 口径。
   除 `'current'` 之外的视角请自行用 `branchOf(record)` 过滤（`lib` 有导出）。
3. **`write` 在什么都没落盘时也报 `ok: true`。** 领域没打开时 `persist()` 在**写进内存库之前**就返回 `false`：结果依然是
   `{ ok: true, status: 'created', id, record, persisted: false }`，而 `list()` 是空的、`stats().opened` 是 `false`。如果
   `put` 自己抛了，记录留在内存但没在盘上，同样是 `ok: true`。所以 `ok` 的含义是「已在内存生效」，不是「已持久化」——
   **裁决：保留 `ok` 语义 —— 现在已写进契约、不再含糊**：v1.1 的 `persisted`（§3.4）说明这次写入有没有到存储域，
   `stats().opened` 与 `version` 仍是看存储域自身状态的方式。
5. **`list()` / `recall()` 返回的是活对象。** 它们就是插件自己会改的那些引用（`useCount`、`lastUsedAt`、合并结果）。
   读是安全的；往里写是未定义行为，而且不会自行落盘。
6. **`list()` 不排序，且无参时不过滤。** 只有插入顺序，无参调用含 `pending`/`invalid`/`archived`。v1.1 新增的是可选
   `status` / `branch` / `limit` 过滤（§3.1），默认不变。想要「注入看到的样子」，请自己按 §4.3 + §4.4 复现，或者直接传
   `branch: 'current'` —— 那正是注入自己那套分支口径。

## 9. v1.1 的加法

v1.1 是 v1 之内的**纯加法**：服务面的 `protocolVersion` 从 `'1.0'` 变成 `'1.1'`，0.5.17 能用的调用行为全部照旧
（无参 `list()` 逐字节不变）。三处服务面新增 + 一处发布包变化：

| # | 新增 | 位置 |
|---|---|---|
| 1 | `list(options?)` —— 可选 `status` / `branch` / `limit`；无参 = v1.0 的原始视图 | §3.1 |
| 2 | `recall(options)` —— 可选 `status` / `branch`。`status: 'pending'` 是显式的审计门；注入路径不传 `status`，行为不变 | §3.3 |
| 3 | `write(input)` —— 每个**成功**形状都带 `persisted: boolean`。`ok: true` 仍是「已在内存生效」，`persisted` 才是「已落盘」。拒绝路径**没有**这个键 | §3.4 |
| 4 | 发布包 —— `package.json` 的 `files` 从「两份协议文档」改为发**整个 `docs/`**（refs / self-portrait / sleep / write-policy / audit / branch / i18n / trace / semantic / dsh-mechanisms 以及两份协议） | §8 第 7 条 |

**版本请用 `'1.x'` 谓词判断，不要比字符串相等** —— 以后出 `1.2` 不能把调用方锁在门外（v1.2 已经落地，正是这个
谓词让旧调用方继续可用）；还写着 `'1.0'` 的服务面只是少了那三个可选键：

```ts
/** 本调用方用到的切片；服务类型没有导出（见 §6）。 */
interface MemoryService {
  protocolVersion?: string
  list(options?: { status?: string; branch?: string | null; limit?: number }): Array<{ id: string }>
  recall(options?: { query?: string; status?: string; branch?: string | null }): Array<{ record: { id: string } }>
  write(input: { kind: string; text: string }): Promise<
    { ok: true; pending?: boolean; persisted?: boolean } | { ok: false; error: string }
  >
}

export function memoryService(ctx: { get(name: string): unknown }): MemoryService | null {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) return null                                  // 可选服务：静默降级（§2）
  const version = memory.protocolVersion
  // '1.0'、'1.1' 以及之后所有 '1.x' 都放行；未知主版本拒绝，不要猜。
  if (version !== undefined && !/^1\./u.test(version)) return null
  return memory
}

export async function remember(ctx: { get(name: string): unknown }, text: string): Promise<boolean> {
  const memory = memoryService(ctx)
  if (!memory) return false
  const v11 = memory.protocolVersion !== undefined && memory.protocolVersion !== '1.0'
  if (v11) {
    // 只有 v1.1 才有的可选入参：版本判断通过后再传（其它地方记得忽略不认识的键）。
    const active = memory.list({ status: 'active', limit: 20 })
    if (active.length === 0) return false
  }
  const result = await memory.write({ kind: 'semantic', text })
  // ok = 「已在内存生效」；persisted（v1.1）= 「已落盘」。v1.1 之前的服务面直接不返回 persisted。
  return result.ok === true && result.persisted !== false
}
```

本文其余部分 —— §2 的可选性、§4 的数据模型与三条载荷约定、§5 的配置面 —— 都是 v1.0 的内容，v1.1 没有改动。

## 10. v1.2 的加法

v1.2 是 v1 之内的**纯加法**：服务面的 `protocolVersion` 从 `'1.1'` 变成 `'1.2'`，0.5.18 能用的调用行为全部照旧
（无参 `list()` 逐字节不变）。三处服务面新增：

| # | 新增 | 位置 |
|---|---|---|
| 1 | `list(options?)` / `recall(options)` —— `branch` 现在也接受**分支数组**（`'current' \| string \| readonly string[] \| null`）。字符串与 v1.1 完全一致；数组只保留 `branchOf(record)` **落在数组里**的记录（无标签记录**不**算命中）；**空数组 ⇒ 空结果** —— 这**不是**「不过滤」；`null`/不给 = 不过滤（不变）；数组里的 `'current'` 按当前分支解析 | §3.1、§3.3 |
| 2 | `stats()` —— 新增 `writes: { persisted: number; unpersisted: number }`：本进程内累计的写入落盘结果。`persisted` = `persist()` 返回真；`unpersisted` = `ok: true` 但没落盘。计数只加不减、重启归零，拒绝（`ok: false`）不计入 | §3.2 |
| 3 | `write(input)` —— 每个**成功**形状都带 `refs: string[]`（该记录的机器可读引用串，无引用为 `[]`），`pending` 路径也有。`ok: true` 仍是「已在内存生效」，`persisted` 仍是「已到存储域」。拒绝路径两个键都没有 | §3.4 |

**版本请用 `'1.x'` 谓词判断，不要比字符串相等**（§1）—— 以后出 `1.3` 不能把调用方锁在门外；还写着 `'1.1'` 的
服务面只是少了 v1.2 的新键：

```ts
/** 本调用方用到的切片；服务类型没有导出（见 §6）。 */
interface MemoryService {
  protocolVersion?: string
  list(options?: { branch?: 'current' | string | readonly string[] | null; limit?: number }):
    Array<{ id: string; text: string }>
  write(input: { kind: string; text: string }): Promise<
    { ok: true; pending?: boolean; persisted?: boolean; refs?: string[] } | { ok: false; error: string }
  >
  stats(): { records: number; version: number; opened: boolean; writes?: { persisted: number; unpersisted: number } }
}

export function memoryService(ctx: { get(name: string): unknown }): MemoryService | null {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) return null                                  // 可选服务：静默降级（§2）
  const version = memory.protocolVersion
  // 用 '1.x' 谓词，绝不写 `version === '1.2'`：以后的小版本不能把调用方锁在门外。
  if (version !== undefined && !/^1\./u.test(version)) return null
  return memory
}

/** 空分支列表就是故意返回空 —— 它**不是**「所有分支」（§3.1、§10）。 */
export function listOnBranches(ctx: { get(name: string): unknown }, branches: readonly string[]): number {
  const memory = memoryService(ctx)
  return memory ? memory.list({ branch: branches }).length : 0
}

export async function rememberAndProve(ctx: { get(name: string): unknown }, text: string): Promise<boolean> {
  const memory = memoryService(ctx)
  if (!memory) return false
  // v1.2：`stats().writes` 是「这次写入真的落盘了」的**唯一凭据**。`ok: true` 仍只代表
  // 「已在内存生效」（§3.4），所以要在调用前后比较计数。
  const before = memory.stats().writes?.persisted
  const result = await memory.write({ kind: 'semantic', text })
  if (result.ok !== true) return false                      // rejected_* ⇒ 什么都没写
  const after = memory.stats().writes?.persisted
  if (before !== undefined && after !== undefined) return after > before   // v1.2 服务面
  return result.persisted !== false                         // '1.1' 回退：看 persisted 字段
}
```

本文其余部分 —— §2 的可选性、§4 的数据模型与三条载荷约定、§5 的配置面、§6 的示例 —— 都是 v1.0 / v1.1 的内容，
v1.2 没有改动，v1.1 的默认行为也一条没动：无参 `list()` 仍是原始视图，`stats().records` / `version` / `opened`
含义不变。

## 11. v1.3 的加法

v1.3 是 v1 之内的**纯加法**：服务面的 `protocolVersion` 从 `'1.2'` 变成 `'1.3'`，0.5.19 能用的调用行为全部照旧 ——
没注册嵌入器时无参 `list()` 逐字节不变，缺省 `recall({ mode: 'lexical' })` **零**嵌入调用。四处服务面新增：

| # | 新增 | 位置 |
|---|---|---|
| 1 | `setEmbedder(embedder \| null)` —— 注册 / 替换 / 清除**宿主注入**的嵌入器。不合法对象被拒（`rejected_invalid: …`），且不改变当前注册状态 | §3.6 |
| 2 | `capabilities()` —— `{ protocolVersion, lexical: true, embedder: boolean, embedderId: string \| null }`；判断能不能用语义打分的**唯一正确方式** | §3.6 |
| 3 | `stats().embedder` —— `{ id, dimensions, calls, errors, hits, misses, timeouts }`；未注册嵌入器时全为 `0` / `null` | §3.2 |
| 4 | `recall({ mode })` —— `'lexical'`（缺省，行为不变）/ `'semantic'` / `'hybrid'`，外加用于诊断回落与用量的 `lastRecall()` | §3.3、§3.6 |

嵌入器契约本身 —— 宿主实现并注入的那个形状：

```ts
/** 宿主注入的嵌入器（协议 v1.3）。插件只调用它，不关心它背后是什么。 */
export interface Embedder {
  /** 非空标识，用于 stats 与诊断（例如 'local-minilm' / 'openai:text-embedding-3-small'）。 */
  id: string
  /** 向量维度（可选）：给了就用于快速校验，省一次全量比对。 */
  dimensions?: number
  /** 批量嵌入：输入 N 段文本，返回 N 个向量（长度相等、顺序一致）。 */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}
```

四个配置键（`MemoryConfig`，默认值见 `src/lib.ts` 的 `DEFAULTS`；它们与其它键走同样的配置入口 —— patch 行或本插件的
配置行 —— 不改变任何既有键的含义）：

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `embedderRecallMode` | `'off' \| 'recall'` | `'off'` | 按轮召回是否使用混合打分（需已注册 embedder） |
| `embedderWeight` | number | `0.5` | 混合模式里语义分的权重（0..1，非法回落默认） |
| `embedderTimeoutMs` | number | `200` | 单次嵌入调用超时 |
| `embedderCacheMax` | number | `2000` | 向量缓存条数上限（LRU；0 = 不缓存） |

这次加法不许破坏的五条（冻结契约 §0，在这里原义复述、不弱化）：

1. **插件绝不自己调用网络或模型。** 它只调用被注入的 `embed` 函数；是否把记忆正文送去外部服务，是**宿主/用户**
   的决定 —— 文档必须把这句话写给用户看。
2. **没注入 embedder 时，一切与 0.5.19 逐字节相同** —— 包括注入路径、召回排序与统计行。
3. **谁都不默认拿到**：`embedderRecallMode` 默认 `'off'`；只有宿主显式打开、**且**确实注册了 embedder，才会用混合打分。
4. **失败绝不冒泡**：嵌入器抛错 / reject / 超时 / 返回形状不对 / 维度不一致 ⇒ 记一次错误、**回落词面**，不抛给回合、
   不写坏记录。任何情况下都不能因为嵌入失败而丢记忆或让回合失败。
5. **绝不假装**：没有 embedder 时 `recall({ mode: 'semantic' })` 回落词面，并在 `lastRecall()` 里明说
   （`fallback: 'no-embedder'`），而不是静默给出词面结果却让调用方以为用了语义。

> **隐私。** 插件**自己绝不联网、绝不自带也不运行任何模型**；它只调用宿主注入的 `embed` 函数。是否把记忆正文发送给
> 外部服务、**发去哪里**、留不留日志，**由宿主与用户决定** —— 插件不做这个决定，也不能替他们做这个决定。

本文其余部分 —— §2 的可选性、§4 的数据模型与三条载荷约定、§5 的配置面、§6 的示例 —— 都是 v1.0 / v1.1 / v1.2 的
内容，v1.3 没有改动，更早的默认行为也一条没动：无参 `list()` 仍是原始视图，`stats().records` / `version` /
`opened` / `writes` 含义不变。
