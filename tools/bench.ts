// bench.ts — 热路径基准：召回（每回合）与常驻渲染（每 step）。
//
// 为什么要测：这两条路径在一次对话里被反复调用（每个 step 渲染一次常驻块，
// 每回合扫描一次全库做召回），而记录数是会随时间增长的。没有数字就没法判断
// 「要不要为它加缓存」——这个脚本就是给它一个可复现的基线。
//
// 用法：node tools/bench.ts [记录数…]      （默认 200 2000 5000）

import { DEFAULTS, findConflicts, makeRecord, pickMergeGroups, recallRecords, renderContextBlock, shouldArchive, workspaceKeyOf } from '../lib/lib.js'
import type { MemoryConfig, MemoryRecord } from '../lib/lib.js'

const cfg: MemoryConfig = { ...DEFAULTS }
const counts = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0)
const sizes = counts.length > 0 ? counts : [200, 2000, 5000]

/** 造一批形状与真实记录一致的样本：中文正文 + 少量标签 + 主题键。 */
function makeStore(size: number): MemoryRecord[] {
  const topics = ['构建流程', '发布流程', '测试策略', '目录结构', '代码风格', '依赖管理', '错误处理', '日志规范']
  const tools = ['pnpm build', 'pnpm publish', 'pnpm test', 'vitest', 'tsc', 'eslint', 'prettier', 'node --test']
  return Array.from({ length: size }, (_, index) => makeRecord({
    kind: index % 3 === 0 ? 'semantic' : index % 3 === 1 ? 'procedural' : 'episodic',
    text: `${topics[index % topics.length]}：这个项目用 ${tools[index % tools.length]} 跑，产物落在 dist/ 目录下（第 ${index} 条）。`,
    subject: `auto.${topics[index % topics.length]}`,
    tags: [tools[index % tools.length].split(' ')[0] ?? 'pnpm'],
    scope: { level: 'workspace', key: workspaceKeyOf('C:/proj/bench') ?? 'bench' },
    importance: 0.3 + (index % 7) * 0.1,
    observedAt: Date.now() - index * 3_600_000,
  }))
}

interface Stat {
  p50: number
  p95: number
}

function measure(runs: number, fn: () => unknown): Stat {
  const samples: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const began = performance.now()
    fn()
    samples.push(performance.now() - began)
  }
  samples.sort((a, b) => a - b)
  const at = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] ?? 0
  return { p50: at(0.5), p95: at(0.95) }
}

/** R2 的语义：用整轮用户消息做记忆侧命中匹配。 */
const longQuery = `${'前置说明。'.repeat(40)}构建流程到底用哪个命令跑？产物在哪个目录？请说明发布流程。`
/** /memory search 的语义：短查询、查询覆盖率。 */
const shortQuery = '构建流程 产物'

const RUNS = 30
const fmt = (value: number): string => `${value.toFixed(2)}ms`

console.log(`记录数    recall(memory)      recall(query)       renderContextBlock    整合路径(合并+冲突+归档)`)
for (const size of sizes) {
  const store = makeStore(size)
  // 预热一次，避免把首次的 JIT/缓存冷启动算进去
  recallRecords(store, { query: longQuery, mode: 'memory' })
  renderContextBlock(store, cfg, workspaceKeyOf('C:/proj/bench'))

  const memory = measure(RUNS, () => recallRecords(store, { query: longQuery, mode: 'memory' }))
  const query = measure(RUNS, () => recallRecords(store, { query: shortQuery }))
  const render = measure(RUNS, () => renderContextBlock(store, cfg, workspaceKeyOf('C:/proj/bench')))
  // 整合是每 30 分钟一次 + 启动时一次：库大了会拖慢启动，所以单独量。
  const consolidation = measure(3, () => {
    pickMergeGroups(store, cfg)
    findConflicts(store)
    for (const record of store) shouldArchive(record, cfg)
  })

  console.log(
    `${String(size).padEnd(8)}  ${fmt(memory.p50).padStart(6)} / ${fmt(memory.p95).padStart(7)}   `
    + `${fmt(query.p50).padStart(6)} / ${fmt(query.p95).padStart(7)}   `
    + `${fmt(render.p50).padStart(6)} / ${fmt(render.p95).padStart(7)}    `
    + `${fmt(consolidation.p50).padStart(6)} / ${fmt(consolidation.p95).padStart(7)}`,
  )
}
console.log('\n格式：p50 / p95。召回与渲染各 ' + RUNS + ' 次，整合路径 3 次（它本来就低频）。')
console.log('R2 的硬预算是 recallBudgetMs = ' + cfg.recallBudgetMs + 'ms。')
