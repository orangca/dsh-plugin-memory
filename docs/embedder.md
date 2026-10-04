# 外接嵌入器（embedder）—— 协议 v1.3（冻结签名）—— M18

> 用户裁决：语义检索走**第 3 条路** —— 插件**不自带模型、不联网、零运行期依赖**，
> 而是允许宿主通过服务面**注入一个嵌入函数**；没注入就自动回落今天的词面检索。
> 纯加法：`protocolVersion` `'1.2'` → `'1.3'`。

## 0. 不可妥协（先看这条）

1. **插件绝不自己调用网络或模型。** 它只调用被注入的 `embed` 函数；是否把记忆正文送去外部服务，
   是**宿主/用户**的决定。文档必须把这句话写给用户看。
2. **没注入 embedder 时，一切与 0.5.19 逐字节相同**（包括注入路径、召回排序、统计行）。
3. **注入路径默认不用语义**：新配置 `embedderRecallMode` 默认 `'off'`；只有宿主显式打开、
   **且**确实注册了 embedder，才在按轮召回里使用混合打分。
4. **失败绝不冒泡**：embedder 抛错 / reject / 超时 / 返回形状不对 / 维度不一致 ⇒ 记一次错误、**回落词面**，
   不抛给回合、不写坏记录。任何情况下都不能因为嵌入失败而丢记忆或让回合失败。
5. **绝不假装**：`recall({ mode: 'semantic' })` 在没有 embedder 时**回落词面**，并在返回元数据里**明说**
   `fallback: 'no-embedder'`（不要静默给出词面结果却让调用方以为用了语义）。

## 1. 类型（`src/types.ts`，Lead 加）

```ts
/** 宿主注入的嵌入器（协议 v1.3）。插件只调用它，不关心它背后是什么。 */
export interface Embedder {
  /** 非空标识，用于 stats 与日志（例如 'local-minilm' / 'openai:text-embedding-3-small'）。 */
  id: string
  /** 向量维度（可选）：给了就用于快速校验，省一次全量比对。 */
  dimensions?: number
  /** 批量嵌入：输入 N 段文本，返回 N 个向量（长度必须相等、顺序一致）。 */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}
```

## 2. 服务面新增（`src/index.ts`）

```ts
/** 注册 / 替换 / 清除嵌入器。传 null 清除。 */
setEmbedder(embedder: Embedder | null): { ok: true; id: string | null } | { ok: false; error: string }

/** 能力探测：调用方据此决定用不用语义（不要靠猜）。 */
capabilities(): {
  protocolVersion: string
  lexical: true
  /** 是否已注册可用的 embedder。 */
  embedder: boolean
  /** 已注册的 id（未注册为 null）。 */
  embedderId: string | null
}

stats(): {
  // …既有字段不变（records / version / opened / writes）
  /** 新增：嵌入器运行状况。 */
  embedder: {
    id: string | null
    dimensions: number | null
    /** 嵌入调用次数（批量算一次）。 */
    calls: number
    /** 失败的嵌入调用次数（抛出 / reject / 形状或维度不对 / 超时）。 */
    errors: number
    /** 向量缓存命中 / 未命中（未命中＝真的调了 embed）。 */
    hits: number
    misses: number
    /** 因超时被放弃的调用次数（含在 errors 里）。 */
    timeouts: number
  }
}
```

`setEmbedder` 校验（不合法 ⇒ `{ ok: false, error: 'rejected_invalid: …' }`，且**不改变**当前注册状态）：
`id` 非空字符串；`embed` 是函数；`dimensions` 若给必须是 ≥1 的有限整数。

## 3. `recall(options)` 新增

```ts
mode?: 'lexical' | 'semantic' | 'hybrid'   // 缺省 'lexical'（＝今天的行为）
```

- `'lexical'`：**与 0.5.19 逐字节相同**（不走 embedder、不产生任何嵌入调用）。
- `'semantic'`：只用嵌入相似度排序（词面只作为**兜底**：嵌入不可用时回落词面）。
- `'hybrid'`：`score = (1 - w) * lexical + w * semantic`，`w = cfg.embedderWeight`（默认 0.5）。
- 返回元数据（`ctx.memory.recall` 的返回结构是 `RecallHit[]`，为保持签名兼容，
  **命中结构不改**；把回落与用量通过 `stats().embedder` 与新增的 `lastRecall` 诊断暴露：
  ```ts
  lastRecall(): { mode: 'lexical'|'semantic'|'hybrid'; used: boolean; fallback: 'no-embedder'|'embed-error'|'timeout'|null; candidates: number; vectors: number } | null
  ```
- **超时**：每个嵌入调用受 `cfg.embedderTimeoutMs`（默认 200）约束，超时按失败处理并计 `timeouts`。
- **返回类型与实现一致（重要）**：`recall()` 只有**确实要调嵌入**时才异步 ——
  ```ts
  recall(options): RecallHit[] | Promise<RecallHit[]>   // 不走嵌入 ⇒ 同步数组；要调 embed ⇒ Promise
  ```
  也就是「先看这次会不会真的调 `embed`」：
  - **缺省、显式 `'lexical'`、以及非法/未知 `mode` 值** ⇒ **同步返回数组**（一次嵌入调用都不会发生）；
  - **`mode: 'semantic' | 'hybrid'` 且未注册 embedder** ⇒ **也是同步数组**：没有东西可嵌入 ⇒ **同步**回落词面，
    并在 `lastRecall()` 里如实报 `fallback: 'no-embedder'`。实现里这就是一条同步的提前返回
    （`if (embedderState.current === null) return lexicalHits(mode, 'no-embedder')`）。
    别写成「未注册时 semantic 返回 Promise」—— 与实现不符；
  - **`mode: 'semantic' | 'hybrid'` 且已注册 embedder** ⇒ **`Promise`**（`embed` 按契约就是异步的），
    resolve 出来还是 `RecallHit[]`。
  - 调用方如果不确定拿到的形状，`await` 一次最省事：`await` 一个数组是合法且无副作用的。
  - **签名的兼容性没变**：v1.3 之前 `recall` 就是同步的，所以没有 embedder 的老调用方行为一字未动；
    只有「注册了 embedder 又显式要语义」的调用方需要 `await`。

## 4. 配置（`src/types.ts` 的 `MemoryConfig`，Lead 加）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `embedderRecallMode` | `'off' \| 'recall'` | `'off'` | 按轮召回是否使用混合打分（需已注册 embedder） |
| `embedderWeight` | number | `0.5` | 混合模式里语义分的权重（0..1，非法回落默认） |
| `embedderTimeoutMs` | number | `200` | 单次嵌入调用超时 |
| `embedderCacheMax` | number | `2000` | 向量缓存条数上限（LRU；0 = 不缓存） |

## 5. `src/lib.ts` 新增（纯函数，无 I/O、无 async）

```ts
/** 单位化（零向量原样返回空数组语义：返回全 0 向量，调用方按 0 相似度处理）。 */
export function normalizeVector(vector: readonly number[]): number[]
/** 余弦相似度；维度不等、含非有限数、空向量 ⇒ 返回 null（调用方据此判"不可用"）。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null
/** 混合打分：`(1-w)*lexical + w*semantic`，两个输入都 clamp 到 0..1；w 非法回落 cfg 默认。 */
export function blendScores(lexical: number, semantic: number | null, weight: number): number
/** 向量缓存的键：记录内容指纹（用既有 hash，不要新算法）。 */
export function vectorKeyOf(record: MemoryRecord): string
```

## 6. 验收标准

- `pnpm typecheck` 四套全绿；`pnpm test` 全绿（现有 **334** 项不许回退）。
- lib 测试：`normalizeVector`（含零向量）、`cosineSimilarity`（正交/同向/反向/维度不等/NaN ⇒ null）、
  `blendScores`（权重 0/1/非法、semantic 为 null 时回落词面）、`vectorKeyOf`（同内容同键、不同内容不同键）。
- host 测试：`setEmbedder` 校验（拒绝时不改状态）、`capabilities()`、`recall({mode:'lexical'})` 与 0.5.19 等价且
  **零嵌入调用**、`semantic`/`hybrid` 在注册后生效、**未注册时回落并如实标记 fallback**、
  embedder 抛错/超时/形状错/维度错 ⇒ 不抛且计 errors、缓存命中不重复调用（hits/misses 数字）、
  `embedderRecallMode:'recall'` 时按轮召回用混合、默认 `'off'` 时注入路径与 0.5.19 逐字节相同。
- 协议套件：`protocolVersion === '1.3'`、五个新方法/字段存在且形状正确、未注入时 `capabilities().embedder === false`、
  **返回类型与 §3 一致**（缺省/`'lexical'` 同步数组；`'semantic'`/`'hybrid'` 在注册后返回 Promise，
  未注册时仍是同步数组 + `fallback: 'no-embedder'`）。
- 文档：两份协议文档加 **§11 v1.3 的加法**（含"插件不联网、是否外发由宿主决定"的隐私说明），两版**逐节对齐**；
  README 两份加一节「外接嵌入器（可选）」并**中英对齐**（`pnpm check:readmes` 会验）。
- `pnpm verify:self-contained` 继续保持通过（**零运行期依赖**这条不能被破坏）。
