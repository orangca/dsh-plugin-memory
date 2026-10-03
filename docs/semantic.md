# 检索质量升级（零依赖的"准语义"）—— M15-B

> README 的「已知限制」里写着：检索是**词面**的，不做语义/向量检索。这是实话，但也是可以推进的一格：
> 我们不引入嵌入模型（零运行期依赖是硬约束），而是把**词面检索本身做到该有的水平** ——
> 中文按 bigram 切、英文做轻量词形归并、用 IDF 加权而不是等权命中率、按长度归一化。
> 效果必须**用现成的评测工具量出来**（`tools/eval-recall.ts`），不是靠感觉说"更好了"。
> 本文是接口契约（签名冻结）。

## 1. 目标与不变量

| 目标 | 说明 |
|---|---|
| 中文召回更稳 | 中文无空格，单字切分噪声大；**bigram + 单字兜底**是零依赖下的标准做法 |
| 英文词形归并 | `build` / `building` / `builds` 应当互相命中（轻量后缀剥离，不引入词干库） |
| 权重更合理 | 稀有 token（`idf` 高）比烂大街 token 更能说明匹配；现在是等权命中率 |
| 长度归一化 | 长文本天然命中更多 token，不应因此压过短而精准的记忆 |
| **默认行为可解释** | `memory_explain` 必须能说清"这段话命中了哪些 token、各多少分" |

**硬不变量**（不可妥协）：
- **零运行期依赖**：`pnpm verify:self-contained` 必须继续通过（不得引入任何运行期包）。
- **性能不许退化**：`recallBudgetMs`（默认 10ms）在 2000 条记录规模下必须守住；
  现有基准数字：200/2000/5000 条 = 0.13/0.91/2.33 ms。改完请重跑 `tools/bench.ts` 并贴新数字。
- **确定性**：同样输入同样输出（打分、排序、同分兜底）不得依赖 Map/Set 迭代顺序之外的不确定因素；
  同分时按既有 `compareRecords` 兜底。
- **注入预算口径不变**：本任务只改**检索打分与匹配**，不得改注入块结构/token 预算算法。
- **不引入模型调用**：不联网、不调用 LLM、不做嵌入。

## 2. `src/lib.ts` 的新增/改动（签名冻结）

```ts
/** 词形归并：轻量后缀剥离（英文字母序列），不引入词干库；中文与数字原样返回。 */
export function stemToken(token: string): string

/** 检索 token 化：中文 bigram + 单字兜底；英文按空白/标点切分后做 stemToken；数字保留。 */
export function tokenizeForSearch(text: string): string[]

/** 一个检索 token 的权重（idf：越稀有越高），确定性、无随机。 */
export function searchIdf(token: string, records: Iterable<MemoryRecord>): number

/** 命中详情：给 memory_explain 用（哪些 token 命中、各多少分、总分）。 */
export interface MatchDetail {
  tokens: string[]
  matched: string[]
  /** token → 贡献分（已含 idf 与长度归一化）。 */
  scores: Record<string, number>
  /** 最终得分（0..1，便于展示与阈值比较）。 */
  score: number
  /** 是否过了 recallMinMatch 门槛。 */
  passes: boolean
}

/** 单条记录对查询的匹配详情（`query` 为原始查询文本）。 */
export function explainMatch(record: MemoryRecord, query: string, records: Iterable<MemoryRecord>, cfg: MemoryConfig): MatchDetail
```

**既有导出必须保持行为兼容**：`tokenize`（旧名）保留为 `tokenizeForSearch` 的别名或等价实现；
`recallRecords` 的**签名与返回结构不变**（返回 `{ record, score }[]`，score 仍为数字），内部改用新打分。
`matchRate`（若存在）语义若要变，必须在报告里显式说明并保留旧函数供测试对照。

## 3. 评分口径（必须写进代码注释）

- 令 `Q` = 查询 token 集合（`tokenizeForSearch(query)` 去重），`T` = 记录文本 token 集合。
- 命中集合 `H = Q ∩ T`；`score_raw = Σ_{t∈H} idf(t)`；`score_max = Σ_{t∈Q} idf(t)`。
- **长度归一化**：`normalized = score_raw / (score_max * (1 + lengthPenalty * log2(1 + |T| / |Q|)))`，
  其中 `lengthPenalty` 取自配置（见 §4）。
- `score = clamp(normalized, 0, 1)`；`passes = score >= cfg.recallMinMatch`（沿用既有阈值语义）。
  > **集成时裁决（0.5.17）**：`passes` 这条只对 `explainMatch`（逐行询问）成立。
  > `recallRecords` 的**门槛**仍用既有的 `match` / `minLexical`，排序分的相关性项换成上面的新算法 ——
  > 实测新分在真实 R2 查询上约 0.16，若拿它去比 `recallMinMatch` 0.4，召回会整体归零。
  > 也就是「门槛＝相关性判定值、score＝排序分」，`types.ts` 原本就是这么定义的。
- `idf(t) = log(1 + N / (1 + df(t)))`，`N` = 参与检索的记录数，`df(t)` = 含该 token 的记录数。
  **N 与 df 必须是对"本次检索的记录集合"的精确统计**（不是全局近似）；为保证性能，允许在
  `recallRecords` 内部**一次**构建统计表并在本次调用内复用（复杂度 O(N·|T|)）。
- 记录文本参与打分的字段与现状一致（`text` + `subject` + `field` + `value`，若现状如此则不变）。

## 4. 配置（新增，`MemoryConfig` 由 Lead 加）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `searchStemming` | boolean | `true` | 英文轻量词形归并 |
| `searchBigram` | boolean | `true` | 中文 bigram 切分（关掉＝按单字） |
| `searchLengthPenalty` | number | `0.3` | 长度归一化强度（0 = 关闭归一化） |

**默认值必须让既有 273 项测试里的检索相关断言继续成立**（若某条断言与新的合理行为冲突，
**先报告、不要自己改断言**；由 Lead 裁决）。

## 5. 验收标准

- `pnpm typecheck` 四套全绿；`pnpm test` 全绿（现有 **273** 项不许回退）。
- lib 测试新增：`stemToken`（build/building/builds 同族、中文不受影响、数字保留）、
  `tokenizeForSearch`（中文出 bigram、英文出 stem、空串/纯标点安全）、`searchIdf`（稀有 > 常见、确定性）、
  `explainMatch`（命中 token 与分数、`passes` 与阈值一致、长度归一化让"短而精准"胜过长文堆砌）、
  以及开关关闭时的回落行为。
- **效果必须实测**：跑 `node tools/eval-recall.ts`，把改动前后的 Top1 / Top3 / 触发率贴出来对比
  （基线：Top1 90% / Top3 100% / 触发率 50.9%，17 个会话、53 条真实用户消息）。
  若指标**下降**，如实报告并回退到不下降的配置（宁可要诚实的数字，不要好看的假象）。
- **性能必须实测**：跑 `node tools/bench.ts`，贴 200/2000/5000 三条召回耗时。
- `pnpm verify:self-contained` 必须继续通过（零运行期依赖）。
